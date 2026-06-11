import { z } from "zod";
import { Hex } from "viem";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { EvmWalletProvider } from "../../wallet-providers";
import { Network } from "../../network";
import {
  ASYNC_SETTLEMENT_NOTE,
  CORE_WRITER_ADDRESS,
  HYPEREVM_MAINNET_CHAIN_ID,
  HYPEREVM_TESTNET_CHAIN_ID,
  PRECOMPILE_MARK_PX,
  PRECOMPILE_ORACLE_PX,
  TIF_ENCODING,
} from "./constants";
import {
  ClosePositionSchema,
  GetMarketsSchema,
  GetPositionsSchema,
  OpenPositionSchema,
} from "./schemas";
import {
  assertAddress,
  assertUintInRange,
  computePosition,
  type ComputedPosition,
  convertPx,
  encodeLimitOrder,
  humanToScaledU64,
  parseCloid,
  readPerpAssetInfo,
  readPerpPosition,
  readPx,
  toEncodedTif,
} from "./utils";

/**
 * HyperliquidActionProvider lets an agent trade Hyperliquid perpetuals from HyperEVM: it reads
 * HyperCore market data and positions via read precompiles, and submits orders via the CoreWriter
 * system contract.
 *
 * CoreWriter writes are asynchronous and non-atomic — a successful EVM transaction does NOT mean an
 * order filled (see README.md). Leverage cannot be set from HyperEVM (no CoreWriter action exists).
 */
export class HyperliquidActionProvider extends ActionProvider<EvmWalletProvider> {
  /**
   * Constructs a new HyperliquidActionProvider.
   */
  constructor() {
    super("hyperliquid", []);
  }

  /**
   * Reads perp market metadata (and optionally prices) for the given HyperCore asset indices.
   *
   * @param walletProvider - The wallet provider (supplies the HyperEVM public client).
   * @param args - The market indices and price flag.
   * @returns A JSON string with the markets, or an error.
   */
  @CreateAction({
    name: "get_markets",
    description: `Read Hyperliquid perp market metadata (and optionally mark/oracle prices) from HyperCore read precompiles.

Inputs:
- indices: REQUIRED array of perp asset indices (uint32), e.g. [0, 1, 2]. Precompiles cannot enumerate all markets; pass the explicit indices you want.
- includePrices: optional (default true) — also fetch mark and oracle prices.

Returns JSON: { success, markets: [{ index, coin, szDecimals, maxLeverage, onlyIsolated, marginTableId, markPx?, oraclePx? }] }.
Prices are start-of-block snapshots. Invalid indices are rejected before any on-chain call.`,
    schema: GetMarketsSchema,
  })
  async getMarkets(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetMarketsSchema>,
  ): Promise<string> {
    try {
      const indices = [...new Set(args.indices)];
      for (const index of indices) {
        assertUintInRange(index, 32, "asset index");
      }

      const client = walletProvider.getPublicClient();
      const markets: Record<string, unknown>[] = [];

      for (const index of indices) {
        const info = await readPerpAssetInfo(client, index);
        const market: Record<string, unknown> = {
          index,
          coin: info.coin,
          szDecimals: info.szDecimals,
          maxLeverage: info.maxLeverage,
          onlyIsolated: info.onlyIsolated,
          marginTableId: info.marginTableId,
        };

        if (args.includePrices) {
          const markPx = await readPx(client, PRECOMPILE_MARK_PX, index);
          const oraclePx = await readPx(client, PRECOMPILE_ORACLE_PX, index);
          market.markPx = convertPx(markPx, info.szDecimals);
          market.oraclePx = convertPx(oraclePx, info.szDecimals);
        }

        markets.push(market);
      }

      return JSON.stringify({ success: true, markets });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error fetching markets: ${error}` });
    }
  }

  /**
   * Reads HyperCore perp positions (with computed unrealized PnL) for a user.
   *
   * @param walletProvider - The wallet provider (supplies the public client and default address).
   * @param args - The optional user address and the perp indices to check.
   * @returns A JSON string with the positions, or an error.
   */
  @CreateAction({
    name: "get_positions",
    description: `Read Hyperliquid perp positions with computed unrealized PnL from HyperCore read precompiles.

Inputs:
- user: optional EVM address (defaults to the agent wallet).
- perpIndices: REQUIRED array of perp asset indices (uint16), e.g. [0, 1].

Returns JSON: { success, user, positions: [{ index, szi, size, isLong, leverage, isIsolated, entryNotional, avgEntryPx, markPx, unrealizedPnl }] }.
Reads are start-of-block snapshots; a position just submitted via open_position may not be visible yet.`,
    schema: GetPositionsSchema,
  })
  async getPositions(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetPositionsSchema>,
  ): Promise<string> {
    try {
      const user = args.user ?? walletProvider.getAddress();
      assertAddress(user, "user");

      const indices = [...new Set(args.perpIndices)];
      for (const index of indices) {
        assertUintInRange(index, 16, "perp index");
      }

      const client = walletProvider.getPublicClient();
      const positions: ComputedPosition[] = [];

      for (const index of indices) {
        const raw = await readPerpPosition(client, user as Hex, index);
        const info = await readPerpAssetInfo(client, index);
        const markPx = await readPx(client, PRECOMPILE_MARK_PX, index);
        positions.push(computePosition(index, raw, markPx, info.szDecimals));
      }

      return JSON.stringify({ success: true, user, positions });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error fetching positions: ${error}` });
    }
  }

  /**
   * Submits a limit order to open or add to a perp position via CoreWriter.
   *
   * @param walletProvider - The wallet provider used to send the CoreWriter transaction.
   * @param args - The order parameters.
   * @returns A JSON string with the submitted status and tx hash, or an error.
   */
  @CreateAction({
    name: "open_position",
    description: `Submit a limit order to open or add to a Hyperliquid perp position via the CoreWriter contract.

Inputs:
- asset: perp asset index (uint32).
- isBuy: true = long, false = short.
- size: order size in base units (human-readable).
- limitPx: limit price (human-readable). For a market-like fill, use an aggressive price plus tif='Ioc'.
- tif: optional 'Ioc' (default) | 'Gtc' | 'Alo'.
- reduceOnly: optional (default false).
- cloid: optional client order id (uint128 string).

IMPORTANT: settlement is ASYNCHRONOUS and NON-ATOMIC. A successful transaction does NOT mean the order filled — CoreWriter queues the action and HyperCore executes it a few seconds later with no revert on failure. The response says "submitted", not "filled"; call get_positions afterwards to confirm. Requires collateral already on the HyperCore perp side.
Returns JSON: { success, status: "submitted", txHash, note }.`,
    schema: OpenPositionSchema,
  })
  async openPosition(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof OpenPositionSchema>,
  ): Promise<string> {
    try {
      assertUintInRange(args.asset, 32, "asset");

      const limitPxU64 = humanToScaledU64(args.limitPx);
      const szU64 = humanToScaledU64(args.size);
      const encodedTif = toEncodedTif(args.tif);
      const cloidU128 = parseCloid(args.cloid);

      const data = encodeLimitOrder(
        args.asset,
        args.isBuy,
        limitPxU64,
        szU64,
        args.reduceOnly,
        encodedTif,
        cloidU128,
      );

      const txHash = await walletProvider.sendTransaction({ to: CORE_WRITER_ADDRESS, data });
      await walletProvider.waitForTransactionReceipt(txHash);

      return JSON.stringify({
        success: true,
        status: "submitted",
        txHash,
        note: ASYNC_SETTLEMENT_NOTE,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error opening position: ${error}` });
    }
  }

  /**
   * Closes (or partially reduces) a perp position via a reduce-only CoreWriter order.
   *
   * @param walletProvider - The wallet provider used to read the position and send the order.
   * @param args - The asset, optional size, slippage bound, and optional cloid.
   * @returns A JSON string with the submitted status and tx hash, or an error.
   */
  @CreateAction({
    name: "close_position",
    description: `Close (or partially reduce) a Hyperliquid perp position via a reduce-only limit order on CoreWriter.

Inputs:
- asset: perp asset index (uint16).
- size: optional amount to close (omit to close the full position).
- slippageBps: optional protective slippage bound in bps (default 500 = 5%), applied to the mark price.
- cloid: optional client order id.

Reads the current position to determine side/size, then submits a reduce-only Ioc order on the opposite side at an aggressive (slippage-bounded) price. Returns an error if there is no open position.
IMPORTANT: settlement is ASYNCHRONOUS and NON-ATOMIC; the response says "submitted", not "filled". The position is read from a start-of-block snapshot and may change before the order settles. Poll get_positions to confirm.
Returns JSON: { success, status: "submitted", txHash, closedSize, side, note }.`,
    schema: ClosePositionSchema,
  })
  async closePosition(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ClosePositionSchema>,
  ): Promise<string> {
    try {
      assertUintInRange(args.asset, 16, "asset");

      const user = walletProvider.getAddress();
      const client = walletProvider.getPublicClient();

      const raw = await readPerpPosition(client, user as Hex, args.asset);
      if (raw.szi === 0n) {
        return JSON.stringify({
          success: false,
          error: `No open position for asset ${args.asset}`,
        });
      }

      const info = await readPerpAssetInfo(client, args.asset);
      const markPxRaw = await readPx(client, PRECOMPILE_MARK_PX, args.asset);
      const markHuman = Number(convertPx(markPxRaw, info.szDecimals));

      const positionIsLong = raw.szi > 0n;
      const isBuy = !positionIsLong; // closing a long sells; closing a short buys
      const positionSize = Math.abs(Number(raw.szi)) / 10 ** info.szDecimals;
      const closeSize = args.size != null ? Math.min(args.size, positionSize) : positionSize;

      const slip = args.slippageBps / 10000;
      const limitPxHuman = isBuy ? markHuman * (1 + slip) : markHuman * (1 - slip);

      const data = encodeLimitOrder(
        args.asset,
        isBuy,
        humanToScaledU64(limitPxHuman),
        humanToScaledU64(closeSize),
        true,
        TIF_ENCODING.Ioc,
        parseCloid(args.cloid),
      );

      const txHash = await walletProvider.sendTransaction({ to: CORE_WRITER_ADDRESS, data });
      await walletProvider.waitForTransactionReceipt(txHash);

      return JSON.stringify({
        success: true,
        status: "submitted",
        txHash,
        closedSize: closeSize.toString(),
        side: isBuy ? "buy" : "sell",
        note: `${ASYNC_SETTLEMENT_NOTE} The position size was read from a start-of-block snapshot and may have changed.`,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error closing position: ${error}` });
    }
  }

  /**
   * Checks whether the network is HyperEVM (chainId 999 mainnet or 998 testnet).
   *
   * @param network - The network to check.
   * @returns True if the network is HyperEVM, false otherwise.
   */
  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" &&
    (network.chainId === HYPEREVM_MAINNET_CHAIN_ID ||
      network.chainId === HYPEREVM_TESTNET_CHAIN_ID);
}

/**
 * Factory for the HyperliquidActionProvider.
 *
 * @returns A new HyperliquidActionProvider instance.
 */
export const hyperliquidActionProvider = () => new HyperliquidActionProvider();
