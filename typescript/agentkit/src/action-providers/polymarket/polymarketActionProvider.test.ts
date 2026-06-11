import { polymarketActionProvider } from "./polymarketActionProvider";
import { buildPolyHmacSignature, scaleAmounts } from "./utils";
import { EvmWalletProvider } from "../../wallet-providers";
import {
  CTF_EXCHANGE_V2,
  NEG_RISK_EXCHANGE_V2,
  CONDITIONAL_TOKENS,
  PUSD,
  NEG_RISK_ADAPTER,
} from "./constants";
import { encodeFunctionData } from "viem";
import { CTF_REDEEM_ABI, NEG_RISK_REDEEM_ABI, BYTES32_ZERO } from "./constants";

describe("PolymarketActionProvider", () => {
  const MOCK_ADDRESS = "0xe6b2af36b3bb8d47206a129ff11d5a2de2a63c83";
  const MOCK_CONDITION = `0x${"ab".repeat(32)}` as `0x${string}`;

  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;

  let provider: ReturnType<typeof polymarketActionProvider>;
  let mockWallet: jest.Mocked<EvmWalletProvider>;

  beforeEach(() => {
    jest.resetAllMocks();
    provider = polymarketActionProvider();
    mockWallet = {
      getAddress: jest.fn().mockReturnValue(MOCK_ADDRESS),
      getNetwork: jest.fn().mockReturnValue({ protocolFamily: "evm", chainId: "137" }),
      sendTransaction: jest.fn().mockResolvedValue("0xmockhash"),
      waitForTransactionReceipt: jest.fn().mockResolvedValue({}),
      readContract: jest.fn(),
      signTypedData: jest.fn().mockResolvedValue("0xsignature"),
    } as unknown as jest.Mocked<EvmWalletProvider>;
  });

  describe("supportsNetwork", () => {
    it("returns true for Polygon mainnet", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "137" })).toBe(true);
    });

    it("returns false for Base mainnet", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "8453" })).toBe(false);
    });

    it("returns false for non-evm networks", () => {
      expect(provider.supportsNetwork({ protocolFamily: "svm", chainId: "137" })).toBe(false);
    });
  });

  describe("scaleAmounts", () => {
    it("scales BUY amounts to 6 decimals", () => {
      // price 0.5, size 100 => spend 50 pUSD, receive 100 shares
      expect(scaleAmounts("BUY", 0.5, 100)).toEqual({
        makerAmount: "50000000",
        takerAmount: "100000000",
      });
    });

    it("scales SELL amounts to 6 decimals", () => {
      // price 0.5, size 100 => sell 100 shares, receive 50 pUSD
      expect(scaleAmounts("SELL", 0.5, 100)).toEqual({
        makerAmount: "100000000",
        takerAmount: "50000000",
      });
    });
  });

  describe("buildPolyHmacSignature", () => {
    it("produces a stable url-safe base64 signature (not hex)", () => {
      const secret = Buffer.from("supersecretkey-test").toString("base64url");
      const sig = buildPolyHmacSignature(secret, "1700000000", "POST", "/order", '{"a":1}');
      // url-safe base64 never contains + or /
      expect(sig).not.toMatch(/[+/]/);
      // deterministic for the same inputs
      expect(buildPolyHmacSignature(secret, "1700000000", "POST", "/order", '{"a":1}')).toEqual(
        sig,
      );
    });
  });

  describe("getMarkets", () => {
    it("returns mapped markets", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            question: "Will it rain?",
            conditionId: "0xcond",
            clobTokenIds: '["111","222"]',
            negRisk: false,
          },
        ],
      });

      const result = JSON.parse(await provider.getMarkets({ limit: 20 }));
      expect(result.success).toBe(true);
      expect(result.markets[0].conditionId).toEqual("0xcond");
    });

    it("returns empty message when no markets", async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
      const result = JSON.parse(await provider.getMarkets({ limit: 20 }));
      expect(result.success).toBe(true);
      expect(result.markets).toEqual([]);
    });

    it("returns error string on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
      const result = JSON.parse(await provider.getMarkets({ limit: 20 }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("500");
    });
  });

  describe("getMarket", () => {
    it("merges Gamma metadata with CLOB orderbook data", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { question: "Q", conditionId: "0xcond", clobTokenIds: '["111","222"]' },
          ],
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ bids: [], asks: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ mid: "0.5" }) });

      const result = JSON.parse(await provider.getMarket({ conditionId: "0xcond" }));
      expect(result.success).toBe(true);
      expect(result.market.conditionId).toEqual("0xcond");
      expect(result.orderbook).toEqual({ bids: [], asks: [] });
    });

    it("returns not found when market missing", async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
      const result = JSON.parse(await provider.getMarket({ conditionId: "0xnope" }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("getPositions", () => {
    it("defaults to the wallet address", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ conditionId: "0xcond", size: 10 }],
      });

      const result = JSON.parse(await provider.getPositions(mockWallet, { sizeThreshold: 1 }));
      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toContain(`user=${MOCK_ADDRESS}`);
    });
  });

  describe("placeOrder", () => {
    const setupCreds = () => {
      // derive-api-key succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          apiKey: "key-1",
          secret: Buffer.from("secret-1").toString("base64url"),
          passphrase: "pass-1",
        }),
      });
    };

    it("signs with the standard exchange domain and posts the order", async () => {
      setupCreds();
      mockWallet.readContract.mockResolvedValueOnce(BigInt("1000000000")); // ample allowance
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ orderID: "abc", status: "live" }),
      });

      const result = JSON.parse(
        await provider.placeOrder(mockWallet, {
          tokenId: "111",
          side: "BUY",
          price: 0.5,
          size: 100,
          orderType: "GTC",
          negRisk: false,
        }),
      );

      expect(result.success).toBe(true);
      // signTypedData is called for ClobAuth (creds) first, then the Order.
      const signArg = mockWallet.signTypedData.mock.calls.find(
        c => c[0].primaryType === "Order",
      )![0];
      expect(signArg.domain.verifyingContract).toEqual(CTF_EXCHANGE_V2);
      expect(signArg.primaryType).toEqual("Order");
      expect(signArg.message.signatureType).toEqual(0);
      expect(signArg.message.makerAmount).toEqual("50000000");
      expect(signArg.message.takerAmount).toEqual("100000000");

      // L2 headers present on the order POST
      const postCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith("/order"));
      expect(postCall?.[1].headers.POLY_API_KEY).toEqual("key-1");
      expect(postCall?.[1].headers.POLY_SIGNATURE).toBeDefined();
      const body = JSON.parse(postCall?.[1].body);
      expect(body.order.side).toEqual("BUY");
      expect(body.orderType).toEqual("GTC");
    });

    it("selects the neg-risk domain when negRisk is true", async () => {
      setupCreds();
      mockWallet.readContract.mockResolvedValueOnce(BigInt("1000000000"));
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ orderID: "abc" }) });

      await provider.placeOrder(mockWallet, {
        tokenId: "111",
        side: "BUY",
        price: 0.5,
        size: 100,
        orderType: "GTC",
        negRisk: true,
      });

      const signArg = mockWallet.signTypedData.mock.calls.find(
        c => c[0].primaryType === "Order",
      )![0];
      expect(signArg.domain.verifyingContract).toEqual(NEG_RISK_EXCHANGE_V2);
    });

    it("sends an approval transaction when allowance is insufficient", async () => {
      setupCreds();
      mockWallet.readContract.mockResolvedValueOnce(BigInt(0)); // no allowance
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ orderID: "abc" }) });

      await provider.placeOrder(mockWallet, {
        tokenId: "111",
        side: "BUY",
        price: 0.5,
        size: 100,
        orderType: "GTC",
        negRisk: false,
      });

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: PUSD }),
      );
    });

    it("returns an error string when the order is rejected", async () => {
      setupCreds();
      mockWallet.readContract.mockResolvedValueOnce(BigInt("1000000000"));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid order" }),
      });

      const result = JSON.parse(
        await provider.placeOrder(mockWallet, {
          tokenId: "111",
          side: "BUY",
          price: 0.5,
          size: 100,
          orderType: "GTC",
          negRisk: false,
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("400");
    });
  });

  describe("redeemWinnings", () => {
    it("encodes a standard CTF redeemPositions call", async () => {
      const result = JSON.parse(
        await provider.redeemWinnings(mockWallet, {
          conditionId: MOCK_CONDITION,
          negRisk: false,
          indexSets: [1, 2],
        }),
      );

      expect(result.success).toBe(true);
      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: CONDITIONAL_TOKENS,
        data: encodeFunctionData({
          abi: CTF_REDEEM_ABI,
          functionName: "redeemPositions",
          args: [PUSD, BYTES32_ZERO, MOCK_CONDITION, [1n, 2n]],
        }),
      });
    });

    it("targets the NegRiskAdapter for neg-risk markets", async () => {
      await provider.redeemWinnings(mockWallet, {
        conditionId: MOCK_CONDITION,
        negRisk: true,
        indexSets: [1, 2],
      });

      expect(mockWallet.sendTransaction).toHaveBeenCalledWith({
        to: NEG_RISK_ADAPTER,
        data: encodeFunctionData({
          abi: NEG_RISK_REDEEM_ABI,
          functionName: "redeemPositions",
          args: [MOCK_CONDITION, [1n, 2n]],
        }),
      });
    });

    it("returns an error string when the transaction reverts", async () => {
      mockWallet.sendTransaction.mockRejectedValueOnce(new Error("execution reverted"));
      const result = JSON.parse(
        await provider.redeemWinnings(mockWallet, {
          conditionId: MOCK_CONDITION,
          negRisk: false,
          indexSets: [1, 2],
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("reverted");
    });
  });
});
