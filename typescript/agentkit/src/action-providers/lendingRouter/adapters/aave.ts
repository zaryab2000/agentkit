import { Address, encodeFunctionData } from "viem";

import { EvmWalletProvider } from "../../../wallet-providers";
import { AAVE_POOL_ADDRESS, AAVE_POOL_ABI, SUPPORTED_ASSETS } from "../constants";
import { RateResult, PositionResult } from "../utils";

/**
 * Reads live supply or borrow APY from Aave v3 on Base.
 *
 * @param wallet - The wallet provider for contract reads.
 * @param asset - The token symbol to query.
 * @param side - Whether to read supply or borrow rates.
 * @returns The rate result or null if the asset is not supported.
 */
export async function getAaveRates(
  wallet: EvmWalletProvider,
  asset: string,
  side: "supply" | "borrow",
): Promise<RateResult | null> {
  const assetAddress = SUPPORTED_ASSETS[asset.toLowerCase()];
  if (!assetAddress) return null;

  const reserveData = await wallet.readContract({
    address: AAVE_POOL_ADDRESS,
    abi: AAVE_POOL_ABI,
    functionName: "getReserveData",
    args: [assetAddress],
  });

  const rateRay =
    side === "supply" ? reserveData.currentLiquidityRate : reserveData.currentVariableBorrowRate;

  const apr = (Number(rateRay) / 1e27) * 100;

  return {
    protocol: "aave",
    apy: apr,
    marketAddress: AAVE_POOL_ADDRESS,
    source: "on-chain",
    notes: `Aave v3 Pool on Base`,
  };
}

/**
 * Reads the user's Aave v3 position including aggregate collateral, debt, and health factor.
 *
 * @param wallet - The wallet provider for contract reads.
 * @param user - The user address to query.
 * @returns The position result for Aave.
 */
export async function getAavePosition(
  wallet: EvmWalletProvider,
  user: Address,
): Promise<PositionResult> {
  const accountData = await wallet.readContract({
    address: AAVE_POOL_ADDRESS,
    abi: AAVE_POOL_ABI,
    functionName: "getUserAccountData",
    args: [user],
  });

  const totalCollateralUsd = Number(accountData[0]) / 1e8;
  const totalDebtUsd = Number(accountData[1]) / 1e8;
  const healthFactor = Number(accountData[5]) / 1e18;

  return {
    protocol: "aave",
    supplies:
      totalCollateralUsd > 0
        ? [{ asset: "aggregate", balance: "N/A", usdValue: totalCollateralUsd }]
        : [],
    borrows:
      totalDebtUsd > 0 ? [{ asset: "aggregate", balance: "N/A", usdValue: totalDebtUsd }] : [],
    healthFactor: totalDebtUsd > 0 ? healthFactor : Infinity,
    healthSource: "Aave healthFactor (WAD)",
  };
}

/**
 * Encodes calldata for an Aave v3 supply transaction.
 *
 * @param assetAddress - The token address to supply.
 * @param amount - The amount in atomic units.
 * @param onBehalfOf - The address that will own the aToken position.
 * @returns The encoded calldata.
 */
export function encodeAaveSupply(
  assetAddress: Address,
  amount: bigint,
  onBehalfOf: Address,
): `0x${string}` {
  return encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: "supply",
    args: [assetAddress, amount, onBehalfOf, 0],
  });
}

/**
 * Encodes calldata for an Aave v3 variable-rate borrow transaction.
 *
 * @param assetAddress - The token address to borrow.
 * @param amount - The amount in atomic units.
 * @param onBehalfOf - The address that will own the debt position.
 * @returns The encoded calldata.
 */
export function encodeAaveBorrow(
  assetAddress: Address,
  amount: bigint,
  onBehalfOf: Address,
): `0x${string}` {
  return encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: "borrow",
    args: [assetAddress, amount, 2n, 0, onBehalfOf],
  });
}
