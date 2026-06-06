import { Address, formatUnits } from "viem";

import { EvmWalletProvider } from "../../../wallet-providers";
import {
  COMPOUND_COMET_ADDRESSES,
  COMPOUND_COMET_ABI,
  SECONDS_PER_YEAR_NUMBER,
  ERC20_ABI,
} from "../constants";
import { RateResult, PositionResult } from "../utils";

const PRICE_FEED_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Resolves the Comet address for a given base asset.
 *
 * @param asset - The token symbol (e.g. "usdc", "weth").
 * @returns The Comet address or null if no Comet exists for this asset.
 */
function getCometForAsset(asset: string): Address | null {
  return COMPOUND_COMET_ADDRESSES[asset.toLowerCase()] ?? null;
}

/**
 * Reads live supply or borrow APY from the Compound III Comet for the given base asset.
 *
 * @param wallet - The wallet provider for contract reads.
 * @param asset - The token symbol to query (must be a Comet base asset like USDC or WETH).
 * @param side - Whether to read supply or borrow rates.
 * @returns The rate result or null if no Comet exists for this asset.
 */
export async function getCompoundRates(
  wallet: EvmWalletProvider,
  asset: string,
  side: "supply" | "borrow",
): Promise<RateResult | null> {
  const cometAddress = getCometForAsset(asset);
  if (!cometAddress) return null;

  const utilization = await wallet.readContract({
    address: cometAddress,
    abi: COMPOUND_COMET_ABI,
    functionName: "getUtilization",
  });

  const rateFn = side === "supply" ? "getSupplyRate" : "getBorrowRate";
  const ratePerSecond = await wallet.readContract({
    address: cometAddress,
    abi: COMPOUND_COMET_ABI,
    functionName: rateFn,
    args: [utilization],
  });

  const apr = (Number(ratePerSecond) * SECONDS_PER_YEAR_NUMBER) / 1e18;

  return {
    protocol: "compound",
    apy: apr * 100,
    marketId: cometAddress,
    source: "on-chain",
    notes: `Comet ${asset.toUpperCase()} market, utilization ${((Number(utilization) / 1e18) * 100).toFixed(2)}%`,
  };
}

/**
 * Reads the user's Compound III position across all known Comets.
 *
 * @param wallet - The wallet provider for contract reads.
 * @param user - The user address to query.
 * @returns The position result for Compound.
 */
export async function getCompoundPosition(
  wallet: EvmWalletProvider,
  user: Address,
): Promise<PositionResult> {
  const supplies: Array<{ asset: string; balance: string; usdValue: number }> = [];
  const borrows: Array<{ asset: string; balance: string; usdValue: number }> = [];
  let totalSupplyUsd = 0;
  let totalBorrowUsd = 0;

  for (const [baseAsset, cometAddress] of Object.entries(COMPOUND_COMET_ADDRESSES)) {
    try {
      const borrowBalance = await wallet.readContract({
        address: cometAddress,
        abi: COMPOUND_COMET_ABI,
        functionName: "borrowBalanceOf",
        args: [user],
      });

      const baseToken = await wallet.readContract({
        address: cometAddress,
        abi: COMPOUND_COMET_ABI,
        functionName: "baseToken",
      });

      const baseDecimals = Number(
        await wallet.readContract({
          address: baseToken,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
      );

      const numAssets = await wallet.readContract({
        address: cometAddress,
        abi: COMPOUND_COMET_ABI,
        functionName: "numAssets",
      });

      for (let i = 0; i < numAssets; i++) {
        const assetInfo = await wallet.readContract({
          address: cometAddress,
          abi: COMPOUND_COMET_ABI,
          functionName: "getAssetInfo",
          args: [i],
        });

        const collateral = await wallet.readContract({
          address: cometAddress,
          abi: COMPOUND_COMET_ABI,
          functionName: "collateralBalanceOf",
          args: [user, assetInfo.asset],
        });

        if (collateral > 0n) {
          const decimals = Number(
            await wallet.readContract({
              address: assetInfo.asset,
              abi: ERC20_ABI,
              functionName: "decimals",
            }),
          );
          const symbol = await wallet.readContract({
            address: assetInfo.asset,
            abi: ERC20_ABI,
            functionName: "symbol",
          });
          const priceRaw = await wallet.readContract({
            address: cometAddress,
            abi: COMPOUND_COMET_ABI,
            functionName: "getPrice",
            args: [assetInfo.priceFeed],
          });
          const price = Number(priceRaw) / 1e8;
          const humanBalance = Number(formatUnits(collateral, decimals));
          const usdValue = humanBalance * price;
          totalSupplyUsd += usdValue;
          supplies.push({ asset: String(symbol), balance: humanBalance.toFixed(6), usdValue });
        }
      }

      if (borrowBalance > 0n) {
        const basePriceFeed = await wallet.readContract({
          address: cometAddress,
          abi: COMPOUND_COMET_ABI,
          functionName: "baseTokenPriceFeed",
        });
        const basePriceData = await wallet.readContract({
          address: basePriceFeed,
          abi: PRICE_FEED_ABI,
          functionName: "latestRoundData",
        });
        const basePrice = Number(basePriceData[1]) / 1e8;
        const humanBorrow = Number(formatUnits(borrowBalance, baseDecimals));
        const borrowUsd = humanBorrow * basePrice;
        totalBorrowUsd += borrowUsd;
        borrows.push({
          asset: baseAsset.toUpperCase(),
          balance: humanBorrow.toFixed(6),
          usdValue: borrowUsd,
        });
      }
    } catch {
      // skip comets that fail
    }
  }

  let healthFactor = Infinity;
  if (totalBorrowUsd > 0 && totalSupplyUsd > 0) {
    healthFactor = totalSupplyUsd / totalBorrowUsd;
  }

  return {
    protocol: "compound",
    supplies,
    borrows,
    healthFactor,
    healthSource: "collateral-value / borrow-value",
    healthComparable: true,
  };
}
