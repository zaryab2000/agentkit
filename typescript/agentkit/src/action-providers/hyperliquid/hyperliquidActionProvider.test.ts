import { encodeAbiParameters } from "viem";
import { hyperliquidActionProvider } from "./hyperliquidActionProvider";
import { EvmWalletProvider } from "../../wallet-providers";
import {
  CORE_WRITER_ADDRESS,
  LIMIT_ORDER_ACTION_HEADER,
  PERP_ASSET_INFO_RETURN,
  POSITION_RETURN,
  UINT64_RETURN,
} from "./constants";
import { PerpAssetInfo, RawPosition } from "./utils";

const MOCK_ADDRESS = "0x1111111111111111111111111111111111111111";

/**
 * Encodes a PerpAssetInfo struct as a precompile would return it.
 *
 * @param info - the perp asset info fields
 * @returns the abi-encoded return data
 */
function encodePerpAssetInfo(info: PerpAssetInfo) {
  return encodeAbiParameters(PERP_ASSET_INFO_RETURN, [info]);
}

/**
 * Encodes a Position struct as the position precompile would return it.
 *
 * @param pos - the position fields
 * @returns the abi-encoded return data
 */
function encodePosition(pos: RawPosition) {
  return encodeAbiParameters(POSITION_RETURN, [pos]);
}

/**
 * Encodes a uint64 price as a price precompile would return it.
 *
 * @param px - the raw price
 * @returns the abi-encoded return data
 */
function encodePx(px: bigint) {
  return encodeAbiParameters(UINT64_RETURN, [px]);
}

describe("HyperliquidActionProvider", () => {
  const actionProvider = hyperliquidActionProvider();
  let callMock: jest.Mock;
  let mockWallet: jest.Mocked<EvmWalletProvider>;

  beforeEach(() => {
    callMock = jest.fn();
    mockWallet = {
      getAddress: jest.fn().mockReturnValue(MOCK_ADDRESS),
      getNetwork: jest.fn().mockReturnValue({ protocolFamily: "evm", chainId: "999" }),
      getPublicClient: jest.fn().mockReturnValue({ call: callMock }),
      sendTransaction: jest.fn().mockResolvedValue("0xmockhash" as `0x${string}`),
      waitForTransactionReceipt: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<EvmWalletProvider>;
  });

  describe("supportsNetwork", () => {
    it("returns true for HyperEVM mainnet and testnet", () => {
      expect(actionProvider.supportsNetwork({ protocolFamily: "evm", chainId: "999" })).toBe(true);
      expect(actionProvider.supportsNetwork({ protocolFamily: "evm", chainId: "998" })).toBe(true);
    });

    it("returns false for other EVM chains and non-EVM networks", () => {
      expect(actionProvider.supportsNetwork({ protocolFamily: "evm", chainId: "8453" })).toBe(
        false,
      );
      expect(actionProvider.supportsNetwork({ protocolFamily: "evm", chainId: "137" })).toBe(false);
      expect(actionProvider.supportsNetwork({ protocolFamily: "svm", chainId: "999" })).toBe(false);
    });
  });

  describe("get_markets", () => {
    it("returns market metadata and converted prices", async () => {
      // szDecimals=2 => price exponent 6-2=4 => divide raw by 1e4.
      callMock
        .mockResolvedValueOnce({
          data: encodePerpAssetInfo({
            coin: "BTC",
            marginTableId: 1,
            szDecimals: 2,
            maxLeverage: 50,
            onlyIsolated: false,
          }),
        })
        .mockResolvedValueOnce({ data: encodePx(300000n) }) // markPx -> 30
        .mockResolvedValueOnce({ data: encodePx(305000n) }); // oraclePx -> 30.5

      const result = JSON.parse(
        await actionProvider.getMarkets(mockWallet, { indices: [0], includePrices: true }),
      );

      expect(result.success).toBe(true);
      expect(result.markets).toHaveLength(1);
      expect(result.markets[0]).toMatchObject({
        index: 0,
        coin: "BTC",
        szDecimals: 2,
        maxLeverage: 50,
        onlyIsolated: false,
        marginTableId: 1,
        markPx: "30",
        oraclePx: "30.5",
      });
    });

    it("skips prices when includePrices is false", async () => {
      callMock.mockResolvedValueOnce({
        data: encodePerpAssetInfo({
          coin: "ETH",
          marginTableId: 0,
          szDecimals: 3,
          maxLeverage: 25,
          onlyIsolated: false,
        }),
      });

      const result = JSON.parse(
        await actionProvider.getMarkets(mockWallet, { indices: [1], includePrices: false }),
      );

      expect(result.success).toBe(true);
      expect(result.markets[0].markPx).toBeUndefined();
      expect(callMock).toHaveBeenCalledTimes(1);
    });

    it("rejects an out-of-range index without any on-chain call", async () => {
      const result = JSON.parse(
        await actionProvider.getMarkets(mockWallet, {
          indices: [4294967296],
          includePrices: true,
        }),
      );

      expect(result.success).toBe(false);
      expect(callMock).not.toHaveBeenCalled();
    });
  });

  describe("get_positions", () => {
    it("computes size, entry price, and unrealized PnL for a long", async () => {
      // szDecimals=2; szi=150 => size 1.5 long; entryNtl=45_000_000 => 45 USD => avgEntryPx 30;
      // markPx raw 320000 => 32 => uPnL = 1.5*32 - 45 = 3.
      callMock
        .mockResolvedValueOnce({
          data: encodePosition({
            szi: 150n,
            entryNtl: 45_000_000n,
            isolatedRawUsd: 0n,
            leverage: 10,
            isIsolated: false,
          }),
        })
        .mockResolvedValueOnce({
          data: encodePerpAssetInfo({
            coin: "BTC",
            marginTableId: 1,
            szDecimals: 2,
            maxLeverage: 50,
            onlyIsolated: false,
          }),
        })
        .mockResolvedValueOnce({ data: encodePx(320000n) });

      const result = JSON.parse(
        await actionProvider.getPositions(mockWallet, { perpIndices: [0] }),
      );

      expect(result.success).toBe(true);
      expect(result.user).toBe(MOCK_ADDRESS);
      expect(result.positions[0]).toMatchObject({
        index: 0,
        szi: "150",
        size: "1.5",
        isLong: true,
        leverage: 10,
        isIsolated: false,
        entryNotional: "45",
        avgEntryPx: "30",
        markPx: "32",
        unrealizedPnl: "3",
      });
    });

    it("handles a zero (no) position without dividing by zero", async () => {
      callMock
        .mockResolvedValueOnce({
          data: encodePosition({
            szi: 0n,
            entryNtl: 0n,
            isolatedRawUsd: 0n,
            leverage: 0,
            isIsolated: false,
          }),
        })
        .mockResolvedValueOnce({
          data: encodePerpAssetInfo({
            coin: "BTC",
            marginTableId: 1,
            szDecimals: 2,
            maxLeverage: 50,
            onlyIsolated: false,
          }),
        })
        .mockResolvedValueOnce({ data: encodePx(320000n) });

      const result = JSON.parse(
        await actionProvider.getPositions(mockWallet, { perpIndices: [0] }),
      );

      expect(result.positions[0]).toMatchObject({
        szi: "0",
        size: "0",
        isLong: false,
        avgEntryPx: null,
        unrealizedPnl: "0",
      });
    });

    it("uses the provided user address when supplied", async () => {
      const otherUser = "0x2222222222222222222222222222222222222222";
      callMock
        .mockResolvedValueOnce({
          data: encodePosition({
            szi: 0n,
            entryNtl: 0n,
            isolatedRawUsd: 0n,
            leverage: 0,
            isIsolated: false,
          }),
        })
        .mockResolvedValueOnce({
          data: encodePerpAssetInfo({
            coin: "BTC",
            marginTableId: 1,
            szDecimals: 2,
            maxLeverage: 50,
            onlyIsolated: false,
          }),
        })
        .mockResolvedValueOnce({ data: encodePx(320000n) });

      const result = JSON.parse(
        await actionProvider.getPositions(mockWallet, { user: otherUser, perpIndices: [0] }),
      );
      expect(result.user).toBe(otherUser);
    });
  });

  describe("open_position", () => {
    it("submits the exact CoreWriter calldata for a known order", async () => {
      const result = JSON.parse(
        await actionProvider.openPosition(mockWallet, {
          asset: 1,
          isBuy: true,
          size: 1,
          limitPx: 1,
          tif: "Ioc",
          reduceOnly: false,
          cloid: null,
        }),
      );

      // Expected calldata = header (0x01000001) + abi.encode(1, true, 1e8, 1e8, false, 3, 0).
      const expectedData =
        LIMIT_ORDER_ACTION_HEADER +
        encodeAbiParameters(
          [
            { type: "uint32" },
            { type: "bool" },
            { type: "uint64" },
            { type: "uint64" },
            { type: "bool" },
            { type: "uint8" },
            { type: "uint128" },
          ],
          [1, true, 100000000n, 100000000n, false, 3, 0n],
        ).slice(2);

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: CORE_WRITER_ADDRESS,
        data: expectedData,
      });
      // Non-circular anchors: header present and 1e8 (0x05f5e100) scaling appears for px and size.
      const sentData: string = mockWallet.sendTransaction.mock.calls[0][0].data as string;
      expect(sentData.startsWith("0x01000001")).toBe(true);
      expect(sentData.match(/05f5e100/g)).toHaveLength(2);

      expect(result).toMatchObject({ success: true, status: "submitted", txHash: "0xmockhash" });
      expect(result.note).toContain("asynchronous");
    });

    it("never claims the order filled (status stays 'submitted')", async () => {
      const result = JSON.parse(
        await actionProvider.openPosition(mockWallet, {
          asset: 0,
          isBuy: false,
          size: 0.5,
          limitPx: 1000,
          tif: "Ioc",
          reduceOnly: false,
          cloid: null,
        }),
      );
      // The status must never assert a fill; the disclaimer explicitly negates one.
      expect(result.status).toBe("submitted");
      expect(["filled", "executed", "confirmed"]).not.toContain(result.status);
      expect(result.note).toContain("does NOT mean the order filled");
    });

    it("maps tif and cloid correctly", async () => {
      await actionProvider.openPosition(mockWallet, {
        asset: 2,
        isBuy: true,
        size: 3,
        limitPx: 10,
        tif: "Gtc",
        reduceOnly: true,
        cloid: "42",
      });

      const expectedData =
        LIMIT_ORDER_ACTION_HEADER +
        encodeAbiParameters(
          [
            { type: "uint32" },
            { type: "bool" },
            { type: "uint64" },
            { type: "uint64" },
            { type: "bool" },
            { type: "uint8" },
            { type: "uint128" },
          ],
          [2, true, 1000000000n, 300000000n, true, 2, 42n],
        ).slice(2);

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: CORE_WRITER_ADDRESS,
        data: expectedData,
      });
    });

    it("rejects invalid input without sending a transaction", async () => {
      const result = JSON.parse(
        await actionProvider.openPosition(mockWallet, {
          asset: 0,
          isBuy: true,
          size: -1,
          limitPx: 10,
          tif: "Ioc",
          reduceOnly: false,
          cloid: null,
        }),
      );
      expect(result.success).toBe(false);
      expect(mockWallet.sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("close_position", () => {
    it("submits a reduce-only opposite-side order for the full position", async () => {
      // Long 1.5 BTC (szDecimals=2), mark 32. Closing a long => sell, reduceOnly, full size 1.5.
      callMock
        .mockResolvedValueOnce({
          data: encodePosition({
            szi: 150n,
            entryNtl: 45_000_000n,
            isolatedRawUsd: 0n,
            leverage: 10,
            isIsolated: false,
          }),
        })
        .mockResolvedValueOnce({
          data: encodePerpAssetInfo({
            coin: "BTC",
            marginTableId: 1,
            szDecimals: 2,
            maxLeverage: 50,
            onlyIsolated: false,
          }),
        })
        .mockResolvedValueOnce({ data: encodePx(320000n) });

      const result = JSON.parse(
        await actionProvider.closePosition(mockWallet, { asset: 0, slippageBps: 500 }),
      );

      expect(result).toMatchObject({ success: true, status: "submitted", side: "sell" });
      expect(result.closedSize).toBe("1.5");

      // mark 32, sell with 5% slip => limitPx 30.4; size 1.5; reduceOnly true; Ioc(3).
      const expectedData =
        LIMIT_ORDER_ACTION_HEADER +
        encodeAbiParameters(
          [
            { type: "uint32" },
            { type: "bool" },
            { type: "uint64" },
            { type: "uint64" },
            { type: "bool" },
            { type: "uint8" },
            { type: "uint128" },
          ],
          [0, false, 3040000000n, 150000000n, true, 3, 0n],
        ).slice(2);

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: CORE_WRITER_ADDRESS,
        data: expectedData,
      });
    });

    it("returns an error when there is no open position", async () => {
      callMock.mockResolvedValueOnce({
        data: encodePosition({
          szi: 0n,
          entryNtl: 0n,
          isolatedRawUsd: 0n,
          leverage: 0,
          isIsolated: false,
        }),
      });

      const result = JSON.parse(
        await actionProvider.closePosition(mockWallet, { asset: 7, slippageBps: 500 }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("No open position");
      expect(mockWallet.sendTransaction).not.toHaveBeenCalled();
    });
  });
});
