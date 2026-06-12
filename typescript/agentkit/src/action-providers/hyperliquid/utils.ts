import {
  type AbiParameter,
  type PublicClient,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  formatUnits,
  Hex,
  parseUnits,
} from "viem";
import {
  LIMIT_ORDER_ACTION_HEADER,
  LIMIT_ORDER_PAYLOAD_TYPES,
  PERP_ASSET_INFO_RETURN,
  PERP_PX_DECIMALS,
  POSITION_ARGS,
  POSITION_RETURN,
  PRECOMPILE_PERP_ASSET_INFO,
  PRECOMPILE_POSITION,
  PX_SIZE_SCALE_DECIMALS,
  Tif,
  TIF_ENCODING,
  UINT32_ARG,
  UINT64_RETURN,
  USD_NOTIONAL_DECIMALS,
} from "./constants";

/** Decoded HyperCore perp position (raw integer fields from the position precompile). */
export interface RawPosition {
  szi: bigint;
  entryNtl: bigint;
  isolatedRawUsd: bigint;
  leverage: number;
  isIsolated: boolean;
}

/** Decoded perp asset metadata from the perpAssetInfo precompile. */
export interface PerpAssetInfo {
  coin: string;
  marginTableId: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

/** Human-readable position with computed entry price and unrealized PnL. */
export interface ComputedPosition {
  index: number;
  szi: string;
  size: string;
  isLong: boolean;
  leverage: number;
  isIsolated: boolean;
  /** Raw isolated collateral (int64, HyperCore USD * 1e6) — only meaningful when isIsolated. */
  isolatedRawUsd: string;
  entryNotional: string;
  avgEntryPx: string | null;
  markPx: string;
  unrealizedPnl: string;
}

/**
 * Reads a HyperCore precompile via a raw eth_call. Precompiles take ABI-encoded args with NO
 * function selector, so this uses getPublicClient().call (not readContract, which requires an ABI).
 *
 * @param client - viem public client obtained from the wallet provider
 * @param to - precompile address
 * @param argTypes - ABI parameter types for the input
 * @param args - input argument values
 * @param returnTypes - ABI parameter types for the decoded return
 * @returns the decoded return values (one element per return parameter)
 */
export async function readPrecompile(
  client: PublicClient,
  to: Hex,
  argTypes: readonly AbiParameter[],
  args: readonly unknown[],
  returnTypes: readonly AbiParameter[],
): Promise<readonly unknown[]> {
  const data = encodeAbiParameters(argTypes, args);
  const result = await client.call({ to, data });
  if (!result.data) {
    throw new Error(`Precompile ${to} returned no data`);
  }
  return decodeAbiParameters(returnTypes, result.data);
}

/**
 * Reads a perp position for a user.
 *
 * @param client - viem public client
 * @param user - the EVM address whose HyperCore position to read
 * @param perp - the perp asset index (uint16)
 * @returns the decoded raw position
 */
export async function readPerpPosition(
  client: PublicClient,
  user: Hex,
  perp: number,
): Promise<RawPosition> {
  const [pos] = await readPrecompile(
    client,
    PRECOMPILE_POSITION,
    POSITION_ARGS,
    [user, perp],
    POSITION_RETURN,
  );
  return pos as RawPosition;
}

/**
 * Reads perp asset metadata.
 *
 * @param client - viem public client
 * @param index - the perp asset index (uint32)
 * @returns the decoded perp asset info
 */
export async function readPerpAssetInfo(
  client: PublicClient,
  index: number,
): Promise<PerpAssetInfo> {
  const [info] = await readPrecompile(
    client,
    PRECOMPILE_PERP_ASSET_INFO,
    UINT32_ARG,
    [index],
    PERP_ASSET_INFO_RETURN,
  );
  return info as PerpAssetInfo;
}

/**
 * Reads a uint64 price from a price precompile (markPx / oraclePx).
 *
 * @param client - viem public client
 * @param precompile - the price precompile address
 * @param index - the perp asset index (uint32)
 * @returns the raw uint64 price
 */
export async function readPx(
  client: PublicClient,
  precompile: Hex,
  index: number,
): Promise<bigint> {
  const [px] = await readPrecompile(client, precompile, UINT32_ARG, [index], UINT64_RETURN);
  return px as bigint;
}

/**
 * Converts a raw uint64 perp price into a human-readable decimal string.
 * humanPx = rawPx / 10^(6 - szDecimals).
 *
 * @param rawPx - the raw uint64 price from a precompile
 * @param szDecimals - the asset's size decimals (from perpAssetInfo)
 * @returns the human-readable price as a decimal string
 */
export function convertPx(rawPx: bigint, szDecimals: number): string {
  const exp = PERP_PX_DECIMALS - szDecimals;
  if (exp >= 0) {
    return formatUnits(rawPx, exp);
  }
  return (rawPx * 10n ** BigInt(-exp)).toString();
}

/**
 * Scales a human-readable price or size into the uint64 value CoreWriter expects (humanValue * 1e8).
 *
 * @param value - the positive human-readable price or size
 * @returns the scaled uint64 value as a bigint
 */
export function humanToScaledU64(value: number): bigint {
  const scaled = parseUnits(value.toString(), PX_SIZE_SCALE_DECIMALS);
  if (scaled <= 0n) {
    throw new Error(`Value ${value} scales to a non-positive integer`);
  }
  if (scaled >= 2n ** 64n) {
    throw new Error(`Value ${value} exceeds uint64 range after scaling`);
  }
  return scaled;
}

/**
 * Computes the exact scaled uint64 (value * 1e8) size for fully closing a position, derived from
 * the raw signed size with bigint-safe math (avoids Number precision loss for large int64 sizes).
 *
 * @param szi - the raw signed position size (int64, scaled by szDecimals)
 * @param szDecimals - the asset's size decimals
 * @returns the absolute size scaled to uint64
 */
export function fullCloseSizeU64(szi: bigint, szDecimals: number): bigint {
  const abs = szi < 0n ? -szi : szi;
  return parseUnits(formatUnits(abs, szDecimals), PX_SIZE_SCALE_DECIMALS);
}

/**
 * Formats a scaled uint64 (value * 1e8) back into a human-readable decimal string.
 *
 * @param value - the scaled uint64 value
 * @returns the human-readable decimal string
 */
export function scaledU64ToHuman(value: bigint): string {
  return formatUnits(value, PX_SIZE_SCALE_DECIMALS);
}

/**
 * Maps a time-in-force string to its CoreWriter encoding (Alo=1, Gtc=2, Ioc=3).
 *
 * @param tif - the time-in-force key
 * @returns the encoded tif integer
 */
export function toEncodedTif(tif: Tif): number {
  return TIF_ENCODING[tif];
}

/**
 * Parses an optional client order id into a uint128 bigint. Missing/empty/"0" means no cloid.
 *
 * @param cloid - the client order id as a decimal or 0x-hex string, or null/undefined
 * @returns the cloid as a bigint (0 = none)
 */
export function parseCloid(cloid?: string | null): bigint {
  if (!cloid || cloid === "0") {
    return 0n;
  }
  const value = BigInt(cloid);
  if (value < 0n || value >= 2n ** 128n) {
    throw new Error(`cloid ${cloid} is out of uint128 range`);
  }
  return value;
}

/**
 * Encodes a CoreWriter limit order (action id 1) into the full calldata, including the
 * version + action-id header (0x01000001).
 *
 * @param asset - perp asset index (uint32)
 * @param isBuy - true for buy/long, false for sell/short
 * @param limitPxU64 - limit price scaled to uint64 (human * 1e8)
 * @param szU64 - size scaled to uint64 (human * 1e8)
 * @param reduceOnly - whether the order may only reduce an existing position
 * @param encodedTif - encoded time-in-force (Alo=1, Gtc=2, Ioc=3)
 * @param cloidU128 - client order id (0 = none)
 * @returns the CoreWriter sendRawAction calldata
 */
export function encodeLimitOrder(
  asset: number,
  isBuy: boolean,
  limitPxU64: bigint,
  szU64: bigint,
  reduceOnly: boolean,
  encodedTif: number,
  cloidU128: bigint,
): Hex {
  const payload = encodeAbiParameters(LIMIT_ORDER_PAYLOAD_TYPES, [
    asset,
    isBuy,
    limitPxU64,
    szU64,
    reduceOnly,
    encodedTif,
    cloidU128,
  ]);
  return concat([LIMIT_ORDER_ACTION_HEADER, payload]);
}

/**
 * Computes human-readable size, entry price, and unrealized PnL for a raw position.
 * Size de-scales by szDecimals; USD notional de-scales by 1e6.
 *
 * @param index - the perp asset index (for labelling)
 * @param raw - the decoded raw position
 * @param markPxRaw - the raw uint64 mark price
 * @param szDecimals - the asset's size decimals
 * @returns the computed, human-readable position
 */
export function computePosition(
  index: number,
  raw: RawPosition,
  markPxRaw: bigint,
  szDecimals: number,
): ComputedPosition {
  // De-scale the raw integer fields with bigint-safe formatUnits (int64 can exceed 2^53), then
  // parse to Number only for the derived display metrics (avgEntryPx / PnL).
  const sizeStr = formatUnits(raw.szi, szDecimals);
  const entryNotionalStr = formatUnits(raw.entryNtl, USD_NOTIONAL_DECIMALS);
  const markStr = convertPx(markPxRaw, szDecimals);

  const sizeHuman = Number(sizeStr);
  const entryNotional = Number(entryNotionalStr);
  const markHuman = Number(markStr);
  const isZero = raw.szi === 0n;
  const avgEntryPx = isZero ? null : entryNotional / Math.abs(sizeHuman);
  const unrealizedPnl = isZero ? 0 : sizeHuman * markHuman - Math.sign(sizeHuman) * entryNotional;

  return {
    index,
    szi: raw.szi.toString(),
    size: sizeStr,
    isLong: raw.szi > 0n,
    leverage: raw.leverage,
    isIsolated: raw.isIsolated,
    isolatedRawUsd: raw.isolatedRawUsd.toString(),
    entryNotional: entryNotionalStr,
    avgEntryPx: avgEntryPx === null ? null : avgEntryPx.toString(),
    markPx: markStr,
    unrealizedPnl: unrealizedPnl.toString(),
  };
}

/**
 * Validates that a value is an integer within an unsigned-integer range.
 *
 * @param value - the value to validate
 * @param bits - the unsigned-integer width (e.g. 16 or 32)
 * @param label - a label used in the error message
 */
export function assertUintInRange(value: number, bits: number, label: string): void {
  const max = 2 ** bits - 1;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be an integer in [0, ${max}], got ${value}`);
  }
}

/**
 * Validates that a string is a well-formed 20-byte EVM address.
 *
 * @param address - the address to validate
 * @param label - a label used in the error message
 */
export function assertAddress(address: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${label} is not a valid EVM address: ${address}`);
  }
}
