import { bridgeDeployActionProvider } from "./bridgeDeployActionProvider";
import { EvmWalletProvider } from "../../wallet-providers";
import { Network } from "../../network";
import { createAcrossClient as mockCreateAcrossClient } from "@across-protocol/app-sdk";

const MOCK_ADDRESS = "0x9876543210987654321098765432109876543210";
const ORIGIN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEST_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MORPHO_VAULT = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca";
const COMET_MARKET = "0xb125E6687d4313864e53df431d5425969c15Eb2F";

// Mock viem: keep encoding/parsing real, stub the wallet client + transport.
jest.mock("viem", () => ({
  ...jest.requireActual("viem"),
  createWalletClient: jest.fn(() => ({
    writeContract: jest.fn().mockResolvedValue("0xdepositTxHash"),
  })),
  http: jest.fn(),
}));

jest.mock("viem/accounts", () => ({
  privateKeyToAccount: jest
    .fn()
    .mockReturnValue({ address: "0x9876543210987654321098765432109876543210" }),
}));

// Mock the network module so origin/destination chains resolve.
jest.mock("../../network", () => ({
  ...jest.requireActual("../../network"),
  getChain: jest.fn().mockReturnValue({ id: 10, name: "Optimism" }),
  CHAIN_ID_TO_NETWORK_ID: { "8453": "base-mainnet", "10": "optimism" },
  NETWORK_ID_TO_VIEM_CHAIN: {
    "base-mainnet": { id: 8453, name: "Base" },
    optimism: { id: 10, name: "Optimism" },
  },
}));

// Across is mainnet-only in these tests.
jest.mock("../across/utils", () => ({
  isAcrossSupportedTestnet: jest.fn().mockReturnValue(false),
}));

// Mock the Across SDK.
jest.mock("@across-protocol/app-sdk", () => ({
  createAcrossClient: jest.fn(),
}));

const mockedCreateAcrossClient = mockCreateAcrossClient as jest.MockedFunction<
  typeof mockCreateAcrossClient
>;

const defaultAcrossClient = () => ({
  getSupportedChains: jest.fn().mockResolvedValue([
    {
      chainId: 10,
      name: "Optimism",
      inputTokens: [{ symbol: "USDC", address: ORIGIN_USDC, decimals: 6 }],
    },
  ]),
  getAvailableRoutes: jest
    .fn()
    .mockResolvedValue([
      { isNative: false, originToken: ORIGIN_USDC, destinationToken: DEST_USDC },
    ]),
  getQuote: jest.fn().mockResolvedValue({
    deposit: {
      inputAmount: BigInt("100000000"), // 100 USDC
      outputAmount: BigInt("99900000"), // 99.9 USDC (10 bps)
      spokePoolAddress: "0x1234567890123456789012345678901234567890",
      outputToken: DEST_USDC,
    },
    limits: { minDeposit: BigInt("1000000"), maxDeposit: BigInt("100000000000") },
  }),
  simulateDepositTx: jest.fn().mockResolvedValue({
    request: { address: "0x1234567890123456789012345678901234567890", abi: [], args: [] },
  }),
  waitForDepositTx: jest.fn().mockResolvedValue({ depositId: "123456" }),
});

describe("Bridge Deploy Action Provider", () => {
  const MOCK_PRIVATE_KEY = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

  let mockWallet: jest.Mocked<EvmWalletProvider>;
  let actionProvider: ReturnType<typeof bridgeDeployActionProvider>;

  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreateAcrossClient.mockImplementation(() => defaultAcrossClient() as any);

    mockWallet = {
      getAddress: jest.fn().mockReturnValue(MOCK_ADDRESS),
      getNetwork: jest.fn().mockReturnValue({
        chainId: "10",
        networkId: "optimism",
        protocolFamily: "evm",
      }),
      sendTransaction: jest.fn().mockResolvedValue("0xmocktxhash"),
      waitForTransactionReceipt: jest.fn().mockResolvedValue({}),
      // readContract is used for ERC20 balanceOf (bridge preflight + deploy) and decimals.
      readContract: jest.fn().mockImplementation(({ functionName }) => {
        if (functionName === "decimals") return Promise.resolve(6);
        return Promise.resolve(BigInt("200000000")); // 200 USDC balance
      }),
    } as unknown as jest.Mocked<EvmWalletProvider>;

    actionProvider = bridgeDeployActionProvider({ privateKey: MOCK_PRIVATE_KEY });
  });

  describe("bridge_and_deploy", () => {
    const args = {
      token: "USDC",
      amount: "100",
      destinationChainId: "8453",
      destinationProtocol: "morpho" as const,
      protocolMarketAddress: MORPHO_VAULT,
      maxSlippageBps: 100,
      recipient: null,
    };

    it("initiates the bridge and returns a pending status without supplying", async () => {
      const response = await actionProvider.bridgeAndDeploy(mockWallet, args);
      const parsed = JSON.parse(response);

      expect(parsed.status).toEqual("bridging");
      expect(parsed.depositId).toEqual("123456");
      expect(parsed.destinationProtocol).toEqual("morpho");
      // Must NOT claim the supply has happened.
      expect(response).not.toContain("Supplied");
    });

    it("rejects unsupported (non-Base) destination chains", async () => {
      const response = await actionProvider.bridgeAndDeploy(mockWallet, {
        ...args,
        destinationChainId: "10",
      });
      expect(response).toContain("only supported on Base");
    });

    it("returns (not throws) on bridge errors", async () => {
      mockWallet.readContract = jest.fn().mockRejectedValue(new Error("rpc down"));
      const response = await actionProvider.bridgeAndDeploy(mockWallet, args);
      expect(response).toContain("Error bridging and deploying");
      expect(response).toContain("rpc down");
    });
  });

  describe("bridge_deploy_status", () => {
    const bridgeArgs = {
      token: "USDC",
      amount: "100",
      destinationChainId: "8453",
      destinationProtocol: "morpho" as const,
      protocolMarketAddress: MORPHO_VAULT,
      maxSlippageBps: 100,
      recipient: null,
    };

    beforeEach(() => {
      global.fetch = jest.fn();
    });

    it("returns pending while the bridge is still in flight", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending", originChainId: 10, destinationChainId: 8453 }),
      });

      const response = await actionProvider.bridgeDeployStatus(mockWallet, {
        depositId: "123456",
        originChainId: "10",
      });
      expect(JSON.parse(response).status).toEqual("pending");
      expect(response).toContain("still pending");
    });

    it("auto-triggers the destination supply once filled", async () => {
      // First record a pending deploy via bridge_and_deploy.
      await actionProvider.bridgeAndDeploy(mockWallet, bridgeArgs);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "filled",
          fillTx: "0xfillTxHash",
          originChainId: 10,
          destinationChainId: 8453,
        }),
      });

      const response = await actionProvider.bridgeDeployStatus(mockWallet, {
        depositId: "123456",
        originChainId: "10",
      });
      const parsed = JSON.parse(response);

      expect(parsed.status).toEqual("filled");
      expect(parsed.deploy).toContain("Supplied");
      expect(parsed.deploy).toContain("0xmocktxhash");
    });

    it("warns and runs no supply when refunded", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "refunded", depositRefundTxHash: "0xrefund" }),
      });

      const response = await actionProvider.bridgeDeployStatus(mockWallet, {
        depositId: "123456",
        originChainId: "10",
      });
      expect(JSON.parse(response).status).toEqual("refunded");
      expect(response).toContain("refunded");
    });
  });

  describe("deploy_on_destination", () => {
    const baseArgs = {
      token: DEST_USDC,
      amount: "50",
      protocol: "compound" as const,
      protocolMarketAddress: COMET_MARKET,
      chainId: "8453",
      recipient: null,
    };

    it("supplies after a successful balance preflight", async () => {
      const response = await actionProvider.deployOnDestination(mockWallet, baseArgs);
      expect(response).toContain("Supplied 50");
      expect(response).toContain("compound");
      expect(response).toContain("0xmocktxhash");
    });

    it("errors on insufficient destination balance (preflight)", async () => {
      mockWallet.readContract = jest.fn().mockImplementation(({ functionName }) => {
        if (functionName === "decimals") return Promise.resolve(6);
        return Promise.resolve(BigInt("0"));
      });
      const response = await actionProvider.deployOnDestination(mockWallet, baseArgs);
      expect(response).toContain("insufficient balance");
    });

    it("rejects unsupported destination chains", async () => {
      const response = await actionProvider.deployOnDestination(mockWallet, {
        ...baseArgs,
        chainId: "1",
      });
      expect(response).toContain("only supported on Base");
    });
  });

  describe("supportsNetwork", () => {
    it("returns true for EVM networks", () => {
      const evmNetwork: Network = {
        protocolFamily: "evm",
        networkId: "base-mainnet",
        chainId: "8453",
      };
      expect(actionProvider.supportsNetwork(evmNetwork)).toBe(true);
    });

    it("returns false for non-EVM networks", () => {
      const solanaNetwork: Network = { protocolFamily: "svm", networkId: "solana-mainnet" };
      expect(actionProvider.supportsNetwork(solanaNetwork)).toBe(false);
    });
  });
});
