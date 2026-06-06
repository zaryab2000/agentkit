import { Address, encodeFunctionData, Hex } from "viem";

import { EvmWalletProvider } from "../../../wallet-providers";
import { BASE_MAINNET_CHAIN_ID, MORPHO_REWARDS_API_BASE, MORPHO_URD_ABI } from "../constants";
import { ClaimableReward } from "../utils";

/**
 * A single Morpho distribution as returned by the off-chain rewards API,
 * normalized to the fields this adapter relies on.
 *
 * TODO(verify-at-build): the exact endpoint + response shape is graded STALE in
 * the PRD (§6); re-verify against docs.morpho.org before the upstream PR.
 */
export interface MorphoDistribution {
  /** The reward token. */
  asset: { address: Address; symbol?: string; decimals?: number };
  /** The Universal Rewards Distributor holding the reward. */
  distributor: { address: Address };
  /** The cumulative claimable amount, in atomic units (string). */
  claimable: string;
  /** The merkle proof for the claim. */
  proof: Hex[];
}

/**
 * Fetches the claimable Morpho distributions for an account from the off-chain
 * rewards API, filtered to Base mainnet.
 *
 * @param account - The account to fetch rewards for.
 * @returns The list of claimable distributions.
 */
export async function fetchMorphoDistributions(account: Address): Promise<MorphoDistribution[]> {
  const url = `${MORPHO_REWARDS_API_BASE}/v1/users/${account}/distributions?chain_id=${BASE_MAINNET_CHAIN_ID}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Morpho rewards API error: HTTP ${response.status}`);
  }

  const body = await response.json();
  const rows: unknown[] = Array.isArray(body?.data) ? body.data : [];

  return rows
    .map(row => row as Partial<MorphoDistribution>)
    .filter(
      (row): row is MorphoDistribution =>
        !!row.asset?.address &&
        !!row.distributor?.address &&
        typeof row.claimable === "string" &&
        Array.isArray(row.proof),
    );
}

/**
 * Reads the total claimable Morpho reward for an account (first distribution).
 *
 * @param wallet - The wallet provider (unused; kept for adapter symmetry).
 * @param account - The account to read rewards for.
 * @returns The claimable reward.
 */
export async function getMorphoClaimable(
  wallet: EvmWalletProvider,
  account: Address,
): Promise<ClaimableReward> {
  void wallet;
  const distributions = await fetchMorphoDistributions(account);
  if (distributions.length === 0) {
    return {
      token: "0x0000000000000000000000000000000000000000",
      symbol: "NONE",
      amount: 0n,
      decimals: 18,
    };
  }

  const top = distributions[0];
  return {
    token: top.asset.address,
    symbol: top.asset.symbol ?? "UNKNOWN",
    amount: BigInt(top.claimable),
    decimals: top.asset.decimals ?? 18,
  };
}

/**
 * Claims the first available Morpho distribution for an account, fetching the
 * merkle proof from the off-chain API before submitting the on-chain claim.
 *
 * @param wallet - The wallet provider.
 * @param account - The account to claim rewards for.
 * @returns The reward claimed plus the claim transaction hash.
 */
export async function claimMorpho(
  wallet: EvmWalletProvider,
  account: Address,
): Promise<{ reward: ClaimableReward; txHash: string }> {
  const distributions = await fetchMorphoDistributions(account);
  if (distributions.length === 0) {
    throw new Error("nothing to claim");
  }

  const top = distributions[0];
  if (!top.proof || top.proof.length === 0) {
    throw new Error("Morpho rewards API returned an empty merkle proof");
  }

  const data = encodeFunctionData({
    abi: MORPHO_URD_ABI,
    functionName: "claim",
    args: [account, top.asset.address, BigInt(top.claimable), top.proof],
  });

  const txHash = await wallet.sendTransaction({ to: top.distributor.address, data });
  await wallet.waitForTransactionReceipt(txHash);

  return {
    reward: {
      token: top.asset.address,
      symbol: top.asset.symbol ?? "UNKNOWN",
      amount: BigInt(top.claimable),
      decimals: top.asset.decimals ?? 18,
    },
    txHash,
  };
}
