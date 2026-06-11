import { z } from "zod";

/**
 * Supported lending protocols for the claim-and-restake loop.
 */
export const PROTOCOLS = ["compound", "moonwell", "morpho"] as const;

/**
 * Matches a 0x-prefixed 20-byte EVM address.
 */
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/**
 * Input schema for the get_claimable_rewards action.
 */
export const GetClaimableRewardsSchema = z
  .object({
    protocol: z
      .enum(PROTOCOLS)
      .describe(
        "The lending protocol to read claimable rewards from. One of 'compound' (Compound III / COMP), 'moonwell' (WELL) or 'morpho' (Morpho rewards via the off-chain rewards API).",
      ),
    user: z
      .string()
      .regex(EVM_ADDRESS_REGEX, "Invalid EVM address")
      .optional()
      .describe(
        "Optional EVM address (0x-prefixed) to check rewards for. Defaults to the connected wallet's address when omitted.",
      ),
  })
  .describe(
    "Reads the currently claimable reward token and amount for a wallet on a given lending protocol. Does not change any on-chain state.",
  );

/**
 * Input schema for the claim_rewards action.
 */
export const ClaimRewardsSchema = z
  .object({
    protocol: z
      .enum(PROTOCOLS)
      .describe(
        "The lending protocol to claim rewards from. One of 'compound', 'moonwell' or 'morpho'. For 'morpho' the merkle proof is fetched from the off-chain rewards API before the on-chain claim.",
      ),
    user: z
      .string()
      .regex(EVM_ADDRESS_REGEX, "Invalid EVM address")
      .optional()
      .describe(
        "Optional EVM address (0x-prefixed) to claim rewards for. Defaults to the connected wallet's address when omitted.",
      ),
  })
  .describe(
    "Claims accrued lending rewards for the wallet from the given protocol and returns the claimed token, amount and transaction hash.",
  );

/**
 * Input schema for the claim_and_restake action.
 */
export const ClaimAndRestakeSchema = z
  .object({
    protocol: z
      .enum(PROTOCOLS)
      .describe(
        "The lending protocol to harvest rewards from. One of 'compound', 'moonwell' or 'morpho'.",
      ),
    restakeTarget: z
      .enum(["same", "erc4626"])
      .describe(
        "Where to redeploy the harvested (and optionally swapped) tokens. 'same' re-supplies into the same lending protocol you claimed from (Compound III supply). 'erc4626' deposits into the generic ERC-4626 vault given by restakeVault.",
      ),
    restakeVault: z
      .string()
      .regex(EVM_ADDRESS_REGEX, "Invalid EVM address")
      .optional()
      .describe(
        "Required when restakeTarget is 'erc4626': the 0x-prefixed address of the ERC-4626 vault to deposit into. The vault's asset() must match the token being deposited.",
      ),
    swapToAsset: z
      .string()
      .regex(EVM_ADDRESS_REGEX, "Invalid EVM address")
      .optional()
      .describe(
        "Optional 0x-prefixed token address to swap the claimed reward into before restaking (via the in-tree 0x swap). Omit to restake the reward token as-is. Ignored if it equals the reward token.",
      ),
    slippageBps: z
      .number()
      .optional()
      .describe(
        "Optional maximum swap slippage in basis points (100 = 1%). Only used when swapToAsset is provided. Defaults to 100.",
      ),
    minRewardUsd: z
      .number()
      .optional()
      .describe(
        "Optional minimum reward value in USD below which the loop is skipped (gas-vs-reward gate). Defaults to 0, in which case only the gas-multiple gate applies.",
      ),
  })
  .describe(
    "Claims rewards, applies a gas-vs-reward threshold gate, optionally swaps the reward into a target asset, and restakes the proceeds into the same protocol or a generic ERC-4626 vault. Reports per-leg transaction hashes.",
  );
