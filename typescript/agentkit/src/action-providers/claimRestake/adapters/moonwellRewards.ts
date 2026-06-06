import { Address, encodeFunctionData } from "viem";

import { EvmWalletProvider } from "../../../wallet-providers";
import {
  MOONWELL_COMPTROLLER_ABI,
  MOONWELL_COMPTROLLER_ADDRESS,
  MOONWELL_WELL_TOKEN,
} from "../constants";
import { ClaimableReward, getErc20Decimals, getErc20Symbol } from "../utils";

/**
 * Reads the claimable Moonwell reward for an account.
 *
 * Moonwell distributes via a MultiRewardDistributor; a cheap on-chain preview
 * is not exposed by the comptroller, so v1 surfaces a clear limitation rather
 * than a fabricated amount and points the caller at claim_rewards (PRD §6).
 *
 * @param wallet - The wallet provider.
 * @param account - The account to read rewards for.
 * @returns The claimable reward (amount unknown for Moonwell in v1).
 */
export async function getMoonwellClaimable(
  wallet: EvmWalletProvider,
  account: Address,
): Promise<ClaimableReward & { previewUnavailable: true }> {
  void account;
  const decimals = await getErc20Decimals(wallet, MOONWELL_WELL_TOKEN);
  const symbol = await getErc20Symbol(wallet, MOONWELL_WELL_TOKEN);
  return {
    token: MOONWELL_WELL_TOKEN,
    symbol,
    amount: 0n,
    decimals,
    previewUnavailable: true,
  };
}

/**
 * Claims Moonwell rewards for an account via the comptroller.
 *
 * @param wallet - The wallet provider.
 * @param account - The account to claim rewards for.
 * @returns The reward token plus the claim transaction hash.
 */
export async function claimMoonwell(
  wallet: EvmWalletProvider,
  account: Address,
): Promise<{ reward: ClaimableReward; txHash: string }> {
  const decimals = await getErc20Decimals(wallet, MOONWELL_WELL_TOKEN);
  const symbol = await getErc20Symbol(wallet, MOONWELL_WELL_TOKEN);

  const data = encodeFunctionData({
    abi: MOONWELL_COMPTROLLER_ABI,
    functionName: "claimReward",
    args: [account],
  });

  const txHash = await wallet.sendTransaction({ to: MOONWELL_COMPTROLLER_ADDRESS, data });
  await wallet.waitForTransactionReceipt(txHash);

  return {
    reward: { token: MOONWELL_WELL_TOKEN, symbol, amount: 0n, decimals },
    txHash,
  };
}
