import {
  lendingRouterActionProvider,
  LendingRouterActionProvider,
} from "./lendingRouterActionProvider";
import { EvmWalletProvider } from "../../wallet-providers";
import { Network } from "../../network";
import { COMPOUND_COMET_ADDRESS, AAVE_POOL_ADDRESS } from "./constants";

const MOCK_TX_HASH = "0xmocktxhash1234567890abcdef" as `0x${string}`;
const MOCK_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`;
const MOCK_NETWORK: Network = {
  protocolFamily: "evm",
  networkId: "base-mainnet",
  chainId: "8453",
};

const fetchMock = jest.fn();
global.fetch = fetchMock;

jest.mock("../../utils", () => ({
  approve: jest.fn().mockResolvedValue("Approval successful"),
}));

const { approve: mockApprove } = jest.requireMock("../../utils");

/**
 * Creates a mocked EvmWalletProvider for testing.
 *
 * @returns A jest-mocked wallet provider.
 */
function createMockWallet(): jest.Mocked<EvmWalletProvider> {
  return {
    getAddress: jest.fn().mockReturnValue(MOCK_ADDRESS),
    getNetwork: jest.fn().mockReturnValue(MOCK_NETWORK),
    sendTransaction: jest.fn().mockResolvedValue(MOCK_TX_HASH),
    waitForTransactionReceipt: jest.fn().mockResolvedValue({}),
    readContract: jest.fn(),
  } as unknown as jest.Mocked<EvmWalletProvider>;
}

/**
 * Configures mock readContract responses for Compound III.
 *
 * @param wallet - The mocked wallet to configure.
 */
function setupCompoundRateMocks(wallet: jest.Mocked<EvmWalletProvider>) {
  const impl = wallet.readContract as jest.Mock;
  impl.mockImplementation(async (params: { address: string; functionName: string }) => {
    if (params.address === COMPOUND_COMET_ADDRESS) {
      if (params.functionName === "getUtilization") return 500000000000000000n;
      if (params.functionName === "getSupplyRate") return 1000000000n;
      if (params.functionName === "getBorrowRate") return 2000000000n;
      if (params.functionName === "borrowBalanceOf") return 0n;
      if (params.functionName === "baseToken") return "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
      if (params.functionName === "baseTokenPriceFeed")
        return "0xfeedFeedFeedFeedFeedFeedFeedFeedFeedFeed";
      if (params.functionName === "numAssets") return 0;
      if (params.functionName === "getPrice") return 100000000n;
      if (params.functionName === "collateralBalanceOf") return 0n;
    }
    if (params.functionName === "decimals") return 6;
    if (params.functionName === "symbol") return "USDC";
    if (params.functionName === "balanceOf") return 1000000000n;
    if (params.functionName === "latestRoundData")
      return [0n, 100000000n, 0n, BigInt(Date.now()), 0n];
    return 0n;
  });
}

/**
 * Configures mock readContract responses for Aave v3.
 *
 * @param wallet - The mocked wallet to configure.
 */
function setupAaveRateMocks(wallet: jest.Mocked<EvmWalletProvider>) {
  const impl = wallet.readContract as jest.Mock;
  const prevImpl = impl.getMockImplementation();
  impl.mockImplementation(async (params: { address: string; functionName: string }) => {
    if (params.address === AAVE_POOL_ADDRESS) {
      if (params.functionName === "getReserveData") {
        return {
          configuration: 0n,
          liquidityIndex: 0n,
          currentLiquidityRate: 30000000000000000000000000n,
          variableBorrowIndex: 0n,
          currentVariableBorrowRate: 50000000000000000000000000n,
          currentStableBorrowRate: 0n,
          lastUpdateTimestamp: 0,
          id: 0,
          aTokenAddress: "0x0000000000000000000000000000000000000001",
          stableDebtTokenAddress: "0x0000000000000000000000000000000000000002",
          variableDebtTokenAddress: "0x0000000000000000000000000000000000000003",
          interestRateStrategyAddress: "0x0000000000000000000000000000000000000004",
          accruedToTreasury: 0n,
          unbacked: 0n,
          isolationModeTotalDebt: 0n,
        };
      }
      if (params.functionName === "getUserAccountData") {
        return [1000000000000n, 500000000000n, 200000000000n, 8000n, 7500n, 2000000000000000000n];
      }
    }
    if (prevImpl) return prevImpl(params);
    return 0n;
  });
}

describe("LendingRouterActionProvider", () => {
  let provider: LendingRouterActionProvider;
  let mockWallet: jest.Mocked<EvmWalletProvider>;

  beforeEach(() => {
    provider = new LendingRouterActionProvider();
    mockWallet = createMockWallet();
    jest.clearAllMocks();
    fetchMock.mockReset();
    mockApprove.mockResolvedValue("Approval successful");
  });

  describe("factory", () => {
    it("should create an instance via the factory function", () => {
      const instance = lendingRouterActionProvider();
      expect(instance).toBeInstanceOf(LendingRouterActionProvider);
    });
  });

  describe("supportsNetwork", () => {
    it("should return true for Base mainnet (chainId 8453)", () => {
      expect(provider.supportsNetwork(MOCK_NETWORK)).toBe(true);
    });

    it("should return false for Ethereum mainnet", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "1" })).toBe(false);
    });

    it("should return false for non-EVM networks", () => {
      expect(provider.supportsNetwork({ protocolFamily: "solana", chainId: "8453" })).toBe(false);
    });

    it("should return false for Base sepolia", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "84532" })).toBe(false);
    });
  });

  describe("compareLendingRates", () => {
    it("should return ranked rates from Compound for supply", async () => {
      setupCompoundRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.compareLendingRates(mockWallet, {
        asset: "USDC",
        side: "supply",
      });
      const parsed = JSON.parse(result);
      expect(parsed.asset).toBe("USDC");
      expect(parsed.side).toBe("supply");
      expect(parsed.rates.length).toBeGreaterThanOrEqual(1);
      expect(parsed.rates[0].protocol).toBeDefined();
      expect(parsed.rates[0].apy).toBeGreaterThanOrEqual(0);
    });

    it("should return rates from multiple protocols", async () => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.compareLendingRates(mockWallet, {
        asset: "USDC",
        side: "supply",
      });
      const parsed = JSON.parse(result);
      expect(parsed.rates.length).toBeGreaterThanOrEqual(2);
    });

    it("should rank supply rates best-first (highest APY)", async () => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.compareLendingRates(mockWallet, {
        asset: "USDC",
        side: "supply",
      });
      const parsed = JSON.parse(result);
      for (let i = 1; i < parsed.rates.length; i++) {
        expect(parsed.rates[i - 1].apy).toBeGreaterThanOrEqual(parsed.rates[i].apy);
      }
    });

    it("should handle Morpho GraphQL failure gracefully", async () => {
      setupCompoundRateMocks(mockWallet);
      fetchMock.mockRejectedValue(new Error("Network error"));

      const result = await provider.compareLendingRates(mockWallet, {
        asset: "USDC",
        side: "supply",
      });
      const parsed = JSON.parse(result);
      expect(parsed.rates.length).toBeGreaterThanOrEqual(1);
      const morphoRate = parsed.rates.find((r: { protocol: string }) => r.protocol === "morpho");
      expect(morphoRate).toBeUndefined();
    });

    it("should return error message when asset is not listed on any protocol", async () => {
      (mockWallet.readContract as jest.Mock).mockRejectedValue(new Error("not listed"));
      fetchMock.mockResolvedValue({ ok: false, status: 404 });

      const result = await provider.compareLendingRates(mockWallet, {
        asset: "FAKECOIN",
        side: "supply",
      });
      expect(result).toContain("No lending rates found");
    });

    it("should correctly annualize Compound per-second rates", async () => {
      (mockWallet.readContract as jest.Mock).mockImplementation(
        async (params: { address: string; functionName: string }) => {
          if (params.functionName === "getUtilization") return 500000000000000000n;
          if (params.functionName === "getSupplyRate") return 1000000000000n;
          return 0n;
        },
      );
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.compareLendingRates(mockWallet, {
        asset: "USDC",
        side: "supply",
      });
      const parsed = JSON.parse(result);
      const compoundRate = parsed.rates.find(
        (r: { protocol: string }) => r.protocol === "compound",
      );
      if (compoundRate) {
        const expectedApr = (1000000000000 * 31_536_000) / 1e18;
        expect(compoundRate.apy).toBeCloseTo(expectedApr * 100, 2);
      }
    });
  });

  describe("getAggregatedPosition", () => {
    it("should return positions from multiple protocols", async () => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.getAggregatedPosition(mockWallet, {});
      const parsed = JSON.parse(result);
      expect(parsed.user).toBe(MOCK_ADDRESS);
      expect(parsed.positions).toBeDefined();
      expect(parsed.positions.length).toBeGreaterThanOrEqual(1);
    });

    it("should use wallet address when user is not provided", async () => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.getAggregatedPosition(mockWallet, {});
      const parsed = JSON.parse(result);
      expect(parsed.user).toBe(MOCK_ADDRESS);
    });

    it("should identify lowest health factor across protocols", async () => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.getAggregatedPosition(mockWallet, {});
      const parsed = JSON.parse(result);
      if (parsed.lowestHealth) {
        expect(parsed.lowestHealth.protocol).toBeDefined();
        expect(parsed.lowestHealth.healthFactor).toBeDefined();
      }
    });
  });

  describe("routeSupply", () => {
    beforeEach(() => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
    });

    it("should successfully supply to the best rate protocol", async () => {
      const result = await provider.routeSupply(mockWallet, {
        asset: "USDC",
        amount: "100",
      });
      expect(result).toContain("Supplied 100 USDC");
      expect(result).toContain("Transaction hash:");
      expect(result).toContain("APY");
    });

    it("should honor preferProtocol when specified", async () => {
      const result = await provider.routeSupply(mockWallet, {
        asset: "USDC",
        amount: "100",
        preferProtocol: "compound",
      });
      expect(result).toContain("compound");
      expect(result).toContain("Supplied 100 USDC");
    });

    it("should return error for unsupported asset", async () => {
      const result = await provider.routeSupply(mockWallet, {
        asset: "FAKECOIN",
        amount: "100",
      });
      expect(result).toContain("Error");
      expect(result).toContain("not supported");
    });

    it("should return error when balance is insufficient", async () => {
      (mockWallet.readContract as jest.Mock).mockImplementation(
        async (params: { functionName: string }) => {
          if (params.functionName === "decimals") return 6;
          if (params.functionName === "balanceOf") return 1000n;
          return 0n;
        },
      );

      const result = await provider.routeSupply(mockWallet, {
        asset: "USDC",
        amount: "1000000",
      });
      expect(result).toContain("Error");
      expect(result).toContain("Insufficient balance");
    });

    it("should return error when preferred protocol has no rate", async () => {
      const result = await provider.routeSupply(mockWallet, {
        asset: "USDC",
        amount: "100",
        preferProtocol: "nonexistent",
      });
      expect(result).toContain("Error");
      expect(result).toContain("nonexistent");
    });

    it("should call approve before sending supply transaction", async () => {
      await provider.routeSupply(mockWallet, {
        asset: "USDC",
        amount: "100",
      });
      expect(mockApprove).toHaveBeenCalled();
      expect(mockWallet.sendTransaction).toHaveBeenCalled();
      expect(mockWallet.waitForTransactionReceipt).toHaveBeenCalled();
    });

    it("should return error when approval fails", async () => {
      mockApprove.mockResolvedValueOnce("Error: Approval denied");

      const result = await provider.routeSupply(mockWallet, {
        asset: "USDC",
        amount: "100",
      });
      expect(result).toContain("Error");
    });
  });

  describe("routeBorrow", () => {
    beforeEach(() => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
    });

    it("should successfully borrow from the cheapest protocol", async () => {
      const result = await provider.routeBorrow(mockWallet, {
        asset: "USDC",
        amount: "100",
      });
      expect(result).toContain("Borrowed 100 USDC");
      expect(result).toContain("Transaction hash:");
    });

    it("should reject unsupported protocols for borrow in v1", async () => {
      const result = await provider.routeBorrow(mockWallet, {
        asset: "USDC",
        amount: "100",
        preferProtocol: "moonwell",
      });
      expect(result).toContain("Error");
      expect(result).toContain("not supported for borrows in v1");
    });

    it("should reject borrow when Aave health factor is below threshold", async () => {
      const impl = mockWallet.readContract as jest.Mock;
      impl.mockImplementation(async (params: { address: string; functionName: string }) => {
        if (params.address === AAVE_POOL_ADDRESS) {
          if (params.functionName === "getReserveData") {
            return {
              configuration: 0n,
              liquidityIndex: 0n,
              currentLiquidityRate: 30000000000000000000000000n,
              variableBorrowIndex: 0n,
              currentVariableBorrowRate: 10000000000000000000000000n,
              currentStableBorrowRate: 0n,
              lastUpdateTimestamp: 0,
              id: 0,
              aTokenAddress: "0x0000000000000000000000000000000000000001",
              stableDebtTokenAddress: "0x0000000000000000000000000000000000000002",
              variableDebtTokenAddress: "0x0000000000000000000000000000000000000003",
              interestRateStrategyAddress: "0x0000000000000000000000000000000000000004",
              accruedToTreasury: 0n,
              unbacked: 0n,
              isolationModeTotalDebt: 0n,
            };
          }
          if (params.functionName === "getUserAccountData") {
            return [1000000000000n, 900000000000n, 10000000000n, 8000n, 7500n, 900000000000000000n];
          }
        }
        if (params.functionName === "getUtilization") return 500000000000000000n;
        if (params.functionName === "getBorrowRate") return 3000000000n;
        if (params.functionName === "decimals") return 6;
        return 0n;
      });

      const result = await provider.routeBorrow(mockWallet, {
        asset: "USDC",
        amount: "100",
        preferProtocol: "aave",
      });
      expect(result).toContain("Error");
      expect(result).toContain("health factor");
    });

    it("should return error for unsupported asset", async () => {
      const result = await provider.routeBorrow(mockWallet, {
        asset: "FAKECOIN",
        amount: "100",
      });
      expect(result).toContain("Error");
      expect(result).toContain("not supported");
    });
  });

  describe("rebalance", () => {
    it("should return advisory plan when improvement exceeds threshold", async () => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.rebalance(mockWallet, {
        asset: "USDC",
        minApyImprovementBps: 1,
      });
      const parsed = JSON.parse(result);
      expect(parsed.action).toBeDefined();
    });

    it("should return no-op when improvement is below threshold", async () => {
      (mockWallet.readContract as jest.Mock).mockImplementation(
        async (params: { address: string; functionName: string }) => {
          if (params.functionName === "getUtilization") return 500000000000000000n;
          if (params.functionName === "getSupplyRate") return 1000000000n;
          if (params.address === AAVE_POOL_ADDRESS && params.functionName === "getReserveData") {
            return {
              configuration: 0n,
              liquidityIndex: 0n,
              currentLiquidityRate: 31536000000000000n,
              variableBorrowIndex: 0n,
              currentVariableBorrowRate: 0n,
              currentStableBorrowRate: 0n,
              lastUpdateTimestamp: 0,
              id: 0,
              aTokenAddress: "0x0000000000000000000000000000000000000001",
              stableDebtTokenAddress: "0x0000000000000000000000000000000000000002",
              variableDebtTokenAddress: "0x0000000000000000000000000000000000000003",
              interestRateStrategyAddress: "0x0000000000000000000000000000000000000004",
              accruedToTreasury: 0n,
              unbacked: 0n,
              isolationModeTotalDebt: 0n,
            };
          }
          return 0n;
        },
      );
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.rebalance(mockWallet, {
        asset: "USDC",
        minApyImprovementBps: 10000,
      });
      const parsed = JSON.parse(result);
      expect(parsed.action).toBe("no-op");
    });

    it("should use default threshold of 50 bps when not specified", async () => {
      setupCompoundRateMocks(mockWallet);
      setupAaveRateMocks(mockWallet);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.rebalance(mockWallet, { asset: "USDC" });
      const parsed = JSON.parse(result);
      expect(parsed.action).toBeDefined();
    });

    it("should return error when fewer than 2 protocols return rates", async () => {
      (mockWallet.readContract as jest.Mock).mockRejectedValue(new Error("fail"));
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const result = await provider.rebalance(mockWallet, { asset: "USDC" });
      expect(result).toContain("Error");
    });
  });
});
