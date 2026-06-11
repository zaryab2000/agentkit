import { EvmWalletProvider } from "../../wallet-providers";
import { BASE_TOKENS } from "./constants";
import { portfolioRebalanceActionProvider } from "./portfolioRebalanceActionProvider";

const WALLET_ADDRESS = "0x1234567890123456789012345678901234567890";

const USDC = BASE_TOKENS.USDC.address.toLowerCase();
const WETH = BASE_TOKENS.WETH.address.toLowerCase();
const CBBTC = BASE_TOKENS.CBBTC.address.toLowerCase();
const AERO = BASE_TOKENS.AERO.address.toLowerCase();

describe("PortfolioRebalanceActionProvider", () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock;

  const provider = portfolioRebalanceActionProvider();
  let walletProvider: jest.Mocked<EvmWalletProvider>;

  /**
   * Queues a DefiLlama-style price response for the given address->price map.
   *
   * @param prices - Map of lowercased token address to USD price.
   */
  const mockPrices = (prices: Record<string, number>) => {
    const coins: Record<string, { price: number; decimals: number; symbol: string }> = {};
    for (const [address, price] of Object.entries(prices)) {
      coins[`base:${address}`] = { price, decimals: 18, symbol: "TKN" };
    }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ coins }) });
  };

  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = fetchMock;

    walletProvider = {
      getAddress: jest.fn().mockReturnValue(WALLET_ADDRESS),
      getNetwork: jest
        .fn()
        .mockReturnValue({ protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }),
      readContract: jest.fn(),
      sendTransaction: jest.fn(),
      waitForTransactionReceipt: jest.fn(),
    } as unknown as jest.Mocked<EvmWalletProvider>;
  });

  /**
   * Configures the wallet's readContract mock to return raw balances by token address.
   *
   * @param balances - Map of lowercased token address to raw bigint balance.
   */
  const mockBalances = (balances: Record<string, bigint>) => {
    walletProvider.readContract.mockImplementation(async params => {
      const address = (params as { address: string }).address;
      return (balances[address.toLowerCase()] ?? 0n) as never;
    });
  };

  describe("plan_rebalance", () => {
    it("plans the minimum set of swaps from an overweight token into the deficits", async () => {
      // 5000 USDC ($5000) + 1 WETH ($2000) = $7000 total.
      mockBalances({
        [USDC]: 5_000_000_000n, // 5000 * 1e6
        [WETH]: 1_000_000_000_000_000_000n, // 1 * 1e18
      });
      mockPrices({ [USDC]: 1, [WETH]: 2000, [CBBTC]: 60000 });

      const result = await provider.planRebalance(walletProvider, {
        targets: [
          { token: "USDC", weightBps: 5000 },
          { token: "WETH", weightBps: 3000 },
          { token: "CBBTC", weightBps: 2000 },
        ],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.totalUsd).toBe(7000);
      expect(parsed.rebalanceNeeded).toBe(true);

      // USDC is overweight ($5000 vs $3500 target) and is the only source.
      // Greedy fills the largest deficit (CBBTC $1400) first, then WETH ($100).
      expect(parsed.swaps).toHaveLength(2);
      expect(parsed.swaps[0]).toMatchObject({ from: "USDC", to: "CBBTC", amountUsd: 1400 });
      expect(parsed.swaps[1]).toMatchObject({ from: "USDC", to: "WETH", amountUsd: 100 });

      // Read-only: never executes.
      expect(walletProvider.sendTransaction).not.toHaveBeenCalled();
    });

    it("returns no-op when drift is within the threshold", async () => {
      // Current weights ~71.43% USDC / 28.57% WETH; target matches.
      mockBalances({
        [USDC]: 5_000_000_000n,
        [WETH]: 1_000_000_000_000_000_000n,
      });
      mockPrices({ [USDC]: 1, [WETH]: 2000 });

      const result = await provider.planRebalance(walletProvider, {
        targets: [
          { token: "USDC", weightBps: 7143 },
          { token: "WETH", weightBps: 2857 },
        ],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.rebalanceNeeded).toBe(false);
      expect(parsed.swaps).toHaveLength(0);
      expect(parsed.note).toContain("within the drift threshold");
      expect(walletProvider.sendTransaction).not.toHaveBeenCalled();
    });

    it("rejects target weights that do not sum to 10000", async () => {
      const result = await provider.planRebalance(walletProvider, {
        targets: [
          { token: "USDC", weightBps: 5000 },
          { token: "WETH", weightBps: 4000 },
        ],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("must sum to exactly 10000");
      expect(walletProvider.readContract).not.toHaveBeenCalled();
    });

    it("returns an error for an unsupported target token", async () => {
      const result = await provider.planRebalance(walletProvider, {
        targets: [
          { token: "FOO", weightBps: 5000 },
          { token: "USDC", weightBps: 5000 },
        ],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Unsupported token");
    });

    it("warns about and excludes held tokens with no available price", async () => {
      mockBalances({
        [USDC]: 5_000_000_000n,
        [AERO]: 1_000_000_000_000_000_000n, // held but unpriced
      });
      mockPrices({ [USDC]: 1 }); // no AERO price

      const result = await provider.planRebalance(walletProvider, {
        targets: [{ token: "USDC", weightBps: 10000 }],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.totalUsd).toBe(5000);
      expect(parsed.warnings?.[0]).toContain("AERO");
    });

    it("returns a JSON error (not a throw) when balance reads fail", async () => {
      walletProvider.readContract.mockRejectedValue(new Error("rpc down"));

      const result = await provider.planRebalance(walletProvider, {
        targets: [{ token: "USDC", weightBps: 10000 }],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Error planning rebalance");
      expect(parsed.error).toContain("rpc down");
    });

    it("rejects an empty targets array", async () => {
      const result = await provider.planRebalance(walletProvider, {
        targets: [],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("No target allocation");
      expect(walletProvider.readContract).not.toHaveBeenCalled();
    });

    it("resolves targets supplied as 0x addresses", async () => {
      mockBalances({
        [USDC]: 5_000_000_000n,
        [WETH]: 1_000_000_000_000_000_000n,
      });
      mockPrices({ [USDC]: 1, [WETH]: 2000 });

      const result = await provider.planRebalance(walletProvider, {
        targets: [
          { token: BASE_TOKENS.USDC.address, weightBps: 7143 },
          { token: BASE_TOKENS.WETH.address, weightBps: 2857 },
        ],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.totalUsd).toBe(7000);
    });

    it("rejects duplicate tokens in targets", async () => {
      const result = await provider.planRebalance(walletProvider, {
        targets: [
          { token: "USDC", weightBps: 5000 },
          { token: BASE_TOKENS.USDC.address, weightBps: 5000 },
        ],
        rebalanceThresholdBps: 100,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Duplicate target token");
    });
  });

  describe("supportsNetwork", () => {
    it("returns true only for Base mainnet (evm, chainId 8453)", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "8453" })).toBe(true);
    });

    it("returns false for other EVM chains", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "1" })).toBe(false);
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "84532" })).toBe(false);
    });

    it("returns false for non-EVM networks", () => {
      expect(provider.supportsNetwork({ protocolFamily: "svm", chainId: "8453" })).toBe(false);
    });
  });
});
