import { z } from "zod";

/**
 * Input schema for the plan_rebalance action.
 */
export const PlanRebalanceSchema = z
  .object({
    targets: z
      .array(
        z.object({
          token: z
            .string()
            .describe(
              "Token symbol (e.g. USDC, WETH, CBBTC) or 0x contract address on Base mainnet to target.",
            ),
          weightBps: z
            .number()
            .int()
            .describe(
              "Desired target weight for this token in basis points (1% = 100 bps). All target weights must sum to exactly 10000.",
            ),
        }),
      )
      .describe(
        "The desired target portfolio allocation as a list of tokens and their weights in basis points. Weights must sum to exactly 10000 (100%).",
      ),
    rebalanceThresholdBps: z
      .number()
      .int()
      .nullable()
      .default(100)
      .describe(
        "Minimum absolute drift in basis points before a token is included in the rebalance plan. Drift smaller than this (dust) is ignored. Defaults to 100 bps (1%).",
      ),
  })
  .describe(
    "Inputs for planning the minimum set of swaps to move a wallet to a target token allocation on Base mainnet.",
  );
