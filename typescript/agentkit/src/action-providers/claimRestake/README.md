# Claim-and-Restake Action Provider

This directory contains the `ClaimRestakeActionProvider` for compounding lending yield on **Base mainnet**. It automates the classic agent loop: **claim** accrued rewards from a lending position, optionally **swap** them into a target asset, and **restake** the proceeds back into a yield position — gated by a gas-vs-reward threshold so it only acts when worthwhile.

## Supported protocols

| Protocol     | Reward    | Preview (`get_claimable_rewards`)                          | Claim mechanism                                              |
| ------------ | --------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Compound III | COMP      | `CometRewards.getRewardOwed` via **static simulation**¹   | `CometRewards.claim(comet, src, true)`                      |
| Morpho       | varies    | Off-chain **rewards API** (claimable + merkle proof)²     | Universal Rewards Distributor `claim(account, reward, claimable, proof[])` |
| Moonwell     | WELL      | Not available on-chain — call `claim_rewards`³            | Comptroller `claimReward(holder)`                           |

¹ `getRewardOwed` is **non-view** (it mutates accrual state), so it is read with a `simulateContract` static call, never as a plain read.

² Morpho rewards flow through a Merkl-style Universal Rewards Distributor: the **claimable amount and merkle proof are fetched off-chain** before the on-chain claim. The exact endpoint/response shape is verified at build time (see the `TODO(verify-at-build)` markers in `constants.ts` and `adapters/morphoRewards.ts`). A missing/empty proof aborts the claim cleanly. The API-provided distributor address is validated (well-formed, and — once `KNOWN_MORPHO_URD_ADDRESSES` is seeded — checked against the trusted allowlist) before any transaction is sent. **v1 claims only the first distribution per call.**

³ Moonwell distributes through a MultiRewardDistributor with no cheap on-chain preview, so v1 surfaces a clear limitation instead of a fabricated amount.

## Restake targets

To avoid colliding with the existing open Lido/Beefy staking PRs, the restake leg uses **non-colliding** targets:

- **`same`** — re-supply into Compound III (`Comet.supply`). Supported for Compound in v1. The token being restaked must be the Comet market's **base asset** (e.g. USDC) — supplying any other token reverts on-chain, so the provider reads `Comet.baseToken()` and rejects a mismatch up front. Set `swapToAsset` to the base asset to swap the reward first.
- **`erc4626`** — deposit into any generic ERC-4626 vault (`deposit(assets, receiver)`), after validating that the vault's `asset()` matches the token being deposited. Use this for Morpho/Moonwell vaults.

## Actions

- **`get_claimable_rewards`** — reads the claimable reward token + amount. No state change.
- **`claim_rewards`** — claims the protocol's rewards (Morpho fetches the proof first). Returns token, amount and tx hash.
- **`claim_and_restake`** — reads the reward, applies the **gas-vs-reward gate** (skips when the reward is below `minRewardUsd` or below a multiple of the estimated gas cost), claims, optionally swaps the reward into `swapToAsset` via the in-tree 0x action, and restakes. Each leg is a separate transaction; on a partial failure the result reports what was already claimed/swapped so funds are recoverable.

## Notes

- **Network:** Base mainnet only (`chainId === "8453"`) for v1.
- **Swap leg:** the optional swap composes the in-tree 0x provider and requires `ZEROX_API_KEY` in the environment; without it the swap leg returns a clear, non-throwing error and the claimed reward remains in the wallet.
- **Valuation:** reward/gas USD values use the public DefiLlama price API (no key required).
- **Errors are returned, never thrown.**
