import { z } from "zod";

/**
 * Input schema for the get_markets action (Gamma market discovery).
 */
export const GetMarketsSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .default(20)
      .describe("Maximum number of markets to return (default 20)"),
    active: z
      .boolean()
      .optional()
      .describe("If true, only return markets that are currently active/open for trading"),
    order: z
      .string()
      .optional()
      .describe('Field to sort results by, e.g. "volume24hr" or "liquidity"'),
    ascending: z
      .boolean()
      .optional()
      .describe("Sort direction: true for ascending, false for descending"),
    tagSlug: z
      .string()
      .optional()
      .describe('Filter markets by a category tag slug, e.g. "politics" or "crypto"'),
  })
  .describe("Instructions for discovering Polymarket prediction markets");

/**
 * Input schema for the get_market action. At least one identifier is required.
 */
export const GetMarketSchema = z
  .object({
    conditionId: z
      .string()
      .optional()
      .describe("The market conditionId (0x-prefixed hex) to look up"),
    tokenId: z
      .string()
      .optional()
      .describe("A CLOB outcome tokenId belonging to the market to look up"),
    slug: z.string().optional().describe("The market slug to look up"),
  })
  .describe(
    "Instructions for fetching a single Polymarket market with live odds and liquidity. Provide at least one of conditionId, tokenId, or slug.",
  )
  .refine(args => Boolean(args.conditionId || args.tokenId || args.slug), {
    message: "At least one of conditionId, tokenId, or slug must be provided",
  });

/**
 * Input schema for the place_order action (signed CLOB order).
 */
export const PlaceOrderSchema = z
  .object({
    tokenId: z
      .string()
      .describe("The CLOB outcome tokenId to trade (obtain via get_market / get_markets)"),
    side: z
      .enum(["BUY", "SELL"])
      .describe('Order side: "BUY" to buy outcome shares, "SELL" to sell them'),
    price: z
      .number()
      .min(0)
      .max(1)
      .describe("Limit price per share between 0 and 1 (e.g. 0.62 = 62 cents)"),
    size: z.number().positive().describe("Number of outcome shares to trade (whole-share units)"),
    orderType: z
      .enum(["GTC", "FOK", "FAK"])
      .default("GTC")
      .describe(
        'Order type: "GTC" (good-til-cancelled, default), "FOK" (fill-or-kill), "FAK" (fill-and-kill)',
      ),
    negRisk: z
      .boolean()
      .default(false)
      .describe(
        "Set true if the market is a negative-risk (multi-outcome) market; selects the neg-risk exchange. Available from get_market.",
      ),
  })
  .describe("Instructions for signing and placing a Polymarket CLOB order");

/**
 * Input schema for the get_positions action (Data API positions read).
 */
export const GetPositionsSchema = z
  .object({
    user: z
      .string()
      .optional()
      .describe("Wallet address to read positions for. Defaults to the connected wallet."),
    sizeThreshold: z
      .number()
      .nonnegative()
      .default(1)
      .describe("Minimum position size to include in results (default 1)"),
  })
  .describe("Instructions for reading Polymarket positions for a wallet");

/**
 * Input schema for the redeem_winnings action (on-chain redeemPositions).
 */
export const RedeemWinningsSchema = z
  .object({
    conditionId: z
      .string()
      .describe("The conditionId (0x-prefixed hex) of the resolved market to redeem"),
    negRisk: z
      .boolean()
      .default(false)
      .describe("Set true if the market is a negative-risk market (uses the NegRiskAdapter)"),
    indexSets: z
      .array(z.number().int().positive())
      .default([1, 2])
      .describe("Outcome index sets to redeem (default [1, 2] for binary markets)"),
  })
  .describe("Instructions for redeeming winnings from a resolved Polymarket market");
