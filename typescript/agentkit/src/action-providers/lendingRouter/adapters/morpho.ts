import { EvmWalletProvider } from "../../../wallet-providers";
import { MORPHO_GRAPHQL_ENDPOINT } from "../constants";
import { RateResult, PositionResult } from "../utils";

interface MorphoMarketGql {
  uniqueKey: string;
  loanAsset: { symbol: string; address: string };
  collateralAsset: { symbol: string; address: string } | null;
  state: {
    supplyApy: number;
    borrowApy: number;
    supplyAssetsUsd: number;
    borrowAssetsUsd: number;
  };
}

const MARKETS_QUERY = `
  query GetMarkets($chainId: Int!, $assetSymbol: String!) {
    markets(
      where: {
        chainId_in: [$chainId]
        or: [
          { loanAsset_: { symbol_contains_nocase: $assetSymbol } }
          { collateralAsset_: { symbol_contains_nocase: $assetSymbol } }
        ]
      }
      first: 10
      orderBy: SupplyAssetsUsd
      orderDirection: Desc
    ) {
      items {
        uniqueKey
        loanAsset { symbol address }
        collateralAsset { symbol address }
        state {
          supplyApy
          borrowApy
          supplyAssetsUsd
          borrowAssetsUsd
        }
      }
    }
  }
`;

/**
 * Reads live supply or borrow APY from Morpho Blue markets via the GraphQL API.
 *
 * @param _wallet - The wallet provider (unused — Morpho uses HTTP).
 * @param asset - The token symbol to query.
 * @param side - Whether to read supply or borrow rates.
 * @returns The rate result or null if no markets are found or the API fails.
 */
export async function getMorphoRates(
  _wallet: EvmWalletProvider,
  asset: string,
  side: "supply" | "borrow",
): Promise<RateResult | null> {
  try {
    const response = await fetch(MORPHO_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: MARKETS_QUERY,
        variables: { chainId: 8453, assetSymbol: asset.toUpperCase() },
      }),
    });

    if (!response.ok) return null;

    const json = await response.json();
    const markets: MorphoMarketGql[] = json?.data?.markets?.items ?? [];

    if (markets.length === 0) return null;

    const best = markets.reduce((prev, curr) => {
      const prevApy = side === "supply" ? prev.state.supplyApy : prev.state.borrowApy;
      const currApy = side === "supply" ? curr.state.supplyApy : curr.state.borrowApy;
      if (side === "supply") return currApy > prevApy ? curr : prev;
      return currApy < prevApy && currApy > 0 ? curr : prev;
    });

    const apy = side === "supply" ? best.state.supplyApy : best.state.borrowApy;

    return {
      protocol: "morpho",
      apy: apy * 100,
      marketId: best.uniqueKey,
      source: "morpho-graphql",
      notes: `${best.loanAsset.symbol}/${best.collateralAsset?.symbol ?? "none"} market, TVL $${best.state.supplyAssetsUsd.toFixed(0)}`,
    };
  } catch {
    return null;
  }
}

/**
 * Returns a stub position result for Morpho Blue (v1 — full position tracking is v2).
 *
 * @param _wallet - The wallet provider (unused in v1).
 * @param _user - The user address (unused in v1).
 * @returns A minimal position result with empty supplies/borrows.
 */
export async function getMorphoPosition(
  _wallet: EvmWalletProvider,
  _user: string,
): Promise<PositionResult> {
  // Morpho Blue positions require iterating known market IDs.
  // For v1, return a minimal stub — full position tracking requires
  // querying the GraphQL API for user-specific positions.
  return {
    protocol: "morpho",
    supplies: [],
    borrows: [],
    healthFactor: Infinity,
    healthSource: "morpho-graphql (position data requires market enumeration)",
    healthComparable: false,
  };
}
