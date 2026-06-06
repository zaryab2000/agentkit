import { z } from "zod";

/**
 * Input schema for the bridge_and_deploy action.
 *
 * Initiates an Across bridge to a destination chain and records the intent to
 * supply the bridged token into a lending/vault position once the bridge fills.
 */
export const BridgeAndDeploySchema = z
  .object({
    token: z
      .string()
      .describe("The symbol of the token to bridge and deploy (e.g. 'ETH', 'WETH', 'USDC')"),
    amount: z
      .string()
      .describe("The amount of the token to bridge in whole units (e.g. 1.5 WETH, 100 USDC)"),
    destinationChainId: z
      .string()
      .describe("The chain ID of the destination chain to deploy on (defaults to Base, '8453')")
      .nullable()
      .transform(val => val ?? "8453"),
    destinationProtocol: z
      .enum(["compound", "morpho"])
      .describe(
        "The destination lending/vault protocol to supply the bridged token into once it arrives: 'compound' (Comet market) or 'morpho' (MetaMorpho vault)",
      ),
    protocolMarketAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
      .describe(
        "The address of the destination market to supply into: the Compound Comet market address or the Morpho Vault address on the destination chain",
      ),
    maxSlippageBps: z
      .number()
      .describe(
        "The maximum acceptable bridge slippage in basis points (e.g. 100 for 1%), defaults to 100",
      )
      .nullable()
      .transform(val => val ?? 100),
    recipient: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
      .describe(
        "The recipient address on the destination chain (defaults to the sender wallet address)",
      )
      .nullable(),
  })
  .describe(
    "Instructions for bridging a token via Across and then supplying it into a destination lending/vault position (two-step, non-atomic for EOA wallets)",
  );

/**
 * Input schema for the bridge_deploy_status action.
 *
 * Polls the Across deposit-status API and, when the bridge has filled, triggers
 * the previously-recorded destination supply.
 */
export const BridgeDeployStatusSchema = z
  .object({
    depositId: z
      .string()
      .describe("The deposit ID returned by bridge_and_deploy, used to look up the bridge status"),
    originChainId: z
      .string()
      .describe(
        "The chain ID of the origin chain the bridge was initiated from (defaults to the current chain)",
      )
      .nullable(),
  })
  .describe(
    "Instructions for checking a bridge-and-deploy deposit status and running the pending destination supply once filled",
  );

/**
 * Input schema for the deploy_on_destination action.
 *
 * Supplies an already-bridged token into a destination lending/vault position.
 * Callable standalone or as the explicit second leg of a bridge-and-deploy flow.
 */
export const DeployOnDestinationSchema = z
  .object({
    token: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
      .describe("The address of the (already-bridged) token to supply on the destination chain"),
    amount: z.string().describe("The amount of the token to supply in whole units (e.g. 1.5, 100)"),
    protocol: z
      .enum(["compound", "morpho"])
      .describe(
        "The destination protocol to supply into: 'compound' (Comet market) or 'morpho' (MetaMorpho vault)",
      ),
    protocolMarketAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
      .describe(
        "The Compound Comet market address or Morpho Vault address to supply the token into",
      ),
    chainId: z
      .string()
      .describe("The chain ID of the destination chain to supply on (defaults to Base, '8453')")
      .nullable()
      .transform(val => val ?? "8453"),
    recipient: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
      .describe(
        "The address that should own the resulting position (defaults to the sender wallet address)",
      )
      .nullable(),
  })
  .describe(
    "Instructions for supplying an already-bridged token into a destination lending/vault position",
  );
