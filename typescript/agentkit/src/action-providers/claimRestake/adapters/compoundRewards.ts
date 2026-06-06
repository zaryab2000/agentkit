import { Address, encodeFunctionData } from "viem";

import { EvmWalletProvider } from "../../../wallet-providers";
import { COMET_REWARDS_ABI, COMET_REWARDS_ADDRESS, COMPOUND_COMET_ADDRESS } from "../constants";
import { ClaimableReward, getErc20Decimals, getErc20Symbol } from "../utils";

/**
 * Reads the claimable Compound III reward for an account.
 *
 * getRewardOwed is NON-view, so it is read via a static simulation rather than
 * a plain contract read (PRD §2.1 / §4).
 *
 * @param wallet - The wallet provider.
 * @param account - The account to read rewards for.
 * @returns The claimable reward.
 */
export async function getCompoundClaimable(
  wallet: EvmWalletProvider,
  account: Address,
): Promise<ClaimableReward> {
  const { result } = await wallet.getPublicClient().simulateContract({
    address: COMET_REWARDS_ADDRESS,
    abi: COMET_REWARDS_ABI,
    functionName: "getRewardOwed",
    args: [COMPOUND_COMET_ADDRESS, account],
    account,
  });

  const token = result.token as Address;
  const amount = result.owed as bigint;
  const decimals = await getErc20Decimals(wallet, token);
  const symbol = await getErc20Symbol(wallet, token);

  return { token, symbol, amount, decimals };
}

/**
 * Claims Compound III rewards for an account.
 *
 * @param wallet - The wallet provider.
 * @param account - The account to claim rewards for.
 * @returns The reward claimed plus the claim transaction hash.
 */
export async function claimCompound(
  wallet: EvmWalletProvider,
  account: Address,
): Promise<{ reward: ClaimableReward; txHash: string }> {
  const reward = await getCompoundClaimable(wallet, account);

  const data = encodeFunctionData({
    abi: COMET_REWARDS_ABI,
    functionName: "claim",
    args: [COMPOUND_COMET_ADDRESS, account, true],
  });

  const txHash = await wallet.sendTransaction({ to: COMET_REWARDS_ADDRESS, data });
  await wallet.waitForTransactionReceipt(txHash);

  return { reward, txHash };
}
