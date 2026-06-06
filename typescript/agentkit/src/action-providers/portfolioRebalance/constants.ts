/**
 * The network ID this action provider supports in v1 (Base mainnet).
 */
export const SUPPORTED_NETWORK_ID = "base-mainnet";

/**
 * The chain ID this action provider supports in v1 (Base mainnet).
 */
export const BASE_CHAIN_ID = "8453";

/**
 * Base URL for the DefiLlama price API (keyless).
 */
export const DEFILLAMA_PRICES_URL = "https://coins.llama.fi";

/**
 * The DefiLlama chain prefix used to key Base mainnet token prices.
 */
export const DEFILLAMA_CHAIN_PREFIX = "base";

/**
 * Default minimum absolute drift (in basis points) before a token is rebalanced.
 */
export const DEFAULT_REBALANCE_THRESHOLD_BPS = 100;

/**
 * Metadata describing a token in the supported registry.
 */
export interface TokenInfo {
  /** The token's display symbol. */
  symbol: string;
  /** The token's contract address on Base mainnet. */
  address: string;
  /** The token's ERC-20 decimals. */
  decimals: number;
}

/**
 * The v1 registry of tokens the portfolio rebalancer understands on Base mainnet.
 * Balances are read for every token in this registry so that holdings outside the
 * requested target set are still valued and treated as rebalance sources.
 */
export const BASE_TOKENS: Record<string, TokenInfo> = {
  USDC: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  CBBTC: { symbol: "CBBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  CBETH: { symbol: "CBETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  EURC: { symbol: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6 },
  DAI: { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  AERO: { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18 },
};
