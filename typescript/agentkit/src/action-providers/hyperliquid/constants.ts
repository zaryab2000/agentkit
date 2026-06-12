import { type AbiParameter, Hex } from "viem";

/**
 * Constants for the Hyperliquid action provider.
 *
 * All chain I/O targets HyperEVM (chainId 999 mainnet / 998 testnet): raw eth_call to the
 * HyperCore read precompiles, and transactions to the CoreWriter system contract. See README.md
 * for the HyperEVM <-> HyperCore async boundary.
 */

/** HyperEVM mainnet chain id (string, matching AgentKit's Network.chainId). */
export const HYPEREVM_MAINNET_CHAIN_ID = "999";

/** HyperEVM testnet chain id. */
export const HYPEREVM_TESTNET_CHAIN_ID = "998";

/**
 * HyperEVM mainnet JSON-RPC endpoint. Reference only — the wallet provider supplies the client.
 *
 * @internal
 */
export const HYPEREVM_MAINNET_RPC_URL = "https://rpc.hyperliquid.xyz/evm";

/**
 * HyperEVM testnet JSON-RPC endpoint. Reference only — the wallet provider supplies the client.
 *
 * @internal
 */
export const HYPEREVM_TESTNET_RPC_URL = "https://rpc.hyperliquid-testnet.xyz/evm";

// --- HyperCore read precompiles (HyperEVM -> HyperCore reads) -----------------------------------

/** position(address user, uint16 perp) -> Position. */
export const PRECOMPILE_POSITION = "0x0000000000000000000000000000000000000800" as Hex;

/** markPx(uint32 index) -> uint64. */
export const PRECOMPILE_MARK_PX = "0x0000000000000000000000000000000000000806" as Hex;

/** oraclePx(uint32 index) -> uint64. */
export const PRECOMPILE_ORACLE_PX = "0x0000000000000000000000000000000000000807" as Hex;

/** perpAssetInfo(uint32 perp) -> PerpAssetInfo. */
export const PRECOMPILE_PERP_ASSET_INFO = "0x000000000000000000000000000000000000080a" as Hex;

// --- CoreWriter (HyperEVM -> HyperCore writes) --------------------------------------------------

/**
 * CoreWriter system contract. Its sole entry point is the Solidity function
 * `sendRawAction(bytes data)` (there is no fallback), so writes must be sent as a normal ABI
 * function call (selector + ABI-encoded `bytes` argument), not as bare action bytes. The action
 * bytes (version + action id + payload) are the ARGUMENT to that function.
 */
export const CORE_WRITER_ADDRESS = "0x3333333333333333333333333333333333333333" as Hex;

/** Minimal ABI for the CoreWriter entry point. */
export const CORE_WRITER_ABI = [
  {
    type: "function",
    name: "sendRawAction",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * CoreWriter action header for a limit order: version byte 0x01 followed by the 3-byte big-endian
 * action id (1). The ABI-encoded payload is appended after this header.
 */
export const LIMIT_ORDER_ACTION_HEADER = "0x01000001" as Hex;

/** limitPx and sz are sent to CoreWriter as uint64(round(humanValue * 1e8)). */
export const PX_SIZE_SCALE_DECIMALS = 8;

/** Perp price decimal base: humanPx = rawPx / 10^(6 - szDecimals). */
export const PERP_PX_DECIMALS = 6;

/** HyperCore USD notional decimal base: humanNotional = entryNtl / 10^6. */
export const USD_NOTIONAL_DECIMALS = 6;

/** Time-in-force encoding for CoreWriter limit orders. */
export const TIF_ENCODING = { Alo: 1, Gtc: 2, Ioc: 3 } as const;

/** Time-in-force keys accepted by the schemas. */
export type Tif = keyof typeof TIF_ENCODING;

/**
 * Async-settlement disclaimer appended to every write action's response. CoreWriter actions are
 * queued and executed on HyperCore after a few-second delay; a successful EVM transaction does NOT
 * mean the order filled.
 */
export const ASYNC_SETTLEMENT_NOTE =
  "Order submitted to CoreWriter. Settlement on HyperCore is asynchronous (a few-second delay) " +
  "and non-atomic: a successful EVM transaction does NOT mean the order filled. " +
  "Poll get_positions to confirm.";

// --- ABI parameter tuples for raw precompile/CoreWriter encoding/decoding ------------------------

/** Input args for the position precompile: (address user, uint16 perp). */
export const POSITION_ARGS: readonly AbiParameter[] = [{ type: "address" }, { type: "uint16" }];

/** Return tuple for the position precompile (decode as a single tuple). */
export const POSITION_RETURN: readonly AbiParameter[] = [
  {
    type: "tuple",
    components: [
      { name: "szi", type: "int64" },
      { name: "entryNtl", type: "uint64" },
      { name: "isolatedRawUsd", type: "int64" },
      { name: "leverage", type: "uint32" },
      { name: "isIsolated", type: "bool" },
    ],
  },
];

/**
 * Return tuple for the perpAssetInfo precompile. NOTE: this struct contains a dynamic field
 * (string coin), so it MUST be decoded as a tuple (not flattened parameters).
 */
export const PERP_ASSET_INFO_RETURN: readonly AbiParameter[] = [
  {
    type: "tuple",
    components: [
      { name: "coin", type: "string" },
      { name: "marginTableId", type: "uint32" },
      { name: "szDecimals", type: "uint8" },
      { name: "maxLeverage", type: "uint8" },
      { name: "onlyIsolated", type: "bool" },
    ],
  },
];

/** Input arg for markPx/oraclePx/perpAssetInfo precompiles: (uint32 index). */
export const UINT32_ARG: readonly AbiParameter[] = [{ type: "uint32" }];

/** Return for markPx/oraclePx precompiles: (uint64). */
export const UINT64_RETURN: readonly AbiParameter[] = [{ type: "uint64" }];

/** CoreWriter limit-order (action id 1) payload tuple. */
export const LIMIT_ORDER_PAYLOAD_TYPES: readonly AbiParameter[] = [
  { type: "uint32" }, // asset
  { type: "bool" }, // isBuy
  { type: "uint64" }, // limitPx (human * 1e8)
  { type: "uint64" }, // sz (human * 1e8)
  { type: "bool" }, // reduceOnly
  { type: "uint8" }, // encodedTif
  { type: "uint128" }, // cloid (0 = none)
];
