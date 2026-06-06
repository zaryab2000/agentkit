import { Hex, erc20Abi, formatUnits, getAddress } from "viem";
import { EvmWalletProvider } from "../../wallet-providers";
import { BASE_TOKENS, DEFILLAMA_CHAIN_PREFIX, DEFILLAMA_PRICES_URL, TokenInfo } from "./constants";

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/** A raw on-chain balance for a registry token. */
export interface Balance {
  /** The token this balance belongs to. */
  token: TokenInfo;
  /** The raw (undecimated) balance. */
  raw: bigint;
}

/** A token's valuation within the portfolio. */
export interface TokenValuation {
  /** The token symbol. */
  symbol: string;
  /** The token contract address. */
  address: string;
  /** The balance formatted in whole units. */
  balance: string;
  /** The USD price, or null if no price was available. */
  price: number | null;
  /** The USD value of the holding. */
  usdValue: number;
  /** The current weight of this holding in basis points. */
  weightBps: number;
}

/** A single token's drift from its target weight. */
export interface DriftEntry {
  /** The token symbol. */
  symbol: string;
  /** The current weight in basis points. */
  currentWeightBps: number;
  /** The target weight in basis points. */
  targetWeightBps: number;
  /** currentWeightBps - targetWeightBps (positive = overweight). */
  driftBps: number;
  /** The current USD value. */
  currentUsd: number;
  /** The target USD value. */
  targetUsd: number;
}

/** A planned swap leg moving value from an overweight token to an underweight one. */
export interface SwapLeg {
  /** The symbol of the overweight token to sell. */
  from: string;
  /** The symbol of the underweight token to buy. */
  to: string;
  /** The USD notional to move on this leg. */
  amountUsd: number;
  /** The estimated amount of the `from` token to sell, in whole units. */
  estSellAmount: string;
}

/**
 * Rounds a number to two decimal places (USD cents).
 *
 * @param value - The value to round.
 * @returns The rounded value.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Resolves a token symbol or address to its registry entry.
 *
 * @param tokenSymbolOrAddress - The token symbol (e.g. "USDC") or 0x address.
 * @returns The matching token registry entry.
 * @throws If the token is not in the supported registry.
 */
export function resolveToken(tokenSymbolOrAddress: string): TokenInfo {
  const bySymbol = BASE_TOKENS[tokenSymbolOrAddress.toUpperCase()];
  if (bySymbol) {
    return bySymbol;
  }

  if (ADDRESS_REGEX.test(tokenSymbolOrAddress)) {
    const normalized = getAddress(tokenSymbolOrAddress);
    const match = Object.values(BASE_TOKENS).find(t => getAddress(t.address) === normalized);
    if (match) {
      return match;
    }
  }

  throw new Error(
    `Unsupported token "${tokenSymbolOrAddress}". Supported tokens on Base mainnet: ${Object.keys(
      BASE_TOKENS,
    ).join(", ")}.`,
  );
}

/**
 * Reads on-chain ERC-20 balances for the given tokens.
 *
 * @param walletProvider - The wallet provider to read balances from.
 * @param tokens - The tokens to read balances for.
 * @returns The raw balances for each token.
 */
export async function readBalances(
  walletProvider: EvmWalletProvider,
  tokens: TokenInfo[],
): Promise<Balance[]> {
  const owner = walletProvider.getAddress() as Hex;
  const balances: Balance[] = [];
  for (const token of tokens) {
    const raw = (await walletProvider.readContract({
      address: getAddress(token.address) as Hex,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    balances.push({ token, raw });
  }
  return balances;
}

/**
 * Fetches USD prices for the given tokens via the keyless DefiLlama price API.
 *
 * @param tokens - The tokens to price.
 * @returns A map of lowercased token address to USD price (omitting tokens with no price).
 * @throws If the price API responds with a non-OK status.
 */
export async function fetchUsdPrices(tokens: TokenInfo[]): Promise<Record<string, number>> {
  const ids = tokens.map(t => `${DEFILLAMA_CHAIN_PREFIX}:${t.address.toLowerCase()}`).join(",");
  const response = await fetch(`${DEFILLAMA_PRICES_URL}/prices/current/${ids}`);

  if (!response.ok) {
    throw new Error(`Price API error: HTTP ${response.status}`);
  }

  const data = await response.json();
  const prices: Record<string, number> = {};
  for (const token of tokens) {
    const key = `${DEFILLAMA_CHAIN_PREFIX}:${token.address.toLowerCase()}`;
    const entry = data?.coins?.[key];
    if (entry && typeof entry.price === "number") {
      prices[token.address.toLowerCase()] = entry.price;
    }
  }
  return prices;
}

/**
 * Computes the USD valuation and current weight of each holding.
 *
 * Tokens with a balance but no available price are flagged and excluded from the
 * total (their USD value is treated as 0).
 *
 * @param balances - The raw token balances.
 * @param prices - A map of lowercased token address to USD price.
 * @returns The per-token valuations, total USD value, and any tokens missing a price.
 */
export function computeAllocation(
  balances: Balance[],
  prices: Record<string, number>,
): { valuations: TokenValuation[]; totalUsd: number; missingPrices: string[] } {
  const missingPrices: string[] = [];

  const partial = balances.map(({ token, raw }) => {
    const price = prices[token.address.toLowerCase()] ?? null;
    const balance = formatUnits(raw, token.decimals);
    const usdValue = price === null ? 0 : Number(balance) * price;
    if (price === null && raw > 0n) {
      missingPrices.push(token.symbol);
    }
    return { token, balance, price, usdValue };
  });

  const totalUsd = partial.reduce((sum, p) => sum + p.usdValue, 0);

  const valuations: TokenValuation[] = partial.map(p => ({
    symbol: p.token.symbol,
    address: p.token.address,
    balance: p.balance,
    price: p.price,
    usdValue: round2(p.usdValue),
    weightBps: totalUsd > 0 ? Math.round((p.usdValue / totalUsd) * 10000) : 0,
  }));

  return { valuations, totalUsd, missingPrices };
}

/**
 * Computes drift from the target allocation and plans the minimum set of swaps to
 * restore it, using a greedy largest-surplus to largest-deficit match in USD space.
 *
 * Tokens whose absolute drift is below `thresholdBps` are left untouched so that
 * dust drift does not trigger swaps.
 *
 * @param valuations - The current per-token valuations.
 * @param targets - The desired target weights per token symbol.
 * @param totalUsd - The total portfolio value in USD.
 * @param thresholdBps - The minimum absolute drift (bps) before a token is rebalanced.
 * @returns The per-token drift, the planned swap legs, and whether a rebalance is needed.
 */
export function planRebalance(
  valuations: TokenValuation[],
  targets: { symbol: string; weightBps: number }[],
  totalUsd: number,
  thresholdBps: number,
): { drift: DriftEntry[]; swaps: SwapLeg[]; rebalanceNeeded: boolean } {
  const valBySymbol = new Map(valuations.map(v => [v.symbol, v]));
  const targetBySymbol = new Map(targets.map(t => [t.symbol, t.weightBps]));
  const symbols = new Set<string>([...valBySymbol.keys(), ...targetBySymbol.keys()]);

  const drift: DriftEntry[] = [];
  for (const symbol of symbols) {
    const valuation = valBySymbol.get(symbol);
    const currentUsd = valuation?.usdValue ?? 0;
    const currentWeightBps = valuation?.weightBps ?? 0;
    const targetWeightBps = targetBySymbol.get(symbol) ?? 0;
    const targetUsd = (totalUsd * targetWeightBps) / 10000;
    drift.push({
      symbol,
      currentWeightBps,
      targetWeightBps,
      driftBps: currentWeightBps - targetWeightBps,
      currentUsd,
      targetUsd: round2(targetUsd),
    });
  }

  const sources = drift
    .filter(d => d.driftBps >= thresholdBps && d.currentUsd - d.targetUsd > 0)
    .map(d => ({ symbol: d.symbol, surplusUsd: d.currentUsd - d.targetUsd }))
    .sort((a, b) => b.surplusUsd - a.surplusUsd);

  const sinks = drift
    .filter(d => d.driftBps <= -thresholdBps && d.targetUsd - d.currentUsd > 0)
    .map(d => ({ symbol: d.symbol, deficitUsd: d.targetUsd - d.currentUsd }))
    .sort((a, b) => b.deficitUsd - a.deficitUsd);

  const swaps: SwapLeg[] = [];
  let i = 0;
  let j = 0;
  while (i < sources.length && j < sinks.length) {
    const amount = Math.min(sources[i].surplusUsd, sinks[j].deficitUsd);
    if (amount > 0) {
      const fromPrice = valBySymbol.get(sources[i].symbol)?.price ?? null;
      const estSellAmount = fromPrice && fromPrice > 0 ? (amount / fromPrice).toString() : "0";
      swaps.push({
        from: sources[i].symbol,
        to: sinks[j].symbol,
        amountUsd: round2(amount),
        estSellAmount,
      });
    }
    sources[i].surplusUsd -= amount;
    sinks[j].deficitUsd -= amount;
    if (sources[i].surplusUsd <= 1e-6) {
      i++;
    }
    if (sinks[j].deficitUsd <= 1e-6) {
      j++;
    }
  }

  return { drift, swaps, rebalanceNeeded: swaps.length > 0 };
}
