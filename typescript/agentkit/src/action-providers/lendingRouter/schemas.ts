import { z } from "zod";

export const CompareLendingRatesSchema = z
  .object({
    asset: z
      .string()
      .describe("The token symbol to compare lending rates for (e.g. 'USDC', 'WETH', 'cbETH')"),
    side: z
      .enum(["supply", "borrow"])
      .describe("Whether to compare supply (lend) APY or borrow APY"),
  })
  .describe("Compare live lending rates for an asset across supported protocols on Base");

export const GetAggregatedPositionSchema = z
  .object({
    user: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
      .optional()
      .describe(
        "The wallet address to check positions for. Defaults to the connected wallet if omitted",
      ),
  })
  .describe(
    "Get aggregated lending positions and health factors across all supported protocols on Base",
  );

export const RouteSupplySchema = z
  .object({
    asset: z.string().describe("The token symbol to supply (e.g. 'USDC', 'WETH')"),
    amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "Must be a valid integer or decimal value")
      .describe("The amount of tokens to supply in human-readable format (e.g. '100', '0.5')"),
    preferProtocol: z
      .string()
      .optional()
      .describe(
        "Optionally force routing to a specific protocol ('compound', 'aave', 'moonwell', 'morpho') instead of the best rate",
      ),
  })
  .describe("Supply tokens to the best-rate lending protocol on Base, or to a preferred protocol");

export const RouteBorrowSchema = z
  .object({
    asset: z.string().describe("The token symbol to borrow (e.g. 'USDC', 'WETH')"),
    amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "Must be a valid integer or decimal value")
      .describe("The amount of tokens to borrow in human-readable format (e.g. '1000', '0.5')"),
    preferProtocol: z
      .string()
      .optional()
      .describe(
        "Optionally force routing to a specific protocol ('compound', 'aave'). v1 supports Compound and Aave only for borrows",
      ),
  })
  .describe(
    "Borrow tokens from the cheapest-rate lending protocol on Base. v1 supports Compound and Aave",
  );

export const RebalanceSchema = z
  .object({
    asset: z.string().describe("The token symbol to rebalance (e.g. 'USDC', 'WETH')"),
    minApyImprovementBps: z
      .number()
      .optional()
      .describe(
        "Minimum APY improvement in basis points to justify a rebalance. Defaults to 50 (0.5%)",
      ),
  })
  .describe(
    "Detect supply positions earning below the best available rate and suggest or execute a rebalance across protocols on Base",
  );
