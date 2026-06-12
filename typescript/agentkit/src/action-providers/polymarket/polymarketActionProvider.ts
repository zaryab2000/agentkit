import { z } from "zod";
import { encodeFunctionData, Hex } from "viem";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { EvmWalletProvider } from "../../wallet-providers";
import { Network } from "../../network";
import {
  GetMarketsSchema,
  GetMarketSchema,
  PlaceOrderSchema,
  GetPositionsSchema,
  RedeemWinningsSchema,
} from "./schemas";
import {
  BYTES32_ZERO,
  CLOB_API_URL,
  CONDITIONAL_TOKENS,
  CTF_EXCHANGE_V2,
  CTF_REDEEM_ABI,
  DATA_API_URL,
  ERC1155_ABI,
  ERC20_ABI,
  EXCHANGE_DOMAIN,
  GAMMA_API_URL,
  NEG_RISK_ADAPTER,
  NEG_RISK_EXCHANGE_DOMAIN,
  NEG_RISK_EXCHANGE_V2,
  NEG_RISK_REDEEM_ABI,
  ORDER_SIDE,
  ORDER_TYPES,
  POLYGON_CHAIN_ID,
  PUSD,
  SIGNATURE_TYPE_EOA,
} from "./constants";
import {
  ApiCreds,
  buildL2Headers,
  buildQuery,
  deriveApiCreds,
  generateOrderSalt,
  httpGetJson,
  scaleAmounts,
} from "./utils";

/**
 * PolymarketActionProvider provides actions for trading on Polymarket's
 * prediction-market CLOB (CTF Exchange V2 + pUSD) on Polygon mainnet.
 */
export class PolymarketActionProvider extends ActionProvider<EvmWalletProvider> {
  #creds?: ApiCreds;

  /**
   * Constructs a new PolymarketActionProvider.
   */
  constructor() {
    super("polymarket", []);
  }

  /**
   * Discovers Polymarket prediction markets via the Gamma API.
   *
   * @param args - The market discovery filters.
   * @returns A JSON string of matching markets.
   */
  @CreateAction({
    name: "get_markets",
    description: `
This tool discovers Polymarket prediction markets via the public Gamma API.

It takes the following inputs:
- limit: (Optional) Max number of markets to return (default 20)
- active: (Optional) If true, only return markets currently open for trading
- order: (Optional) Field to sort by, e.g. "volume24hr" or "liquidity"
- ascending: (Optional) Sort direction
- tagSlug: (Optional) Category filter, e.g. "politics", "crypto"

It returns a JSON list of markets including question, conditionId, clobTokenIds,
outcomes, outcomePrices, liquidity, volume, and whether it is a negative-risk market.
Use the clobTokenIds and conditionId from this action as inputs to get_market,
place_order, and redeem_winnings.
`,
    schema: GetMarketsSchema,
  })
  async getMarkets(args: z.infer<typeof GetMarketsSchema>): Promise<string> {
    try {
      const query = buildQuery({
        limit: args.limit,
        active: args.active,
        order: args.order,
        ascending: args.ascending,
        tag_slug: args.tagSlug,
      });
      const data = (await httpGetJson(`${GAMMA_API_URL}/markets${query}`)) as unknown[];

      if (!Array.isArray(data) || data.length === 0) {
        return JSON.stringify({ success: true, markets: [], message: "No markets found" });
      }

      const markets = data.map(m => {
        const market = m as Record<string, unknown>;
        return {
          question: market.question,
          conditionId: market.conditionId,
          clobTokenIds: market.clobTokenIds,
          outcomes: market.outcomes,
          outcomePrices: market.outcomePrices,
          liquidityNum: market.liquidityNum,
          volumeNum: market.volumeNum,
          negRisk: market.negRisk,
          active: market.active,
          closed: market.closed,
        };
      });

      return JSON.stringify({ success: true, markets });
    } catch (error) {
      return JSON.stringify({ success: false, error: `${error}` });
    }
  }

  /**
   * Fetches a single market with live odds and liquidity, merging Gamma
   * metadata with CLOB orderbook data.
   *
   * @param args - The market identifier (conditionId, tokenId, or slug).
   * @returns A JSON string of the merged market data.
   */
  @CreateAction({
    name: "get_market",
    description: `
This tool fetches a single Polymarket market with live odds and liquidity.

It takes the following inputs (provide at least one):
- conditionId: The market conditionId (0x-prefixed hex)
- tokenId: A CLOB outcome tokenId belonging to the market
- slug: The market slug

It merges Gamma metadata with live CLOB orderbook data and returns the best bid,
best ask, spread, midpoint, tick size, and the outcome token ids. If you only have
a market slug or question, call this action first to obtain the tokenId before
calling place_order.
`,
    schema: GetMarketSchema,
  })
  async getMarket(args: z.infer<typeof GetMarketSchema>): Promise<string> {
    try {
      // Resolve the market metadata from Gamma.
      let market: Record<string, unknown> | undefined;
      if (args.conditionId) {
        const list = (await httpGetJson(
          `${GAMMA_API_URL}/markets${buildQuery({ condition_ids: args.conditionId })}`,
        )) as unknown[];
        market = (Array.isArray(list) ? list[0] : list) as Record<string, unknown>;
      } else if (args.slug) {
        const list = (await httpGetJson(
          `${GAMMA_API_URL}/markets${buildQuery({ slug: args.slug })}`,
        )) as unknown[];
        market = (Array.isArray(list) ? list[0] : undefined) as Record<string, unknown>;
      } else if (args.tokenId) {
        const list = (await httpGetJson(
          `${GAMMA_API_URL}/markets${buildQuery({ clob_token_ids: args.tokenId })}`,
        )) as unknown[];
        market = (Array.isArray(list) ? list[0] : undefined) as Record<string, unknown>;
      }

      if (!market) {
        return JSON.stringify({ success: false, error: "Market not found" });
      }

      // Determine a tokenId for the orderbook lookup.
      let tokenId = args.tokenId;
      if (!tokenId && market.clobTokenIds) {
        try {
          const ids = JSON.parse(market.clobTokenIds as string);
          tokenId = Array.isArray(ids) ? ids[0] : undefined;
        } catch {
          // clobTokenIds may already be an array
          if (Array.isArray(market.clobTokenIds)) {
            tokenId = (market.clobTokenIds as string[])[0];
          }
        }
      }

      // Merge live CLOB data when a tokenId is available.
      let book: unknown;
      let midpoint: unknown;
      if (tokenId) {
        const tokenQuery = buildQuery({ token_id: tokenId });
        [book, midpoint] = await Promise.all([
          httpGetJson(`${CLOB_API_URL}/book${tokenQuery}`).catch(() => undefined),
          httpGetJson(`${CLOB_API_URL}/midpoint${tokenQuery}`).catch(() => undefined),
        ]);
      }

      return JSON.stringify({
        success: true,
        market: {
          question: market.question,
          conditionId: market.conditionId,
          clobTokenIds: market.clobTokenIds,
          outcomes: market.outcomes,
          outcomePrices: market.outcomePrices,
          bestBid: market.bestBid,
          bestAsk: market.bestAsk,
          spread: market.spread,
          tickSize: market.orderPriceMinTickSize,
          negRisk: market.negRisk,
          active: market.active,
          closed: market.closed,
        },
        orderbook: book,
        midpoint,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `${error}` });
    }
  }

  /**
   * Signs and places an order on the Polymarket CLOB.
   *
   * @param walletProvider - The wallet provider used to sign and authenticate.
   * @param args - The order parameters.
   * @returns A JSON string with the order id and status.
   */
  @CreateAction({
    name: "place_order",
    description: `
This tool signs and places a buy or sell order on the Polymarket CLOB (V2).

It takes the following inputs:
- tokenId: The CLOB outcome tokenId to trade (get it from get_market / get_markets)
- side: "BUY" or "SELL"
- price: Limit price per share between 0 and 1 (e.g. 0.62 = 62 cents)
- size: Number of outcome shares to trade
- orderType: (Optional) "GTC" (default), "GTD", "FOK", or "FAK"
- negRisk: (Optional) Set true for negative-risk markets (see get_market)

Important notes:
- Collateral is pUSD (6 decimals); ensure the wallet holds enough pUSD before buying.
- This action derives API credentials, checks/sets token allowances, signs the order
  via EIP-712, and submits it. Errors (insufficient balance/allowance, tick size, wrong
  network) are returned as a message rather than thrown.
`,
    schema: PlaceOrderSchema,
  })
  async placeOrder(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof PlaceOrderSchema>,
  ): Promise<string> {
    try {
      // Ensure API credentials.
      if (!this.#creds) {
        this.#creds = await deriveApiCreds(walletProvider);
      }

      // Allowance preflight for the correct exchange.
      const exchange = args.negRisk ? NEG_RISK_EXCHANGE_V2 : CTF_EXCHANGE_V2;
      const { makerAmount, takerAmount } = scaleAmounts(args.side, args.price, args.size);
      await this.ensureAllowances(walletProvider, args.side, exchange, BigInt(makerAmount));

      // Build the signed order struct.
      const maker = walletProvider.getAddress();
      const salt = generateOrderSalt();
      const timestamp = Date.now().toString();
      const message = {
        salt,
        maker,
        signer: maker,
        tokenId: args.tokenId,
        makerAmount,
        takerAmount,
        side: ORDER_SIDE[args.side],
        signatureType: SIGNATURE_TYPE_EOA,
        timestamp,
        metadata: BYTES32_ZERO,
        builder: BYTES32_ZERO,
      };

      const domain = args.negRisk ? NEG_RISK_EXCHANGE_DOMAIN : EXCHANGE_DOMAIN;
      const signature = await walletProvider.signTypedData({
        domain,
        types: ORDER_TYPES,
        primaryType: "Order",
        message,
      });

      // Re-serialize for the POST body (string side, signature attached).
      const orderBody = {
        order: {
          salt,
          maker,
          signer: maker,
          tokenId: args.tokenId,
          makerAmount,
          takerAmount,
          side: args.side,
          signatureType: SIGNATURE_TYPE_EOA,
          timestamp,
          metadata: BYTES32_ZERO,
          builder: BYTES32_ZERO,
          signature,
        },
        owner: this.#creds.apiKey,
        orderType: args.orderType,
      };
      const body = JSON.stringify(orderBody);

      const headers = buildL2Headers(walletProvider, this.#creds, "POST", "/order", body);
      const response = await fetch(`${CLOB_API_URL}/order`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      });

      const result = await response.json();
      if (!response.ok) {
        return JSON.stringify({
          success: false,
          error: `Order rejected (status ${response.status})`,
          details: result,
        });
      }

      return JSON.stringify({ success: true, order: result });
    } catch (error) {
      return JSON.stringify({ success: false, error: `${error}` });
    }
  }

  /**
   * Reads a wallet's Polymarket positions via the Data API.
   *
   * @param walletProvider - The wallet provider (for the default address).
   * @param args - The positions query.
   * @returns A JSON string of positions.
   */
  @CreateAction({
    name: "get_positions",
    description: `
This tool reads Polymarket positions for a wallet via the public Data API.

It takes the following inputs:
- user: (Optional) Wallet address to read positions for. Defaults to the connected wallet.
- sizeThreshold: (Optional) Minimum position size to include (default 1)

It returns each position's tokenId, conditionId, size, average price, current price,
title, outcome, and whether it is redeemable. Positions flagged redeemable can be
redeemed with redeem_winnings.
`,
    schema: GetPositionsSchema,
  })
  async getPositions(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetPositionsSchema>,
  ): Promise<string> {
    try {
      const user = args.user || walletProvider.getAddress();
      const query = buildQuery({ user, sizeThreshold: args.sizeThreshold });
      const data = (await httpGetJson(`${DATA_API_URL}/positions${query}`)) as unknown[];

      if (!Array.isArray(data) || data.length === 0) {
        return JSON.stringify({ success: true, positions: [], message: "No positions found" });
      }

      return JSON.stringify({ success: true, positions: data });
    } catch (error) {
      return JSON.stringify({ success: false, error: `${error}` });
    }
  }

  /**
   * Redeems winnings from a resolved market on-chain.
   *
   * @param walletProvider - The wallet provider used to send the transaction.
   * @param args - The redemption parameters.
   * @returns A JSON string with the transaction hash.
   */
  @CreateAction({
    name: "redeem_winnings",
    description: `
This tool redeems winnings from a resolved Polymarket market on-chain (Polygon).

It takes the following inputs:
- conditionId: The conditionId (0x-prefixed hex) of the resolved market
- negRisk: (Optional) Set true for negative-risk markets (uses the NegRiskAdapter)
- indexSets: (Optional) Outcome index sets to redeem (default [1, 2] for binary markets)

Important notes:
- The market must be resolved; redeeming an unresolved market will revert. Use
  get_positions to confirm a position is redeemable first.
- Returns the transaction hash on success.
`,
    schema: RedeemWinningsSchema,
  })
  async redeemWinnings(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof RedeemWinningsSchema>,
  ): Promise<string> {
    try {
      const conditionId = args.conditionId as Hex;
      const indexSets = args.indexSets.map(i => BigInt(i));

      let to: string;
      let data: Hex;
      if (args.negRisk) {
        to = NEG_RISK_ADAPTER;
        data = encodeFunctionData({
          abi: NEG_RISK_REDEEM_ABI,
          functionName: "redeemPositions",
          args: [conditionId, indexSets],
        });
      } else {
        to = CONDITIONAL_TOKENS;
        data = encodeFunctionData({
          abi: CTF_REDEEM_ABI,
          functionName: "redeemPositions",
          args: [PUSD as Hex, BYTES32_ZERO as Hex, conditionId, indexSets],
        });
      }

      const hash = await walletProvider.sendTransaction({ to: to as Hex, data });
      await walletProvider.waitForTransactionReceipt(hash);

      return JSON.stringify({ success: true, txHash: hash, conditionId: args.conditionId });
    } catch (error) {
      return JSON.stringify({ success: false, error: `${error}` });
    }
  }

  /**
   * Checks if the Polymarket action provider supports the given network.
   *
   * @param network - The network to check.
   * @returns True only for Polygon mainnet (EVM, chainId 137).
   */
  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.chainId === POLYGON_CHAIN_ID;

  /**
   * Ensures the exchange has the allowances needed to fill an order, sending
   * approval transactions only when missing.
   *
   * @param walletProvider - The wallet provider.
   * @param side - The order side.
   * @param exchange - The exchange address that must be approved.
   * @param makerAmount - The pUSD amount required for a BUY (6-decimal).
   */
  private async ensureAllowances(
    walletProvider: EvmWalletProvider,
    side: "BUY" | "SELL",
    exchange: string,
    makerAmount: bigint,
  ): Promise<void> {
    const owner = walletProvider.getAddress();

    if (side === "BUY") {
      const allowance = (await walletProvider.readContract({
        address: PUSD as Hex,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner as Hex, exchange as Hex],
      })) as bigint;

      if (allowance < makerAmount) {
        const data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [exchange as Hex, makerAmount],
        });
        const hash = await walletProvider.sendTransaction({ to: PUSD as Hex, data });
        await walletProvider.waitForTransactionReceipt(hash);
      }
    } else {
      const approved = (await walletProvider.readContract({
        address: CONDITIONAL_TOKENS as Hex,
        abi: ERC1155_ABI,
        functionName: "isApprovedForAll",
        args: [owner as Hex, exchange as Hex],
      })) as boolean;

      if (!approved) {
        const data = encodeFunctionData({
          abi: ERC1155_ABI,
          functionName: "setApprovalForAll",
          args: [exchange as Hex, true],
        });
        const hash = await walletProvider.sendTransaction({ to: CONDITIONAL_TOKENS as Hex, data });
        await walletProvider.waitForTransactionReceipt(hash);
      }
    }
  }
}

export const polymarketActionProvider = () => new PolymarketActionProvider();
