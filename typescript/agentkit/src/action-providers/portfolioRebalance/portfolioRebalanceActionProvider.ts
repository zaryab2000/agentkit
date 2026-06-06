import { z } from "zod";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { Network } from "../../network";
import { EvmWalletProvider } from "../../wallet-providers";
import { PlanRebalanceSchema } from "./schemas";
import {
  BASE_CHAIN_ID,
  BASE_TOKENS,
  DEFAULT_REBALANCE_THRESHOLD_BPS,
  SUPPORTED_NETWORK_ID,
  TokenInfo,
} from "./constants";
import {
  computeAllocation,
  fetchUsdPrices,
  planRebalance,
  readBalances,
  resolveToken,
} from "./utils";

/**
 * PortfolioRebalanceActionProvider plans the minimum set of swaps required to move a
 * wallet from its current token allocation to a requested target allocation on Base.
 *
 * This is a portfolio-level rebalancer, not a DEX router: it reads balances, values
 * them in USD, measures drift from target weights, and plans the swaps. The
 * `plan_rebalance` action is read-only and never executes any transaction.
 */
export class PortfolioRebalanceActionProvider extends ActionProvider<EvmWalletProvider> {
  /**
   * Constructs a new PortfolioRebalanceActionProvider.
   */
  constructor() {
    super("portfolioRebalance", []);
  }

  /**
   * Reads the wallet's token balances, prices them in USD, computes drift from the
   * requested target allocation, and returns the minimum set of swaps to reach it.
   * This action is read-only: it never executes any transaction.
   *
   * @param walletProvider - The wallet provider to read balances from.
   * @param args - The target allocation and optional drift threshold.
   * @returns A stringified JSON rebalance plan, or a stringified error.
   */
  @CreateAction({
    name: "plan_rebalance",
    description: `Reads the wallet's token balances on Base mainnet, prices them in USD, computes how far each holding has drifted from a requested target allocation, and returns the minimum set of swaps to reach that target. This is READ-ONLY: it computes and returns a plan and does NOT execute any swap or transaction.

Inputs:
- targets: A list of { token, weightBps } where token is a symbol (e.g. USDC, WETH, CBBTC) or a 0x address on Base, and weightBps is the desired weight in basis points (1% = 100 bps). The weights MUST sum to exactly 10000. If the user gives percentages, convert them (e.g. 50% -> 5000).
- rebalanceThresholdBps: (optional) Minimum drift in basis points before a token is rebalanced; drift smaller than this is treated as dust and ignored. Defaults to 100 (1%).

Output: JSON with the current weights, per-token drift, the planned swaps (from, to, amountUsd, estSellAmount), the total USD value, and whether a rebalance is needed.

Notes:
- Supported on Base mainnet only.
- If the target weights do not sum to 10000, this returns an error explaining the discrepancy; ask the user to correct the weights.
- A held token with no available USD price is reported as a warning and excluded from the valuation.`,
    schema: PlanRebalanceSchema,
  })
  async planRebalance(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof PlanRebalanceSchema>,
  ): Promise<string> {
    try {
      if (!args.targets || args.targets.length === 0) {
        return JSON.stringify({ success: false, error: "No target allocation was provided." });
      }

      const totalTargetBps = args.targets.reduce((sum, t) => sum + t.weightBps, 0);
      if (totalTargetBps !== 10000) {
        return JSON.stringify({
          success: false,
          error: `Target weights must sum to exactly 10000 bps (100%). Provided sum: ${totalTargetBps} bps.`,
        });
      }

      // Resolve every requested target token against the supported registry.
      let resolvedTargets: { symbol: string; weightBps: number }[];
      try {
        const seen = new Set<string>();
        resolvedTargets = args.targets.map(t => {
          const info = resolveToken(t.token);
          if (seen.has(info.symbol)) {
            throw new Error(`Duplicate target token "${info.symbol}".`);
          }
          seen.add(info.symbol);
          return { symbol: info.symbol, weightBps: t.weightBps };
        });
      } catch (error) {
        return JSON.stringify({ success: false, error: `${error}` });
      }

      const thresholdBps = args.rebalanceThresholdBps ?? DEFAULT_REBALANCE_THRESHOLD_BPS;

      // Value the whole known portfolio so that holdings outside the target set are
      // still counted and treated as rebalance sources.
      const registry: TokenInfo[] = Object.values(BASE_TOKENS);
      const balances = await readBalances(walletProvider, registry);
      const prices = await fetchUsdPrices(registry);
      const { valuations, totalUsd, missingPrices } = computeAllocation(balances, prices);

      if (totalUsd <= 0) {
        return JSON.stringify({
          success: true,
          network: SUPPORTED_NETWORK_ID,
          totalUsd: 0,
          rebalanceNeeded: false,
          note: "No priced holdings found in the wallet; nothing to rebalance.",
          ...(missingPrices.length > 0
            ? { warnings: [`No USD price found for: ${missingPrices.join(", ")}.`] }
            : {}),
        });
      }

      const targetSymbols = new Set(resolvedTargets.map(t => t.symbol));
      const { drift, swaps, rebalanceNeeded } = planRebalance(
        valuations,
        resolvedTargets,
        totalUsd,
        thresholdBps,
      );

      const currentWeights = valuations
        .filter(v => v.usdValue > 0 || targetSymbols.has(v.symbol))
        .map(v => ({
          symbol: v.symbol,
          balance: v.balance,
          price: v.price,
          usdValue: v.usdValue,
          weightBps: v.weightBps,
        }));

      const reportedDrift = drift
        .filter(d => targetSymbols.has(d.symbol) || d.currentUsd > 0)
        .map(d => ({
          symbol: d.symbol,
          currentWeightBps: d.currentWeightBps,
          targetWeightBps: d.targetWeightBps,
          driftBps: d.driftBps,
        }));

      return JSON.stringify({
        success: true,
        network: SUPPORTED_NETWORK_ID,
        totalUsd: Math.round(totalUsd * 100) / 100,
        thresholdBps,
        currentWeights,
        drift: reportedDrift,
        swaps,
        rebalanceNeeded,
        ...(missingPrices.length > 0
          ? {
              warnings: [
                `No USD price found for: ${missingPrices.join(
                  ", ",
                )}. These holdings were excluded from the valuation.`,
              ],
            }
          : {}),
        note: rebalanceNeeded
          ? "Plan only — no transactions were executed."
          : "Portfolio is within the drift threshold; no rebalance needed.",
      });
    } catch (error) {
      return `Error planning rebalance: ${error}`;
    }
  }

  /**
   * Checks if the portfolio rebalance action provider supports the given network.
   *
   * @param network - The network to check.
   * @returns True only for Base mainnet (EVM, chainId 8453).
   */
  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.chainId === BASE_CHAIN_ID;
}

/**
 * Factory for the PortfolioRebalanceActionProvider.
 *
 * @returns A new PortfolioRebalanceActionProvider instance.
 */
export const portfolioRebalanceActionProvider = () => new PortfolioRebalanceActionProvider();
