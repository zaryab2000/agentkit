# PRD — Claim-And-Restake ActionProvider for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new MIDDLEWARE ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit). **The goal is a PR that Coinbase merges into the official repo.** Self-contained; no access to prior conversations. Re-verify anything graded below `CONFIRMED`. Access date: **2026-06-03**.
> Backing research: `docs-internal/research/MIDDLEWARE_PROTOCOL_RESEARCH.md` (reward-claim mechanics, primary-verified) and `docs-internal/research/AP_MARKET_RESEARCH.md`.
>
> **What this AP is:** a yield-compounding loop — **claim accrued rewards** from lending positions (Compound III, Moonwell, Morpho), optionally **swap** them to a target asset, and **restake/re-supply** into a yield position. Classic agent loop (harvest → swap → redeploy, repeated).
>
> **Two decisive constraints, design around them:**
> 1. **Restake-target collision.** The obvious staking targets **Lido and Beefy already have open PRs** (confirmed 2026-06-03) — do **not** make them the restake leg. Use **non-colliding** targets: re-supply into the *same* lending protocol, a **generic ERC-4626 vault**, or Yearn (wishlisted-but-unbuilt). See §0.6.
> 2. **Morpho reward proofs are off-chain.** Morpho rewards now flow through a **Merkl-style Universal Rewards Distributor**: the claimable amount + **merkle proof must be fetched from an off-chain API** before the on-chain `claim`. (CONFIRMED.)

---

## 0. The merge target: AgentKit conventions (verified against `main`, 2026-06-03)

### 0.1 Toolchain & deps
- Node 22+, pnpm 10.7+; `pnpm install` from `typescript/`. `pnpm test` / `pnpm run lint` / `pnpm run format`. Changeset patch, past-tense. **All commits signed.**
- **Deps baseline:** `zod@^4.3.6` (v4), `viem@2.47.4`, `ethers@^6.13.5` (v6). All chain I/O via viem through the wallet provider.
- **Composes:** lending reward claims (per protocol, below), in-tree `zeroX`/`enso` for the reward→asset swap, and a restake target (§0.6).

### 0.2 File layout
`typescript/agentkit/src/action-providers/claimRestake/`:
```
claimRestake/
├── claimRestakeActionProvider.ts
├── schemas.ts                 # plain z.object().describe(); NO .strip()
├── constants.ts               # CometRewards addr, Morpho URD/Merkl addr + API base, Moonwell comptroller, ERC-4626
├── adapters/
│   ├── compoundRewards.ts      # CometRewards.claim / getRewardOwed
│   ├── morphoRewards.ts        # Merkl/URD claim + proof fetch
│   └── moonwellRewards.ts      # Comptroller claimReward
├── utils.ts                   # reward valuation, gas-vs-reward gate, swap+restake dispatch
├── claimRestakeActionProvider.test.ts   # REQUIRED
├── index.ts
└── README.md                  # REQUIRED
```
Re-export factory from `src/action-providers/index.ts`.

### 0.3 Canonical pattern (verbatim shape from in-repo ERC-721)
```typescript
export class ClaimRestakeActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super("claimRestake", []);
  }

  @CreateAction({
    name: "claim_rewards",
    description: `Claims accrued lending rewards (COMP/WELL/Morpho rewards) for the wallet from a given protocol. For Morpho, fetches the merkle proof from the rewards API first. Returns the claimed token + amount. ...`,
    schema: ClaimRewardsSchema,
  })
  async claimRewards(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ClaimRewardsSchema>,
  ): Promise<string> {
    try {
      return JSON.stringify(result);
    } catch (error) {
      return `Error claiming rewards from ${args.protocol}: ${error}`; // returned, not thrown
    }
  }

  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.chainId === "8453"; // Base-first v1
}

export const claimRestakeActionProvider = () => new ClaimRestakeActionProvider();
```
**Conventions:** extends `ActionProvider<EvmWalletProvider>`; `super("claimRestake", [])`; async `@CreateAction` → `Promise<string>`; errors returned; schemas plain `z.object().describe()`, no `.strip()`; factory + re-export.

### 0.4 Acceptance checklist
- [ ] Actions return `Promise<string>`; errors returned. Zod plain `.describe()`, no `.strip()`.
- [ ] `supportsNetwork` Base-only v1.
- [ ] Tests pass (mirror `pythActionProvider.test.ts`); lint/format clean.
- [ ] README documents the off-chain Morpho proof fetch + the restake-target choice.
- [ ] Changeset (patch). Signed commits. PR template + tracking issue.
- [ ] Naming: dir `claimRestake`, class `ClaimRestakeActionProvider`, factory `claimRestakeActionProvider`, name `"claimRestake"`. Re-exported.

### 0.5 Merge-likelihood — open an issue FIRST (blocking gate)
Composite AP. Maps to WISHLIST "Farm yield" / rewards theme. **Lead with the restake-target choice (§0.6)** so reviewers see you avoided the Lido/Beefy collision. **Do not code until a maintainer responds.**

### 0.6 COLLISION — restake target (decisive)
- **Lido and Beefy have open staking PRs** → do NOT use them as the restake leg.
- **Non-colliding restake targets (use these):** (a) **re-supply into the same lending protocol** (compound the position you claimed from — simplest, zero new protocol surface); (b) a **generic ERC-4626 vault** `deposit(assets, receiver)` (broadly useful, no specific-protocol collision); (c) **Yearn** (wishlisted, unbuilt — higher effort). **Recommend (a) + (b) for v1.**

---

## 1. Executive Summary
Claim-and-restake automates yield compounding: it claims accrued rewards from a lending position, optionally swaps them into a chosen asset via the in-tree `zeroX`/`enso` actions, and redeploys them — re-supplying into the same lending protocol or into a generic ERC-4626 vault. It gates on a gas-vs-reward threshold so it only acts when worthwhile. The agent-suited value is the repeated, conditional harvest loop with valuation and threshold logic; it deliberately avoids the staking targets already covered by open PRs.

## 2. Reward-claim mechanics (primary-source grounded — CONFIRMED)

### 2.1 Compound III (CometRewards)
- `claim(address comet, address src, bool shouldAccrue)` (or `claimTo(comet, src, to, shouldAccrue)` with permission). Preview owed via `getRewardOwed(address comet, address account)` — **NON-view (it mutates)**; call via simulation / `publicClient` static call, do not treat as a plain read. (CONFIRMED — comet/`CometRewards.sol`, docs.compound.finance/protocol-rewards/.) CometRewards address per deployment.

### 2.2 Morpho (Merkl / Universal Rewards Distributor)
- Reward distribution is **Merkl-style URD**. On-chain: distributor `claim(account, reward, claimable, proof[])`. **`claimable` amount + `proof[]` are fetched off-chain from the rewards API** (Merkl/Morpho — exact endpoint graded **STALE**, verify at build; the URD repo is `morpho-org/universal-rewards-distributor`). Leaf double-hashed; verified with OZ `MerkleProof`. (CONFIRMED — morpho-org/universal-rewards-distributor, docs.morpho.org/build/rewards/tutorials/claim-rewards.)

### 2.3 Moonwell
- Comptroller `claimReward(...)` (Compound-v2-fork pattern). (Moonwell `Comptroller.sol`.)

### 2.4 Restake targets (per §0.6)
- Re-supply: Compound `supply`, Moonwell `mint`, Morpho `deposit` (all in-tree). Generic ERC-4626: `approve` + `deposit(uint256 assets, address receiver)`.

## 3. Action-by-Action Spec

### `get_claimable_rewards`
- **Schema:** `{ protocol: enum["compound","moonwell","morpho"], user?: string }`.
- **Behavior:** return claimable reward token + amount (Compound `getRewardOwed` via static call; Morpho via the rewards API; Moonwell via comptroller view). Return JSON; no state change.
- **Edge cases:** zero claimable (return "nothing to claim"); Morpho API down (flag); `getRewardOwed` non-view (must simulate).

### `claim_rewards`
- **Schema:** `{ protocol: enum[...], user?: string }`.
- **Behavior:** execute the protocol's claim (Morpho: fetch proof first). Return claimed token + amount + tx hash.
- **Edge cases:** proof fetch failure (abort cleanly); nothing to claim (no-op).

### `claim_and_restake`
- **Schema:** `{ protocol: enum[...], restakeTarget: enum["same","erc4626"], restakeVault?: string, swapToAsset?: string, slippageBps?: number, minRewardUsd?: number }`.
- **Behavior:** (1) read claimable; (2) **gas-vs-reward gate** — if reward USD < `minRewardUsd` (or < gas × k), return "below threshold, skipped"; (3) claim; (4) optional swap reward→`swapToAsset` via `zeroX`/`enso`; (5) restake into `same` protocol or the `erc4626` vault. Return per-step tx hashes + final position.
- **Edge cases:** partial failure (claimed but restake fails → reward token sits in wallet; report recoverable state); swap slippage; ERC-4626 vault not valid (validate `asset()` matches); reward token == restake asset (skip swap).

## 4. Security Considerations
- **`getRewardOwed` is non-view** — simulate; never trust as a plain read for valuation.
- **Off-chain proof trust (Morpho):** validate the API-returned `claimable`/`proof` shape; the on-chain claim will revert on a bad proof — surface that cleanly.
- **Reward-token slippage** on the swap leg — bound with `slippageBps`, re-quote before executing.
- **Gas-vs-reward threshold** — never restake dust; enforce `minRewardUsd`.
- **Partial-failure state** — claim/swap/restake are separate txs; report per-leg outcomes, never assume full success.
- **ERC-4626 validation** — confirm `vault.asset()` equals the deposited token; reject mismatches.
- **Network guard:** Base-only v1.

## 5. Testing Plan
- Mock per-protocol claim adapters; assert Compound static-call for `getRewardOwed`, Morpho proof-fetch-then-claim ordering, Moonwell comptroller claim.
- Mock the gas-vs-reward gate; assert skip below `minRewardUsd`.
- Mock swap + restake; assert ERC-4626 `asset()` validation and reward==asset skip-swap.
- Assert partial-failure per-leg reporting (claimed-but-not-restaked).
- `supportsNetwork`: true only for `8453`. Mirror `pythActionProvider.test.ts`.

## 6. Open Questions / Gaps
- Morpho/Merkl rewards API exact endpoint + response shape — **STALE**, verify at build.
- Moonwell `claimReward` exact signature/args on Base — confirm against the live comptroller.
- Whether Morpho/Moonwell claim actions should live here or in their own provider extensions (the §2 lending extensions) — coordinate so this AP composes them rather than duplicating; ask in the issue.
- Gas-vs-reward `k` factor default — pick a sensible default (e.g. reward must exceed 5× estimated gas) and make it configurable.
