export interface RateResult {
  protocol: string;
  apy: number;
  marketAddress: string;
  source: string;
  notes: string;
}

export interface PositionResult {
  protocol: string;
  supplies: Array<{ asset: string; balance: string; usdValue: number }>;
  borrows: Array<{ asset: string; balance: string; usdValue: number }>;
  healthFactor: number;
  healthSource: string;
}

/**
 * Sorts rate results by APY, best-first for the given side.
 *
 * @param rates - The rate results to rank.
 * @param side - Whether to rank for supply (highest first) or borrow (lowest first).
 * @returns Sorted copy of the rates array.
 */
export function rankRates(rates: RateResult[], side: "supply" | "borrow"): RateResult[] {
  return [...rates].sort((a, b) => {
    if (side === "supply") return b.apy - a.apy;
    return a.apy - b.apy;
  });
}

/**
 * Finds the position with the lowest health factor across protocols.
 *
 * @param positions - The position results to scan.
 * @returns The protocol and health factor of the most at-risk position, or null if all are infinite.
 */
export function findLowestHealth(positions: PositionResult[]): {
  protocol: string;
  healthFactor: number;
} | null {
  let lowest: { protocol: string; healthFactor: number } | null = null;
  for (const pos of positions) {
    if (pos.healthFactor === Infinity) continue;
    if (!lowest || pos.healthFactor < lowest.healthFactor) {
      lowest = { protocol: pos.protocol, healthFactor: pos.healthFactor };
    }
  }
  return lowest;
}

/**
 * Formats an APY number as a percentage string.
 *
 * @param apy - The APY value to format.
 * @returns A formatted percentage string.
 */
export function formatApy(apy: number): string {
  return `${apy.toFixed(4)}%`;
}
