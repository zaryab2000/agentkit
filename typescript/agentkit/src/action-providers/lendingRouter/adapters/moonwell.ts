import { Address, encodeFunctionData, formatUnits } from "viem";

import { EvmWalletProvider } from "../../../wallet-providers";
import {
  MOONWELL_MTOKEN_ADDRESSES,
  MOONWELL_MTOKEN_ABI,
  MOONWELL_COMPTROLLER_ADDRESS,
  MOONWELL_COMPTROLLER_ABI,
  MOONWELL_UNDERLYING_DECIMALS,
  SECONDS_PER_YEAR_NUMBER,
} from "../constants";
import { RateResult, PositionResult } from "../utils";

/**
 * Looks up the Moonwell mToken address for a given asset symbol.
 *
 * @param asset - The token symbol to look up.
 * @returns The mToken address or null if not found.
 */
function getMTokenAddress(asset: string): Address | null {
  return MOONWELL_MTOKEN_ADDRESSES[asset.toLowerCase()] ?? null;
}

/**
 * Reads live supply or borrow APY from a Moonwell mToken on Base.
 *
 * @param wallet - The wallet provider for contract reads.
 * @param asset - The token symbol to query.
 * @param side - Whether to read supply or borrow rates.
 * @returns The rate result or null if the asset has no mToken.
 */
export async function getMoonwellRates(
  wallet: EvmWalletProvider,
  asset: string,
  side: "supply" | "borrow",
): Promise<RateResult | null> {
  const mToken = getMTokenAddress(asset);
  if (!mToken) return null;

  const rateFn = side === "supply" ? "supplyRatePerTimestamp" : "borrowRatePerTimestamp";
  const ratePerSecond = await wallet.readContract({
    address: mToken,
    abi: MOONWELL_MTOKEN_ABI,
    functionName: rateFn,
  });

  const apr = (Number(ratePerSecond) * SECONDS_PER_YEAR_NUMBER) / 1e18;

  return {
    protocol: "moonwell",
    apy: apr * 100,
    marketId: mToken,
    source: "on-chain",
    notes: `Moonwell mToken on Base`,
  };
}

/**
 * Reads the user's Moonwell position including supplies, borrows, and health.
 *
 * @param wallet - The wallet provider for contract reads.
 * @param user - The user address to query.
 * @returns The position result for Moonwell.
 */
export async function getMoonwellPosition(
  wallet: EvmWalletProvider,
  user: Address,
): Promise<PositionResult> {
  const liquidityResult = await wallet.readContract({
    address: MOONWELL_COMPTROLLER_ADDRESS,
    abi: MOONWELL_COMPTROLLER_ABI,
    functionName: "getAccountLiquidity",
    args: [user],
  });

  const error = Number(liquidityResult[0]);
  const liquidity = Number(liquidityResult[1]) / 1e18;
  const shortfall = Number(liquidityResult[2]) / 1e18;

  let healthFactor = Infinity;
  if (shortfall > 0) {
    healthFactor = 0;
  } else if (liquidity > 0) {
    // Moonwell returns USD surplus, not a ratio — store raw surplus
    healthFactor = liquidity;
  }

  const supplies: Array<{ asset: string; balance: string; usdValue: number }> = [];
  const borrows: Array<{ asset: string; balance: string; usdValue: number }> = [];

  for (const [symbol, mToken] of Object.entries(MOONWELL_MTOKEN_ADDRESSES)) {
    const decimals = MOONWELL_UNDERLYING_DECIMALS[symbol] ?? 18;
    try {
      const supplyBal = await wallet.readContract({
        address: mToken,
        abi: MOONWELL_MTOKEN_ABI,
        functionName: "balanceOfUnderlying",
        args: [user],
      });
      if (supplyBal > 0n) {
        supplies.push({
          asset: symbol.toUpperCase(),
          balance: formatUnits(supplyBal, decimals),
          usdValue: 0,
        });
      }

      const borrowBal = await wallet.readContract({
        address: mToken,
        abi: MOONWELL_MTOKEN_ABI,
        functionName: "borrowBalanceCurrent",
        args: [user],
      });
      if (borrowBal > 0n) {
        borrows.push({
          asset: symbol.toUpperCase(),
          balance: formatUnits(borrowBal, decimals),
          usdValue: 0,
        });
      }
    } catch {
      // skip tokens that fail
    }
  }

  return {
    protocol: "moonwell",
    supplies,
    borrows,
    healthFactor,
    healthSource:
      error === 0 ? "Comptroller liquidity surplus (USD, not a ratio)" : "error reading liquidity",
    healthComparable: false,
  };
}

/**
 * Encodes calldata for a Moonwell mToken mint (supply) transaction.
 *
 * @param amount - The amount in atomic units.
 * @returns The encoded calldata.
 */
export function encodeMoonwellMint(amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: MOONWELL_MTOKEN_ABI,
    functionName: "mint",
    args: [amount],
  });
}
