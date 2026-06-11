import { claimRestakeActionProvider } from "./claimRestakeActionProvider";
import { EvmWalletProvider } from "../../wallet-providers";
import {
  COMET_REWARDS_ADDRESS,
  COMPOUND_COMET_ADDRESS,
  MOONWELL_COMPTROLLER_ADDRESS,
} from "./constants";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const REWARD_TOKEN = "0x2222222222222222222222222222222222222222";
const VAULT_ADDRESS = "0x3333333333333333333333333333333333333333";
const MORPHO_DISTRIBUTOR = "0x4444444444444444444444444444444444444444";
const TARGET_TOKEN = "0x5555555555555555555555555555555555555555";

// Mock the in-tree 0x provider so the swap leg is deterministic and needs no key.
const mockExecuteSwap = jest.fn();
jest.mock("../zeroX/zeroXActionProvider", () => ({
  ZeroXActionProvider: jest.fn().mockImplementation(() => ({ executeSwap: mockExecuteSwap })),
}));

/**
 * Builds a mocked EvmWalletProvider for the claim-restake tests.
 *
 * @param overrides - Optional behavior overrides.
 * @param overrides.balanceQueue - Sequential balanceOf return values.
 * @param overrides.assetReturn - The ERC-4626 asset() return value.
 * @param overrides.simulateOwed - The CometRewards owed amount.
 * @param overrides.decimals - The token decimals.
 * @param overrides.baseTokenReturn - The Comet baseToken() return value.
 * @returns A mocked wallet provider and its key jest mocks.
 */
function makeWallet(overrides?: {
  balanceQueue?: bigint[];
  assetReturn?: string;
  simulateOwed?: bigint;
  decimals?: number;
  baseTokenReturn?: string;
}) {
  const balanceQueue = [...(overrides?.balanceQueue ?? [])];
  const decimals = overrides?.decimals ?? 18;

  const simulateContract = jest.fn().mockResolvedValue({
    result: { token: REWARD_TOKEN, owed: overrides?.simulateOwed ?? 0n },
  });
  const getGasPrice = jest.fn().mockResolvedValue(1_000_000_000n); // 1 gwei

  const readContract = jest.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "decimals":
        return decimals;
      case "symbol":
        return "RWD";
      case "asset":
        return overrides?.assetReturn ?? REWARD_TOKEN;
      case "baseToken":
        return overrides?.baseTokenReturn ?? REWARD_TOKEN;
      case "allowance":
        return 0n;
      case "balanceOf":
        return balanceQueue.shift() ?? 0n;
      default:
        return 0n;
    }
  });

  const sendTransaction = jest.fn().mockResolvedValue("0xtxhash");
  const waitForTransactionReceipt = jest.fn().mockResolvedValue({ status: "success" });

  const wallet = {
    getAddress: jest.fn().mockReturnValue(WALLET_ADDRESS),
    getNetwork: jest.fn().mockReturnValue({ protocolFamily: "evm", chainId: "8453" }),
    getPublicClient: jest.fn().mockReturnValue({ simulateContract, getGasPrice }),
    readContract,
    sendTransaction,
    waitForTransactionReceipt,
  } as unknown as EvmWalletProvider;

  return { wallet, simulateContract, readContract, sendTransaction };
}

/**
 * Configures global.fetch to serve DefiLlama prices and Morpho distributions.
 *
 * @param opts - Price and distribution overrides.
 * @param opts.rewardPrice - The reward token USD price.
 * @param opts.ethPrice - The ETH USD price.
 * @param opts.morphoDistributions - Morpho API distribution rows.
 * @returns The jest fetch mock.
 */
function mockFetch(opts?: {
  rewardPrice?: number | null;
  ethPrice?: number;
  morphoDistributions?: unknown[];
}) {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.includes("/v1/users/")) {
      return {
        ok: true,
        json: async () => ({ data: opts?.morphoDistributions ?? [] }),
      };
    }
    if (url.includes("coingecko:ethereum")) {
      return {
        ok: true,
        json: async () => ({ coins: { "coingecko:ethereum": { price: opts?.ethPrice ?? 3000 } } }),
      };
    }
    // DefiLlama token price; rewardPrice === null simulates an unpriceable token.
    const key = `base:${REWARD_TOKEN}`;
    if (opts?.rewardPrice === null) {
      return { ok: true, json: async () => ({ coins: {} }) };
    }
    return {
      ok: true,
      json: async () => ({ coins: { [key]: { price: opts?.rewardPrice ?? 5 } } }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("ClaimRestakeActionProvider", () => {
  const provider = claimRestakeActionProvider();

  beforeEach(() => {
    jest.restoreAllMocks();
    mockExecuteSwap.mockReset();
  });

  describe("supportsNetwork", () => {
    it("returns true only for Base mainnet (8453)", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "8453" })).toBe(true);
      expect(provider.supportsNetwork({ protocolFamily: "evm", chainId: "1" })).toBe(false);
      expect(provider.supportsNetwork({ protocolFamily: "svm", chainId: "8453" })).toBe(false);
    });
  });

  describe("get_claimable_rewards", () => {
    it("reads Compound rewards via a static simulation", async () => {
      mockFetch();
      const { wallet, simulateContract } = makeWallet({ simulateOwed: 5n * 10n ** 18n });

      const result = await provider.getClaimableRewards(wallet, { protocol: "compound" });
      const parsed = JSON.parse(result);

      expect(simulateContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "getRewardOwed", address: COMET_REWARDS_ADDRESS }),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.claimable).toBe(true);
      expect(parsed.amount).toBe("5");
    });

    it("returns 'nothing to claim' when Compound owed is zero", async () => {
      const { wallet } = makeWallet({ simulateOwed: 0n });
      const parsed = JSON.parse(
        await provider.getClaimableRewards(wallet, { protocol: "compound" }),
      );
      expect(parsed.claimable).toBe(false);
      expect(parsed.message).toBe("nothing to claim");
    });

    it("reads Morpho rewards from the off-chain API", async () => {
      mockFetch({
        morphoDistributions: [
          {
            asset: { address: REWARD_TOKEN, symbol: "MORPHO", decimals: 18 },
            distributor: { address: MORPHO_DISTRIBUTOR },
            claimable: (7n * 10n ** 18n).toString(),
            proof: ["0xabc"],
          },
        ],
      });
      const { wallet } = makeWallet();

      const parsed = JSON.parse(await provider.getClaimableRewards(wallet, { protocol: "morpho" }));
      expect(parsed.claimable).toBe(true);
      expect(parsed.amount).toBe("7");
    });

    it("flags Moonwell preview as unavailable", async () => {
      const { wallet } = makeWallet();
      const parsed = JSON.parse(
        await provider.getClaimableRewards(wallet, { protocol: "moonwell" }),
      );
      expect(parsed.previewAvailable).toBe(false);
    });
  });

  describe("claim_rewards", () => {
    it("claims Compound rewards and returns the tx hash", async () => {
      const { wallet, sendTransaction } = makeWallet({ simulateOwed: 5n * 10n ** 18n });
      const parsed = JSON.parse(await provider.claimRewards(wallet, { protocol: "compound" }));

      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: COMET_REWARDS_ADDRESS }),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.txHash).toBe("0xtxhash");
    });

    it("fetches the Morpho proof before claiming", async () => {
      const fetchMock = mockFetch({
        morphoDistributions: [
          {
            asset: { address: REWARD_TOKEN, symbol: "MORPHO", decimals: 18 },
            distributor: { address: MORPHO_DISTRIBUTOR },
            claimable: (7n * 10n ** 18n).toString(),
            proof: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`],
          },
        ],
      });
      const { wallet, sendTransaction } = makeWallet();

      const parsed = JSON.parse(await provider.claimRewards(wallet, { protocol: "morpho" }));

      expect(fetchMock).toHaveBeenCalled(); // proof fetched
      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: MORPHO_DISTRIBUTOR }),
      );
      expect(parsed.success).toBe(true);
    });

    it("aborts Morpho claim cleanly when the proof is empty", async () => {
      mockFetch({
        morphoDistributions: [
          {
            asset: { address: REWARD_TOKEN, symbol: "MORPHO", decimals: 18 },
            distributor: { address: MORPHO_DISTRIBUTOR },
            claimable: "1",
            proof: [],
          },
        ],
      });
      const { wallet, sendTransaction } = makeWallet();

      const result = await provider.claimRewards(wallet, { protocol: "morpho" });
      expect(result).toContain("empty merkle proof");
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("claims Moonwell rewards via the comptroller and reports the realized amount", async () => {
      const { wallet, sendTransaction } = makeWallet({
        balanceQueue: [10n * 10n ** 18n, 30n * 10n ** 18n], // WELL before, after claim
      });
      const parsed = JSON.parse(await provider.claimRewards(wallet, { protocol: "moonwell" }));

      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: MOONWELL_COMPTROLLER_ADDRESS }),
      );
      expect(parsed.success).toBe(true);
      expect(parsed.amount).toBe("20"); // 30 - 10 WELL delta
    });

    it("does not send a Compound claim tx when nothing is owed", async () => {
      const { wallet, sendTransaction } = makeWallet({ simulateOwed: 0n });
      const result = await provider.claimRewards(wallet, { protocol: "compound" });

      expect(result).toContain("nothing to claim");
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("claim_and_restake", () => {
    it("skips below the minRewardUsd threshold", async () => {
      mockFetch({ rewardPrice: 5 }); // reward 5 tokens * $5 = $25
      const { wallet, sendTransaction } = makeWallet({ simulateOwed: 5n * 10n ** 18n });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "same",
          minRewardUsd: 1000,
        }),
      );

      expect(parsed.skipped).toBe(true);
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("claims and restakes into an ERC-4626 vault when above threshold", async () => {
      mockFetch({ rewardPrice: 5 }); // reward 100 * $5 = $500
      const { wallet, sendTransaction } = makeWallet({
        simulateOwed: 100n * 10n ** 18n,
        balanceQueue: [0n, 100n * 10n ** 18n], // before claim, after claim
        assetReturn: REWARD_TOKEN,
      });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "erc4626",
          restakeVault: VAULT_ADDRESS,
        }),
      );

      expect(parsed.success).toBe(true);
      expect(parsed.claim).toBeDefined();
      expect(parsed.restake.target).toBe("erc4626");
      // claim tx + approve tx + deposit tx
      expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: VAULT_ADDRESS }));
    });

    it("rejects an ERC-4626 vault whose asset does not match", async () => {
      mockFetch({ rewardPrice: 5 });
      const { wallet } = makeWallet({
        simulateOwed: 100n * 10n ** 18n,
        balanceQueue: [0n, 100n * 10n ** 18n],
        assetReturn: "0x9999999999999999999999999999999999999999",
      });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "erc4626",
          restakeVault: VAULT_ADDRESS,
        }),
      );

      expect(parsed.success).toBe(false);
      expect(parsed.recoverable).toBe(true);
      expect(parsed.message).toContain("expects asset");
    });

    it("reports a recoverable state when nothing is received after claim", async () => {
      mockFetch({ rewardPrice: 5 });
      const { wallet } = makeWallet({
        simulateOwed: 100n * 10n ** 18n,
        balanceQueue: [50n, 50n], // no delta
      });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "erc4626",
          restakeVault: VAULT_ADDRESS,
        }),
      );

      expect(parsed.claimedNothing).toBe(true);
    });

    it("restakes 'same' into Compound when the reward is the base asset", async () => {
      mockFetch({ rewardPrice: 5 });
      const { wallet, sendTransaction } = makeWallet({
        simulateOwed: 100n * 10n ** 18n,
        balanceQueue: [0n, 100n * 10n ** 18n],
        baseTokenReturn: REWARD_TOKEN, // reward == Comet base asset
      });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "same",
        }),
      );

      expect(parsed.success).toBe(true);
      expect(parsed.restake.target).toBe("same");
      // supply leg targets the Comet market
      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: COMPOUND_COMET_ADDRESS }),
      );
    });

    it("rejects 'same' restake when the reward is not the Compound base asset", async () => {
      mockFetch({ rewardPrice: 5 });
      const { wallet } = makeWallet({
        simulateOwed: 100n * 10n ** 18n,
        balanceQueue: [0n, 100n * 10n ** 18n],
        baseTokenReturn: "0x9999999999999999999999999999999999999999", // base != reward
      });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "same",
        }),
      );

      expect(parsed.success).toBe(false);
      expect(parsed.recoverable).toBe(true);
      expect(parsed.message).toContain("requires the base asset");
    });

    it("treats a 0x JSON swap failure as a recoverable state", async () => {
      mockFetch({ rewardPrice: 5 });
      mockExecuteSwap.mockResolvedValue(
        JSON.stringify({ success: false, error: "no liquidity available" }),
      );
      const { wallet } = makeWallet({
        simulateOwed: 100n * 10n ** 18n,
        balanceQueue: [0n, 100n * 10n ** 18n, 0n], // before/after claim, before swap
      });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "erc4626",
          restakeVault: VAULT_ADDRESS,
          swapToAsset: TARGET_TOKEN,
        }),
      );

      expect(parsed.success).toBe(false);
      expect(parsed.recoverable).toBe(true);
      expect(parsed.message).toContain("swap failed");
    });

    it("swaps then restakes into ERC-4626 on a successful swap", async () => {
      mockFetch({ rewardPrice: 5 });
      mockExecuteSwap.mockResolvedValue(JSON.stringify({ success: true }));
      const { wallet, sendTransaction } = makeWallet({
        simulateOwed: 100n * 10n ** 18n,
        // before/after claim (reward), before/after swap (target)
        balanceQueue: [0n, 100n * 10n ** 18n, 0n, 50n * 10n ** 18n],
        assetReturn: TARGET_TOKEN, // ERC-4626 asset matches swapped token
      });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "erc4626",
          restakeVault: VAULT_ADDRESS,
          swapToAsset: TARGET_TOKEN,
        }),
      );

      expect(mockExecuteSwap).toHaveBeenCalled();
      expect(parsed.success).toBe(true);
      expect(parsed.restake.token).toBe(TARGET_TOKEN);
      expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: VAULT_ADDRESS }));
    });

    it("skips when the reward cannot be priced and a minRewardUsd floor is set", async () => {
      mockFetch({ rewardPrice: null }); // DefiLlama returns no price
      const { wallet, sendTransaction } = makeWallet({ simulateOwed: 100n * 10n ** 18n });

      const parsed = JSON.parse(
        await provider.claimAndRestake(wallet, {
          protocol: "compound",
          restakeTarget: "same",
          minRewardUsd: 50,
        }),
      );

      expect(parsed.skipped).toBe(true);
      expect(parsed.gate.reason).toContain("could not be priced");
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });
});
