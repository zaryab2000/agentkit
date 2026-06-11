import { z } from "zod";

/** uint32 maximum, used to bound perp asset indices. */
const UINT32_MAX = 4294967295;

/** uint16 maximum, used to bound the position precompile's perp index. */
const UINT16_MAX = 65535;

/**
 * Input schema for the get_markets action.
 */
export const GetMarketsSchema = z
  .object({
    indices: z
      .array(z.number().int().nonnegative().max(UINT32_MAX))
      .min(1)
      .describe(
        "Array of HyperCore perp asset indices (uint32) to fetch, e.g. [0, 1, 2]. There is no " +
          "on-chain way to enumerate all perps from precompiles, so you must pass the explicit " +
          "indices you care about. Full market discovery requires the native Hyperliquid info API, " +
          "which this provider does not support.",
      ),
    includePrices: z
      .boolean()
      .default(true)
      .describe(
        "If true (default), also fetch the mark price and oracle price for each requested asset.",
      ),
  })
  .describe(
    "Read perp market metadata (and optionally mark/oracle prices) for the given HyperCore asset indices.",
  );

/**
 * Input schema for the get_positions action.
 */
export const GetPositionsSchema = z
  .object({
    user: z
      .string()
      .nullable()
      .optional()
      .describe(
        "EVM address whose HyperCore perp positions to read. Defaults to the agent wallet " +
          "address if omitted.",
      ),
    perpIndices: z
      .array(z.number().int().nonnegative().max(UINT16_MAX))
      .min(1)
      .describe(
        "Perp asset indices (uint16) to check, e.g. [0, 1]. Uses the same indexing as get_markets.",
      ),
  })
  .describe(
    "Read the agent's (or a specified user's) HyperCore perp positions with computed unrealized PnL.",
  );

/**
 * Input schema for the open_position action.
 */
export const OpenPositionSchema = z
  .object({
    asset: z
      .number()
      .int()
      .nonnegative()
      .max(UINT32_MAX)
      .describe("HyperCore perp asset index (uint32), e.g. 0 for the first listed perp."),
    isBuy: z.boolean().describe("true to go long (buy), false to go short (sell)."),
    size: z
      .number()
      .positive()
      .describe(
        "Order size in the asset's base units (human-readable, e.g. 0.1 for 0.1 of the perp).",
      ),
    limitPx: z
      .number()
      .positive()
      .describe(
        "Limit price (human-readable). For a market-like fill, pass an aggressive price (well " +
          "above the mark for buys, well below for sells) together with tif='Ioc'.",
      ),
    tif: z
      .enum(["Alo", "Gtc", "Ioc"])
      .default("Ioc")
      .describe(
        "Time-in-force: 'Ioc' (immediate-or-cancel, default, market-like), 'Gtc' (good-til-cancel, " +
          "rests on the book), 'Alo' (add-liquidity-only / post-only).",
      ),
    reduceOnly: z
      .boolean()
      .default(false)
      .describe(
        "If true, the order may only reduce an existing position, never increase or flip it.",
      ),
    cloid: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Optional client order id as a uint128 decimal or 0x-hex string. Omit or '0' for none.",
      ),
  })
  .describe(
    "Submit a limit order to open or add to a Hyperliquid perp position via CoreWriter. Settlement " +
      "is asynchronous and non-atomic: a successful transaction does NOT mean the order filled. " +
      "Poll get_positions to confirm. Requires collateral already on the HyperCore perp side.",
  );

/**
 * Input schema for the close_position action.
 */
export const ClosePositionSchema = z
  .object({
    asset: z
      .number()
      .int()
      .nonnegative()
      .max(UINT16_MAX)
      .describe("HyperCore perp asset index (uint16) of the position to close."),
    size: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe("Amount to close in base units. Omit to close the full position."),
    slippageBps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(500)
      .describe(
        "Protective slippage bound in basis points applied to the mark price when pricing the " +
          "reduce-only order (default 500 = 5%).",
      ),
    cloid: z
      .string()
      .nullable()
      .optional()
      .describe("Optional client order id as a uint128 decimal or 0x-hex string."),
  })
  .describe(
    "Close (or partially reduce) a Hyperliquid perp position via a reduce-only CoreWriter order. " +
      "Settlement is asynchronous and non-atomic; poll get_positions to confirm.",
  );
