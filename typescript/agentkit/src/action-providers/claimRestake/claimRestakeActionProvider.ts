import { z } from "zod";
import { Address, formatUnits } from "viem";

import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { EvmWalletProvider } from "../../wallet-providers";
import { Network } from "../../network";

import { ClaimAndRestakeSchema, ClaimRewardsSchema, GetClaimableRewardsSchema } from "./schemas";
import { BASE_MAINNET_CHAIN_ID } from "./constants";
import {
  ClaimableReward,
  evaluateGate,
  getErc20Balance,
  resolveAccount,
  restakeIntoCompound,
  restakeIntoErc4626,
  swapReward,
  validateErc4626,
} from "./utils";
import { claimCompound, getCompoundClaimable } from "./adapters/compoundRewards";
import { claimMorpho, getMorphoClaimable } from "./adapters/morphoRewards";
import { claimMoonwell, getMoonwellClaimable } from "./adapters/moonwellRewards";

/**
 * ClaimRestakeActionProvider automates the yield-compounding loop: claim
 * accrued lending rewards (Compound III, Moonwell, Morpho), optionally swap
 * them into a target asset, and restake the proceeds into the same protocol or
 * a generic ERC-4626 vault. Base mainnet only for v1.
 */
export class ClaimRestakeActionProvider extends ActionProvider<EvmWalletProvider> {
  /**
   * Constructs a new ClaimRestakeActionProvider instance.
   */
  constructor() {
    super("claimRestake", []);
  }

  /**
   * Reads the currently claimable reward for a wallet on a given protocol.
   *
   * @param walletProvider - The wallet provider.
   * @param args - The action arguments.
   * @returns A JSON string describing the claimable reward, or an error string.
   */
  @CreateAction({
    name: "get_claimable_rewards",
    description: `
Reads the currently claimable lending reward (token + amount) for a wallet, without changing on-chain state.

It takes:
- protocol: one of 'compound' (Compound III / COMP), 'moonwell' (WELL) or 'morpho' (Morpho rewards via the off-chain rewards API)
- user: (optional) the address to check; defaults to the connected wallet

Notes:
- Compound's getRewardOwed is non-view, so it is read via a static simulation.
- Morpho amounts/proofs come from the off-chain rewards API.
- Moonwell does not expose a cheap on-chain preview; it will indicate that you should call claim_rewards to realize WELL rewards.
Returns JSON with the reward token, symbol and human-readable amount.`,
    schema: GetClaimableRewardsSchema,
  })
  async getClaimableRewards(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof GetClaimableRewardsSchema>,
  ): Promise<string> {
    try {
      const account = resolveAccount(walletProvider, args.user);

      if (args.protocol === "moonwell") {
        const reward = await getMoonwellClaimable(walletProvider, account);
        return JSON.stringify({
          success: true,
          protocol: args.protocol,
          token: reward.token,
          symbol: reward.symbol,
          previewAvailable: false,
          message:
            "Moonwell on-chain preview is not available; call claim_rewards to realize WELL rewards.",
        });
      }

      const reward =
        args.protocol === "compound"
          ? await getCompoundClaimable(walletProvider, account)
          : await getMorphoClaimable(walletProvider, account);

      if (reward.amount <= 0n) {
        return JSON.stringify({
          success: true,
          protocol: args.protocol,
          claimable: false,
          message: "nothing to claim",
        });
      }

      return JSON.stringify({
        success: true,
        protocol: args.protocol,
        claimable: true,
        token: reward.token,
        symbol: reward.symbol,
        amount: formatUnits(reward.amount, reward.decimals),
      });
    } catch (error) {
      return `Error reading claimable rewards from ${args.protocol}: ${error}`;
    }
  }

  /**
   * Claims accrued rewards for a wallet from a given protocol.
   *
   * @param walletProvider - The wallet provider.
   * @param args - The action arguments.
   * @returns A JSON string describing the claim, or an error string.
   */
  @CreateAction({
    name: "claim_rewards",
    description: `
Claims accrued lending rewards (COMP / WELL / Morpho rewards) for the wallet from a given protocol.

It takes:
- protocol: one of 'compound', 'moonwell' or 'morpho'
- user: (optional) the address to claim for; defaults to the connected wallet

Notes:
- For 'morpho', the merkle proof is fetched from the off-chain rewards API before the on-chain claim; a missing proof aborts cleanly.
- Returns JSON with the claimed token, amount (when known) and transaction hash.`,
    schema: ClaimRewardsSchema,
  })
  async claimRewards(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ClaimRewardsSchema>,
  ): Promise<string> {
    try {
      const account = resolveAccount(walletProvider, args.user);
      const { reward, txHash } = await this.dispatchClaim(walletProvider, args.protocol, account);

      return JSON.stringify({
        success: true,
        protocol: args.protocol,
        token: reward.token,
        symbol: reward.symbol,
        amount: reward.amount > 0n ? formatUnits(reward.amount, reward.decimals) : undefined,
        txHash,
      });
    } catch (error) {
      return `Error claiming rewards from ${args.protocol}: ${error}`;
    }
  }

  /**
   * Claims, optionally swaps, and restakes rewards in one gated loop.
   *
   * @param walletProvider - The wallet provider.
   * @param args - The action arguments.
   * @returns A JSON string describing each leg, or an error string.
   */
  @CreateAction({
    name: "claim_and_restake",
    description: `
Harvests lending rewards and compounds them: reads the claimable reward, applies a gas-vs-reward threshold gate, claims, optionally swaps the reward into a target asset, and restakes the proceeds.

It takes:
- protocol: one of 'compound', 'moonwell' or 'morpho'
- restakeTarget: 'same' (re-supply into Compound III) or 'erc4626' (deposit into the vault given by restakeVault)
- restakeVault: (required for 'erc4626') the vault address; its asset() must match the token being deposited
- swapToAsset: (optional) token address to swap the reward into before restaking; requires ZEROX_API_KEY in the environment
- slippageBps: (optional) max swap slippage in basis points (default 100)
- minRewardUsd: (optional) skip the loop if the reward is worth less than this many USD

Notes:
- The gate skips dust: it requires the reward to exceed both minRewardUsd and a multiple of the estimated gas cost.
- Legs are separate transactions; if a later leg fails the report shows what was already claimed/swapped so funds are recoverable.
- restakeTarget 'same' is supported for Compound in v1; use 'erc4626' for Morpho/Moonwell vaults.
Returns JSON with per-leg results.`,
    schema: ClaimAndRestakeSchema,
  })
  async claimAndRestake(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ClaimAndRestakeSchema>,
  ): Promise<string> {
    const steps: Record<string, unknown> = { protocol: args.protocol };

    try {
      const account = resolveAccount(walletProvider);

      // 1. Preview + gas-vs-reward gate (skipped for Moonwell, which has no preview).
      const preview = await this.previewReward(walletProvider, args.protocol, account);
      if (preview) {
        const gate = await evaluateGate(walletProvider, preview, args.minRewardUsd);
        steps.gate = { rewardUsd: gate.rewardUsd, gasUsd: gate.gasUsd, reason: gate.reason };
        if (gate.skip) {
          return JSON.stringify({ success: true, skipped: true, ...steps });
        }
      }

      // 2. Determine the reward token and record the pre-claim balance.
      const rewardToken = preview
        ? preview.token
        : (await getMoonwellClaimable(walletProvider, account)).token;
      const balanceBeforeClaim = await getErc20Balance(walletProvider, rewardToken, account);

      // 3. Claim.
      const claimResult = await this.dispatchClaim(walletProvider, args.protocol, account);
      steps.claim = { token: rewardToken, txHash: claimResult.txHash };

      const balanceAfterClaim = await getErc20Balance(walletProvider, rewardToken, account);
      const received = balanceAfterClaim - balanceBeforeClaim;
      if (received <= 0n) {
        return JSON.stringify({
          success: true,
          claimedNothing: true,
          message: "Claim succeeded but no reward tokens were received; nothing to restake.",
          ...steps,
        });
      }

      // 4. Optional swap.
      let restakeToken = rewardToken;
      let restakeAmount = received;
      const rewardDecimals = preview?.decimals ?? 18;

      if (args.swapToAsset && args.swapToAsset.toLowerCase() !== rewardToken.toLowerCase()) {
        const targetToken = args.swapToAsset as Address;
        const balanceBeforeSwap = await getErc20Balance(walletProvider, targetToken, account);

        const swapOutcome = await swapReward(walletProvider, {
          sellToken: rewardToken,
          buyToken: targetToken,
          sellAmount: formatUnits(received, rewardDecimals),
          slippageBps: args.slippageBps,
        });
        steps.swap = { from: rewardToken, to: targetToken, outcome: swapOutcome };

        if (swapOutcome.startsWith("Error")) {
          return JSON.stringify({
            success: false,
            recoverable: true,
            message: "Reward claimed but swap failed; reward tokens remain in the wallet.",
            ...steps,
          });
        }

        const balanceAfterSwap = await getErc20Balance(walletProvider, targetToken, account);
        restakeAmount = balanceAfterSwap - balanceBeforeSwap;
        restakeToken = targetToken;

        if (restakeAmount <= 0n) {
          return JSON.stringify({
            success: false,
            recoverable: true,
            message: "Swap reported success but no target tokens were received; nothing restaked.",
            ...steps,
          });
        }
      }

      // 5. Restake.
      const restakeTxHash = await this.dispatchRestake(
        walletProvider,
        args,
        restakeToken,
        restakeAmount,
      );
      steps.restake = { target: args.restakeTarget, token: restakeToken, txHash: restakeTxHash };

      return JSON.stringify({ success: true, ...steps });
    } catch (error) {
      return JSON.stringify({
        success: false,
        recoverable: true,
        message: `claim_and_restake failed: ${error}`,
        ...steps,
      });
    }
  }

  /**
   * Checks if the network is supported (Base mainnet only for v1).
   *
   * @param network - The network to check.
   * @returns True if supported.
   */
  supportsNetwork = (network: Network): boolean =>
    network.protocolFamily === "evm" && network.chainId === BASE_MAINNET_CHAIN_ID;

  /**
   * Previews the claimable reward for the gate, or null when no preview exists.
   *
   * @param wallet - The wallet provider.
   * @param protocol - The protocol to preview.
   * @param account - The account to preview for.
   * @returns The previewed reward, or null (Moonwell).
   */
  private async previewReward(
    wallet: EvmWalletProvider,
    protocol: "compound" | "moonwell" | "morpho",
    account: Address,
  ): Promise<ClaimableReward | null> {
    if (protocol === "compound") {
      return getCompoundClaimable(wallet, account);
    }
    if (protocol === "morpho") {
      return getMorphoClaimable(wallet, account);
    }
    return null;
  }

  /**
   * Dispatches the claim leg to the protocol-specific adapter.
   *
   * @param wallet - The wallet provider.
   * @param protocol - The protocol to claim from.
   * @param account - The account to claim for.
   * @returns The claimed reward plus transaction hash.
   */
  private async dispatchClaim(
    wallet: EvmWalletProvider,
    protocol: "compound" | "moonwell" | "morpho",
    account: Address,
  ): Promise<{ reward: ClaimableReward; txHash: string }> {
    switch (protocol) {
      case "compound":
        return claimCompound(wallet, account);
      case "morpho":
        return claimMorpho(wallet, account);
      case "moonwell":
        return claimMoonwell(wallet, account);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }

  /**
   * Dispatches the restake leg to the chosen target.
   *
   * @param wallet - The wallet provider.
   * @param args - The claim-and-restake arguments.
   * @param token - The token to restake.
   * @param amount - The atomic amount to restake.
   * @returns The restake transaction hash.
   */
  private async dispatchRestake(
    wallet: EvmWalletProvider,
    args: z.infer<typeof ClaimAndRestakeSchema>,
    token: Address,
    amount: bigint,
  ): Promise<string> {
    if (args.restakeTarget === "erc4626") {
      if (!args.restakeVault) {
        throw new Error("restakeVault is required when restakeTarget is 'erc4626'");
      }
      const vault = args.restakeVault as Address;
      const validationError = await validateErc4626(wallet, vault, token);
      if (validationError) {
        throw new Error(validationError);
      }
      return restakeIntoErc4626(wallet, vault, token, amount);
    }

    // restakeTarget === "same"
    if (args.protocol !== "compound") {
      throw new Error(
        `restakeTarget 'same' is only supported for Compound in v1; use 'erc4626' with a vault for ${args.protocol}`,
      );
    }
    return restakeIntoCompound(wallet, token, amount);
  }
}

/**
 * Factory function to create a new ClaimRestakeActionProvider instance.
 *
 * @returns A new ClaimRestakeActionProvider instance.
 */
export const claimRestakeActionProvider = (): ClaimRestakeActionProvider =>
  new ClaimRestakeActionProvider();
