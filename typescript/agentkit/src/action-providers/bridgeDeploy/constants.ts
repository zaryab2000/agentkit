/**
 * The Across deposit-status API endpoint. Returns structured JSON describing the
 * lifecycle of a cross-chain deposit (status, fill tx, refund tx).
 */
export const ACROSS_DEPOSIT_STATUS_API = "https://app.across.to/api/deposit/status";

/**
 * Default destination chain for the bridge-and-deploy flow (Base mainnet).
 */
export const DEFAULT_DESTINATION_CHAIN_ID = 8453;

/**
 * Destination chains the deploy leg is gated to (Base-first). The origin chain
 * can be any EVM chain Across supports; only these are valid deploy targets.
 */
export const SUPPORTED_DESTINATION_CHAIN_IDS = [
  8453, // Base mainnet
  84532, // Base Sepolia
];

/**
 * The Compound III (Comet) USDC base market on Base mainnet. Provided for
 * convenience/validation; the supply target is supplied per-call.
 */
export const BASE_COMET_USDC = "0xb125E6687d4313864e53df431d5425969c15Eb2F";

/**
 * Minimal ABI for supplying collateral into a Compound III (Comet) market.
 * `supplyTo` credits an explicit recipient (rather than `msg.sender`), so the
 * position can be owned by the configured recipient.
 */
export const COMET_SUPPLY_ABI = [
  {
    inputs: [
      { name: "dst", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "supplyTo",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * Minimal ABI for depositing into an ERC-4626 / MetaMorpho vault.
 */
export const METAMORPHO_DEPOSIT_ABI = [
  {
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "deposit",
    outputs: [{ name: "shares", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
