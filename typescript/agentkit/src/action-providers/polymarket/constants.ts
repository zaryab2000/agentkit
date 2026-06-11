/**
 * Constants for the Polymarket action provider.
 *
 * Targets Polymarket CTF Exchange V2 + pUSD collateral (post April 28, 2026 cutover).
 * All on-chain values are for Polygon mainnet (chainId 137).
 */

/** Polygon mainnet chain id, as a string (Network.chainId is a string). */
export const POLYGON_CHAIN_ID = "137";

/** Polygon mainnet chain id, as a number (for EIP-712 domains). */
export const POLYGON_CHAIN_ID_NUM = 137;

// --- API base URLs -----------------------------------------------------------

/** Gamma API (public, no auth) — market discovery and metadata. */
export const GAMMA_API_URL = "https://gamma-api.polymarket.com";

/** CLOB API (V2 production host post-cutover) — orderbook reads and order placement. */
export const CLOB_API_URL = "https://clob.polymarket.com";

/** Data API (public) — positions, trades, activity. */
export const DATA_API_URL = "https://data-api.polymarket.com";

// --- Contract addresses (Polygon, chainId 137) -------------------------------
// See docs-internal PRD §2.4 for grades/sources. VERIFY items flagged inline.

/** CTF Exchange V2 (standard markets) — order verifyingContract + operator. */
export const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";

/** Neg Risk CTF Exchange V2 — order verifyingContract + operator. */
export const NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";

/** Conditional Tokens (Gnosis CTF, ERC-1155). */
export const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

/** pUSD — V2 collateral token (ERC-20, 6 decimals). */
export const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

/** CollateralOnramp (USDC -> pUSD wrap). */
export const COLLATERAL_ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";

/**
 * NegRiskAdapter — neg-risk redeem target (2-arg redeemPositions).
 * TODO: verify against docs.polymarket.com/resources/contracts before PR (V2/pUSD).
 */
export const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

/** pUSD has 6 decimals. */
export const PUSD_DECIMALS = 6;

/** Scaling factor for 6-decimal amounts (10^6). */
export const PUSD_SCALE = 1_000_000;

// --- EIP-712 order domains + types -------------------------------------------

/** EIP-712 domain for the standard CTF Exchange V2 order signature. */
export const EXCHANGE_DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "2",
  chainId: POLYGON_CHAIN_ID_NUM,
  verifyingContract: CTF_EXCHANGE_V2,
} as const;

/** EIP-712 domain for the neg-risk CTF Exchange V2 order signature. */
export const NEG_RISK_EXCHANGE_DOMAIN = {
  name: "Polymarket Neg Risk CTF Exchange",
  version: "2",
  chainId: POLYGON_CHAIN_ID_NUM,
  verifyingContract: NEG_RISK_EXCHANGE_V2,
} as const;

/**
 * EIP-712 types for the V2 Order struct. Field ordering is load-bearing
 * (the type hash depends on it) and matches Polymarket/ctf-exchange-v2.
 */
export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

// --- EIP-712 ClobAuth (L1) ---------------------------------------------------

/** EIP-712 domain for the L1 ClobAuth credential-derivation signature. */
export const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: POLYGON_CHAIN_ID_NUM,
} as const;

/** EIP-712 types for the ClobAuth struct. */
export const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

/** Fixed message signed for L1 credential derivation. */
export const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";

// --- Order side / signature type ---------------------------------------------

/** Numeric order side as used in the SIGNED EIP-712 struct. */
export const ORDER_SIDE = { BUY: 0, SELL: 1 } as const;

/** signatureType 0 = EOA. */
export const SIGNATURE_TYPE_EOA = 0;

/** bytes32 zero value for metadata/builder defaults. */
export const BYTES32_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Max uint256 (reference only; we prefer exact-amount approvals). */
export const MAX_UINT256 = (2n ** 256n - 1n).toString();

// --- Minimal ABIs ------------------------------------------------------------

/** ERC-20 approve / allowance (pUSD). */
export const ERC20_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** ERC-1155 approval/balance (Conditional Tokens). */
export const ERC1155_ABI = [
  {
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    name: "setApprovalForAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    name: "isApprovedForAll",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** Conditional Tokens redeemPositions (standard binary markets). */
export const CTF_REDEEM_ABI = [
  {
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** NegRiskAdapter redeemPositions (neg-risk markets, 2-arg variant). */
export const NEG_RISK_REDEEM_ABI = [
  {
    inputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "amounts", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
