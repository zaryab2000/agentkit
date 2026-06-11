import { Address, encodeFunctionData, erc20Abi, formatUnits } from "viem";

import { EvmWalletProvider } from "../../wallet-providers";
import { approve } from "../../utils";
import { ZeroXActionProvider } from "../zeroX/zeroXActionProvider";
import {
  COMET_SUPPLY_ABI,
  COMPOUND_COMET_ADDRESS,
  DEFAULT_GAS_MULTIPLE,
  DEFILLAMA_PRICE_API_BASE,
  ERC4626_ABI,
  GAS_UNITS_ESTIMATE,
} from "./constants";

/**
 * A claimable (or claimed) reward, normalized across protocols.
 */
export interface ClaimableReward {
  /** The reward token contract address. */
  token: Address;
  /** The reward token symbol (best-effort). */
  symbol: string;
  /** The reward amount in atomic units. */
  amount: bigint;
  /** The reward token decimals. */
  decimals: number;
}

/**
 * Reads an ERC-20 token's decimals.
 *
 * @param wallet - The wallet provider.
 * @param token - The token address.
 * @returns The token decimals.
 */
export async function getErc20Decimals(wallet: EvmWalletProvider, token: Address): Promise<number> {
  const decimals = await wallet.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return Number(decimals);
}

/**
 * Reads an ERC-20 token's symbol, returning "UNKNOWN" on failure.
 *
 * @param wallet - The wallet provider.
 * @param token - The token address.
 * @returns The token symbol.
 */
export async function getErc20Symbol(wallet: EvmWalletProvider, token: Address): Promise<string> {
  try {
    return await wallet.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    });
  } catch {
    return "UNKNOWN";
  }
}

/**
 * Reads an ERC-20 token balance for an account.
 *
 * @param wallet - The wallet provider.
 * @param token - The token address.
 * @param account - The account to read the balance of.
 * @returns The balance in atomic units.
 */
export async function getErc20Balance(
  wallet: EvmWalletProvider,
  token: Address,
  account: Address,
): Promise<bigint> {
  return wallet.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

/**
 * Resolves the target account: the provided user, or the wallet address.
 *
 * @param wallet - The wallet provider.
 * @param user - An optional user address override.
 * @returns The resolved account address.
 */
export function resolveAccount(wallet: EvmWalletProvider, user?: string): Address {
  return (user ?? wallet.getAddress()) as Address;
}

/**
 * Fetches the USD price of a token on Base from the DefiLlama public API.
 *
 * @param token - The token address on Base.
 * @returns The USD price, or null if unavailable.
 */
export async function getTokenUsdPrice(token: Address): Promise<number | null> {
  const key = `base:${token}`;
  const response = await fetch(`${DEFILLAMA_PRICE_API_BASE}/${key}`);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  const price = data?.coins?.[key]?.price;
  return typeof price === "number" ? price : null;
}

/**
 * Fetches the USD price of ETH from the DefiLlama public API.
 *
 * @returns The USD price of ETH, or null if unavailable.
 */
export async function getEthUsdPrice(): Promise<number | null> {
  const key = "coingecko:ethereum";
  const response = await fetch(`${DEFILLAMA_PRICE_API_BASE}/${key}`);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  const price = data?.coins?.[key]?.price;
  return typeof price === "number" ? price : null;
}

/**
 * Result of the gas-vs-reward gate evaluation.
 */
export interface GateResult {
  /** Whether the loop should be skipped. */
  skip: boolean;
  /** A human-readable reason for the decision. */
  reason: string;
  /** The estimated reward value in USD (null if it could not be priced). */
  rewardUsd: number | null;
  /** The estimated gas cost in USD (null if it could not be priced). */
  gasUsd: number | null;
}

/**
 * Evaluates whether a reward clears the gas-vs-reward threshold.
 *
 * Skips when the reward is zero, below the explicit minRewardUsd floor, or
 * below DEFAULT_GAS_MULTIPLE times the estimated gas cost.
 *
 * @param wallet - The wallet provider (used to read gas price).
 * @param reward - The claimable reward.
 * @param minRewardUsd - Optional explicit USD floor.
 * @returns The gate decision.
 */
export async function evaluateGate(
  wallet: EvmWalletProvider,
  reward: ClaimableReward,
  minRewardUsd?: number,
): Promise<GateResult> {
  if (reward.amount <= 0n) {
    return { skip: true, reason: "nothing to claim", rewardUsd: 0, gasUsd: null };
  }

  const rewardPrice = await getTokenUsdPrice(reward.token);
  const rewardHuman = Number(formatUnits(reward.amount, reward.decimals));
  const rewardUsd = rewardPrice === null ? null : rewardHuman * rewardPrice;

  // Estimate gas cost in USD.
  let gasUsd: number | null = null;
  try {
    const gasPrice = await wallet.getPublicClient().getGasPrice();
    const ethPrice = await getEthUsdPrice();
    if (ethPrice !== null) {
      const gasEth = Number(formatUnits(gasPrice * GAS_UNITS_ESTIMATE, 18));
      gasUsd = gasEth * ethPrice;
    }
  } catch {
    gasUsd = null;
  }

  // If the reward can't be priced, do not silently let it through when the
  // caller set an explicit floor — skip so the floor is respected.
  if (rewardUsd === null) {
    if (minRewardUsd !== undefined) {
      return {
        skip: true,
        reason: `reward could not be priced; skipping to respect minRewardUsd $${minRewardUsd.toFixed(2)}`,
        rewardUsd: null,
        gasUsd,
      };
    }
    return {
      skip: false,
      reason: "reward could not be priced; no floor set",
      rewardUsd: null,
      gasUsd,
    };
  }

  const floor = minRewardUsd ?? 0;
  if (rewardUsd !== null && rewardUsd < floor) {
    return {
      skip: true,
      reason: `reward $${rewardUsd.toFixed(2)} below minRewardUsd $${floor.toFixed(2)}`,
      rewardUsd,
      gasUsd,
    };
  }

  if (rewardUsd !== null && gasUsd !== null && rewardUsd < gasUsd * DEFAULT_GAS_MULTIPLE) {
    return {
      skip: true,
      reason: `reward $${rewardUsd.toFixed(2)} below ${DEFAULT_GAS_MULTIPLE}x estimated gas $${gasUsd.toFixed(2)}`,
      rewardUsd,
      gasUsd,
    };
  }

  return { skip: false, reason: "reward clears threshold", rewardUsd, gasUsd };
}

/**
 * Validates that an ERC-4626 vault's underlying asset matches the deposit token.
 *
 * @param wallet - The wallet provider.
 * @param vault - The ERC-4626 vault address.
 * @param token - The token intended for deposit.
 * @returns An error string if invalid, or null if the vault is valid.
 */
export async function validateErc4626(
  wallet: EvmWalletProvider,
  vault: Address,
  token: Address,
): Promise<string | null> {
  const asset = (await wallet.readContract({
    address: vault,
    abi: ERC4626_ABI,
    functionName: "asset",
  })) as Address;

  if (asset.toLowerCase() !== token.toLowerCase()) {
    return `ERC-4626 vault ${vault} expects asset ${asset}, but the token to deposit is ${token}`;
  }
  return null;
}

/**
 * Re-supplies a token into the Compound III market (restakeTarget "same").
 *
 * @param wallet - The wallet provider.
 * @param token - The token to supply.
 * @param amount - The atomic amount to supply.
 * @returns The supply transaction hash.
 */
export async function restakeIntoCompound(
  wallet: EvmWalletProvider,
  token: Address,
  amount: bigint,
): Promise<string> {
  // The Compound III market only earns supply yield on its base asset; supplying
  // any other token (e.g. the raw COMP reward) reverts on-chain. Guard up front
  // and tell the caller to swap to the base asset first.
  const baseToken = (await wallet.readContract({
    address: COMPOUND_COMET_ADDRESS,
    abi: COMET_SUPPLY_ABI,
    functionName: "baseToken",
  })) as Address;

  if (token.toLowerCase() !== baseToken.toLowerCase()) {
    throw new Error(
      `restakeTarget 'same' for Compound requires the base asset ${baseToken}, but got ${token}. ` +
        `Set swapToAsset to ${baseToken} to swap the reward before restaking.`,
    );
  }

  const approval = await approve(wallet, token, COMPOUND_COMET_ADDRESS, amount);
  if (approval.startsWith("Error")) {
    throw new Error(approval);
  }

  const data = encodeFunctionData({
    abi: COMET_SUPPLY_ABI,
    functionName: "supply",
    args: [token, amount],
  });

  const txHash = await wallet.sendTransaction({ to: COMPOUND_COMET_ADDRESS, data });
  await wallet.waitForTransactionReceipt(txHash);
  return txHash;
}

/**
 * Deposits a token into a generic ERC-4626 vault (restakeTarget "erc4626").
 *
 * @param wallet - The wallet provider.
 * @param vault - The ERC-4626 vault address.
 * @param token - The token to deposit.
 * @param amount - The atomic amount to deposit.
 * @returns The deposit transaction hash.
 */
export async function restakeIntoErc4626(
  wallet: EvmWalletProvider,
  vault: Address,
  token: Address,
  amount: bigint,
): Promise<string> {
  const approval = await approve(wallet, token, vault, amount);
  if (approval.startsWith("Error")) {
    throw new Error(approval);
  }

  const data = encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: "deposit",
    args: [amount, wallet.getAddress() as Address],
  });

  const txHash = await wallet.sendTransaction({ to: vault, data });
  await wallet.waitForTransactionReceipt(txHash);
  return txHash;
}

/**
 * Swaps a reward token into a target asset via the in-tree 0x action provider.
 *
 * Reads the 0x API key from the ZEROX_API_KEY environment variable; returns an
 * error string (never throws) when the key is missing so the caller can report
 * a recoverable state.
 *
 * @param wallet - The wallet provider.
 * @param params - The swap parameters.
 * @param params.sellToken - The reward token address to sell.
 * @param params.buyToken - The target token address to buy.
 * @param params.sellAmount - The human-readable amount to sell.
 * @param params.slippageBps - Optional max slippage in basis points.
 * @returns The 0x executeSwap result string.
 */
export async function swapReward(
  wallet: EvmWalletProvider,
  params: { sellToken: string; buyToken: string; sellAmount: string; slippageBps?: number },
): Promise<string> {
  let provider: ZeroXActionProvider;
  try {
    provider = new ZeroXActionProvider({});
  } catch {
    return "Error: swap requested but ZEROX_API_KEY is not configured";
  }

  return provider.executeSwap(wallet, {
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount,
    slippageBps: params.slippageBps ?? 100,
    swapFeeRecipient: null,
    swapFeeBps: 100,
  });
}
