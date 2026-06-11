import { Address } from "viem";

/**
 * Base mainnet chain id (string, per AgentKit Network.chainId convention).
 */
export const BASE_MAINNET_CHAIN_ID = "8453";

// ---------------------------------------------------------------------------
// Compound III (CometRewards)
// ---------------------------------------------------------------------------

/**
 * CometRewards contract on Base mainnet.
 *
 * TODO(verify-at-build): confirm against docs.compound.finance / the Comet
 * deployment registry before opening the upstream PR.
 */
export const COMET_REWARDS_ADDRESS: Address = "0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1";

/**
 * The Compound III (USDC) Comet market on Base mainnet. Matches the address
 * used by the in-tree compound action provider.
 */
export const COMPOUND_COMET_ADDRESS: Address = "0xb125E6687d4313864e53df431d5425969c15Eb2F";

/**
 * Minimal CometRewards ABI.
 *
 * Note: getRewardOwed is NON-view (it mutates accrual state), so it must be
 * read via a static simulation, never treated as a plain read.
 */
export const COMET_REWARDS_ABI = [
  {
    inputs: [
      { internalType: "address", name: "comet", type: "address" },
      { internalType: "address", name: "account", type: "address" },
    ],
    name: "getRewardOwed",
    outputs: [
      {
        components: [
          { internalType: "address", name: "token", type: "address" },
          { internalType: "uint256", name: "owed", type: "uint256" },
        ],
        internalType: "struct CometRewards.RewardOwed",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "comet", type: "address" },
      { internalType: "address", name: "src", type: "address" },
      { internalType: "bool", name: "shouldAccrue", type: "bool" },
    ],
    name: "claim",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Moonwell (Comptroller / Unitroller)
// ---------------------------------------------------------------------------

/**
 * Moonwell Comptroller (Unitroller) on Base mainnet.
 *
 * TODO(verify-at-build): confirm the live comptroller address and the exact
 * claimReward signature on Base (PRD §6).
 */
export const MOONWELL_COMPTROLLER_ADDRESS: Address = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";

/**
 * WELL reward token on Base mainnet (matches the in-tree moonwell provider).
 */
export const MOONWELL_WELL_TOKEN: Address = "0xA88594D404727625A9437C3f886C7643872296AE";

/**
 * Minimal Moonwell comptroller ABI (Compound-v2-fork claimReward).
 */
export const MOONWELL_COMPTROLLER_ABI = [
  {
    inputs: [{ internalType: "address", name: "holder", type: "address" }],
    name: "claimReward",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Morpho (Universal Rewards Distributor + off-chain rewards API)
// ---------------------------------------------------------------------------

/**
 * Base URL of the Morpho rewards API used to fetch claimable amounts + merkle
 * proofs for the Universal Rewards Distributor.
 *
 * TODO(verify-at-build): the exact endpoint + response shape is graded STALE
 * in the PRD (§6) — re-verify against docs.morpho.org before the upstream PR.
 */
export const MORPHO_REWARDS_API_BASE = "https://rewards.morpho.org";

/**
 * Allowlist of trusted Morpho Universal Rewards Distributor addresses on Base.
 * The claim target returned by the off-chain API is checked against this list
 * before any transaction is sent, so a spoofed API response cannot redirect
 * funds to an arbitrary contract.
 *
 * TODO(verify-at-build): seed with the verified Base mainnet URD address(es)
 * from docs.morpho.org / the on-chain registry. While empty, the claim adapter
 * still enforces that the distributor is a well-formed address but cannot
 * cross-check it against a known-good set — populate before the upstream PR.
 */
export const KNOWN_MORPHO_URD_ADDRESSES: readonly Address[] = [];

/**
 * Minimal Universal Rewards Distributor ABI (Merkl-style claim).
 */
export const MORPHO_URD_ABI = [
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "address", name: "reward", type: "address" },
      { internalType: "uint256", name: "claimable", type: "uint256" },
      { internalType: "bytes32[]", name: "proof", type: "bytes32[]" },
    ],
    name: "claim",
    outputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Compound III Comet (re-supply target for restakeTarget "same")
// ---------------------------------------------------------------------------

/**
 * Minimal Comet ABI for the "same" restake leg: supply plus baseToken (used to
 * guard against supplying an asset the market does not accept, which reverts).
 */
export const COMET_SUPPLY_ABI = [
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "supply",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "baseToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Generic ERC-4626 (restakeTarget "erc4626")
// ---------------------------------------------------------------------------

/**
 * Minimal ERC-4626 ABI (asset() validation + deposit).
 */
export const ERC4626_ABI = [
  {
    inputs: [],
    name: "asset",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "assets", type: "uint256" },
      { internalType: "address", name: "receiver", type: "address" },
    ],
    name: "deposit",
    outputs: [{ internalType: "uint256", name: "shares", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Valuation / gas-vs-reward gate
// ---------------------------------------------------------------------------

/**
 * DefiLlama public price API base (no API key required).
 */
export const DEFILLAMA_PRICE_API_BASE = "https://coins.llama.fi/prices/current";

/**
 * Rough gas-units estimate for a claim+restake bundle, used by the gas gate.
 */
export const GAS_UNITS_ESTIMATE = 500_000n;

/**
 * Default multiple: the reward must exceed this many times the estimated gas
 * cost to be worth restaking (PRD §6).
 */
export const DEFAULT_GAS_MULTIPLE = 5;
