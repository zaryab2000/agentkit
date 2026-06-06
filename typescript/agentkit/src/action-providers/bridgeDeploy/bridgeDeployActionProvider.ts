import { z } from "zod";
import { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { EvmWalletProvider } from "../../wallet-providers";
import { Network } from "../../network";
import {
  BridgeAndDeploySchema,
  BridgeDeployStatusSchema,
  DeployOnDestinationSchema,
} from "./schemas";
import {
  deployToProtocol,
  getDepositStatus,
  initiateAcrossDeposit,
  isSupportedDestinationChain,
  PendingDeploy,
} from "./utils";
import { SUPPORTED_DESTINATION_CHAIN_IDS } from "./constants";

/**
 * Configuration options for the BridgeDeployActionProvider.
 */
export interface BridgeDeployActionProviderConfig {
  /**
   * Private key of the wallet provider, used to submit the Across deposit
   * transaction (mirrors the in-tree `across` provider). Wallet I/O is otherwise
   * routed through the wallet provider.
   */
  privateKey: string;
}

/**
 * BridgeDeployActionProvider composes an Across bridge with a destination
 * lending/vault supply, expressing "move this capital to chain X and put it to
 * work" as one agent intent.
 *
 * IMPORTANT: Across destination-side execution only delivers to a deployed
 * handler contract, never to a plain EOA. Agent wallets are EOAs, so this flow
 * is deliberately TWO-STEP and NON-ATOMIC: bridge → poll status → supply on
 * arrival. The provider never claims the supply happened before the bridge fills.
 */
export class BridgeDeployActionProvider extends ActionProvider<EvmWalletProvider> {
  #privateKey: string;
  #pendingDeploys: Map<string, PendingDeploy> = new Map();

  /**
   * Constructor for the BridgeDeployActionProvider.
   *
   * @param config - The configuration options for the BridgeDeployActionProvider.
   */
  constructor(config: BridgeDeployActionProviderConfig) {
    super("bridgeDeploy", []);
    this.#privateKey = config.privateKey;
    const account = privateKeyToAccount(this.#privateKey as Hex);
    if (!account) throw new Error("Invalid private key");
  }

  /**
   * Bridges a token to a destination chain via Across and records the intent to
   * supply it into a destination lending/vault position once the bridge fills.
   *
   * @param walletProvider - The wallet provider to use for the transaction.
   * @param args - The input arguments for the action.
   * @returns A JSON string with the deposit details and next-step guidance.
   */
  @CreateAction({
    name: "bridge_and_deploy",
    description: `
Bridges a token to a destination chain via Across, then (after the bridge fills) supplies it into a lending/vault position on the destination chain.

It takes:
- token: The symbol of the token to bridge (e.g. 'ETH', 'USDC')
- amount: The amount to bridge in whole units (e.g. 1.5, 100)
- destinationChainId: The destination chain ID (defaults to Base '8453')
- destinationProtocol: 'compound' (Comet market) or 'morpho' (MetaMorpho vault)
- protocolMarketAddress: The Comet market or Morpho vault address to supply into on the destination chain
- maxSlippageBps: (Optional) Max bridge slippage in basis points (defaults to 100 = 1%)
- recipient: (Optional) Recipient on the destination chain (defaults to the sender)

IMPORTANT — this is a TWO-STEP, NON-ATOMIC flow for EOA wallets:
- It returns AFTER initiating the bridge; the destination supply has NOT happened yet.
- It returns a depositId. You MUST call bridge_deploy_status with that depositId to poll the bridge; the destination supply runs automatically once the bridge is 'filled'.
- Never assume the funds have been supplied until bridge_deploy_status reports a deploy transaction hash.
`,
    schema: BridgeAndDeploySchema,
  })
  async bridgeAndDeploy(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof BridgeAndDeploySchema>,
  ): Promise<string> {
    try {
      const destinationChainId = Number(args.destinationChainId);
      if (!isSupportedDestinationChain(destinationChainId)) {
        return `Error: destination protocol deployment is only supported on Base (chain IDs ${SUPPORTED_DESTINATION_CHAIN_IDS.join(", ")}), not chain ${destinationChainId}`;
      }

      const recipient = (args.recipient || walletProvider.getAddress()) as Hex;

      const deposit = await initiateAcrossDeposit(walletProvider, this.#privateKey, {
        tokenSymbol: args.token,
        amount: args.amount,
        destinationChainId,
        recipient,
        maxSlippageBps: args.maxSlippageBps,
      });

      // Record the pending destination supply, keyed by the deposit.
      this.#pendingDeploys.set(this.#pendingKey(deposit.originChainId, deposit.depositId), {
        protocol: args.destinationProtocol,
        token: deposit.outputToken,
        amount: deposit.outputAmount,
        protocolMarketAddress: args.protocolMarketAddress,
        chainId: destinationChainId,
        recipient,
      });

      return JSON.stringify(
        {
          status: "bridging",
          depositId: deposit.depositId,
          originChainId: deposit.originChainId,
          destinationChainId: deposit.destinationChainId,
          destinationProtocol: args.destinationProtocol,
          protocolMarketAddress: args.protocolMarketAddress,
          inputAmount: deposit.inputAmount,
          expectedOutputAmount: deposit.outputAmount,
          depositTxHash: deposit.depositTxHash,
          next: `call bridge_deploy_status with depositId ${deposit.depositId} and originChainId ${deposit.originChainId}; the destination supply runs automatically once the bridge is 'filled'`,
          note: "TWO-STEP / NON-ATOMIC: the destination supply has NOT happened yet.",
        },
        null,
        2,
      );
    } catch (error) {
      return `Error bridging and deploying ${args.amount} ${args.token}: ${error}`;
    }
  }

  /**
   * Polls the Across deposit status and, once the bridge is filled, runs the
   * previously-recorded destination supply.
   *
   * @param walletProvider - The wallet provider to use for the transaction.
   * @param args - The input arguments for the action.
   * @returns A status message, including the deploy tx hash once supplied.
   */
  @CreateAction({
    name: "bridge_deploy_status",
    description: `
Checks the status of a bridge-and-deploy deposit on Across and runs the pending destination supply once the bridge has filled.

It takes:
- depositId: The deposit ID returned by bridge_and_deploy
- originChainId: (Optional) The origin chain ID of the bridge (defaults to the current chain)

Behavior:
- If still bridging: returns 'pending' — poll again later.
- If filled and a destination supply is pending: it supplies the bridged token into the recorded protocol and returns the deploy transaction hash.
- If refunded: returns a warning; no destination supply runs.
`,
    schema: BridgeDeployStatusSchema,
  })
  async bridgeDeployStatus(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof BridgeDeployStatusSchema>,
  ): Promise<string> {
    try {
      const originChainId =
        Number(args.originChainId) || Number(walletProvider.getNetwork().chainId);

      const statusInfo = await getDepositStatus(originChainId, args.depositId);
      const key = this.#pendingKey(originChainId, args.depositId);
      const pending = this.#pendingDeploys.get(key);

      if (statusInfo.status === "filled") {
        if (!pending) {
          return JSON.stringify(
            {
              status: "filled",
              fillTx: statusInfo.fillTx,
              note: "Bridge filled, but no pending destination supply was recorded for this deposit. Call deploy_on_destination to supply manually.",
            },
            null,
            2,
          );
        }

        const deployResult = await deployToProtocol(walletProvider, pending);
        if (deployResult.startsWith("Error")) {
          // Keep the pending deploy so it can be retried.
          return JSON.stringify(
            { status: "filled", fillTx: statusInfo.fillTx, deploy: deployResult },
            null,
            2,
          );
        }

        this.#pendingDeploys.delete(key);
        return JSON.stringify(
          { status: "filled", fillTx: statusInfo.fillTx, deploy: deployResult },
          null,
          2,
        );
      }

      if (statusInfo.status === "refunded") {
        this.#pendingDeploys.delete(key);
        return JSON.stringify(
          {
            status: "refunded",
            depositRefundTxHash: statusInfo.depositRefundTxHash,
            note: "The bridge was refunded; no destination supply was run. Funds were returned on the origin chain.",
          },
          null,
          2,
        );
      }

      return JSON.stringify(
        {
          status: statusInfo.status,
          note: "Bridge still pending — poll bridge_deploy_status again. The destination supply will run automatically once 'filled'.",
        },
        null,
        2,
      );
    } catch (error) {
      return `Error checking bridge-and-deploy status: ${error}`;
    }
  }

  /**
   * Supplies an already-bridged token into a destination lending/vault position.
   * Callable standalone or as the explicit second leg of a bridge-and-deploy.
   *
   * @param walletProvider - The wallet provider to use for the transaction.
   * @param args - The input arguments for the action.
   * @returns A message with the supply transaction hash.
   */
  @CreateAction({
    name: "deploy_on_destination",
    description: `
Supplies an already-bridged token into a destination lending/vault position. Use this as the explicit second leg of a bridge, or standalone when funds are already on the destination chain.

It takes:
- token: The token address (already bridged) to supply on the destination chain
- amount: The amount to supply in whole units
- protocol: 'compound' (Comet market) or 'morpho' (MetaMorpho vault)
- protocolMarketAddress: The Comet market or Morpho vault address to supply into
- chainId: (Optional) The destination chain ID (defaults to Base '8453')
- recipient: (Optional) The position owner (defaults to the sender)

It performs a balance preflight before supplying, so it is safe to retry if the bridge has not yet filled.
`,
    schema: DeployOnDestinationSchema,
  })
  async deployOnDestination(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof DeployOnDestinationSchema>,
  ): Promise<string> {
    try {
      const recipient = (args.recipient || walletProvider.getAddress()) as Hex;
      return await deployToProtocol(walletProvider, {
        protocol: args.protocol,
        token: args.token,
        amount: args.amount,
        protocolMarketAddress: args.protocolMarketAddress,
        chainId: Number(args.chainId),
        recipient,
      });
    } catch (error) {
      return `Error deploying ${args.amount} of token ${args.token} on destination: ${error}`;
    }
  }

  /**
   * Checks if the bridge-and-deploy action provider supports the given network.
   * Origin can be any EVM chain Across supports; destinations are gated in-code.
   *
   * @param network - The network to check.
   * @returns True if the network is EVM-compatible.
   */
  supportsNetwork = (network: Network) => network.protocolFamily === "evm";

  /**
   * Builds the in-memory key under which a pending deploy is recorded.
   *
   * @param originChainId - The origin chain ID of the bridge.
   * @param depositId - The Across deposit ID.
   * @returns The map key.
   */
  #pendingKey(originChainId: number, depositId: string): string {
    return `${originChainId}-${depositId}`;
  }
}

export const bridgeDeployActionProvider = (config: BridgeDeployActionProviderConfig) =>
  new BridgeDeployActionProvider(config);
