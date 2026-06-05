# PRD — Best-Rate Lending Router ActionProvider for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new MIDDLEWARE ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit), the open-source TypeScript monorepo. **The goal is a PR that Coinbase merges into the official repo.** This document is self-contained: it carries every convention, address, method signature, and acceptance criterion you need. You do **not** have access to prior conversations. Where a value is graded below `CONFIRMED`, re-verify it against the cited primary source before relying on it. Access date for all sources: **2026-06-03**.
> Prior research backing this PRD: `docs-internal/research/MIDDLEWARE_PROTOCOL_RESEARCH.md` (protocol mechanics, all primary-verified) and `docs-internal/research/AP_MARKET_RESEARCH.md` (market/collision context). Installed-AP collision baseline: `docs-internal/research/GROUND_TRUTH_INVENTORY.md`.
>
> **What this AP is:** a cross-protocol lending router. It reads **live supply & borrow APY and health** across Compound III, Morpho, Moonwell, and Aave v3 on Base, tells the agent the best venue, and routes supply/borrow/rebalance to it. This is genuinely agent-suited (real-time multi-protocol decisioning a static script can't easily do) and **has no colliding open PR** (the crowded lane is *swap* routers, not *lending* routers — confirmed 2026-06-03).
>
> **One decisive dependency, design around it:** the per-protocol borrow/repay/claim/health *actions* for Morpho and Moonwell **do not exist in AgentKit yet** (only Compound has borrow/repay today). This router must therefore (a) implement its own **direct contract reads** for rates/health (it cannot rely on actions that don't exist), and (b) **phase execution**: ship v1 routing over the protocols whose supply/borrow are reachable today, expand as the §2 lending extensions land. See §3.

---

## 0. The merge target: AgentKit conventions (authoritative, verified against the repo `main`, 2026-06-03)

### 0.1 Toolchain & deps
- **Node.js v22.x+**, **pnpm 10.7.x+**, Turborepo. Run all commands from the `typescript/` monorepo root. `pnpm install` first.
- Tests: `pnpm test` (jest). Lint: `pnpm run lint` / `lint:fix`. Format: `pnpm run format`.
- Changelog: `pnpm run changeset` → package `@coinbase/agentkit`, type **patch**, past-tense summary, e.g. *"Added a best-rate lending router action provider."*
- **All commits MUST be signed** (`git commit -S`) — hard merge gate (`cb-heimdall` CI rejects unsigned).
- **Repo dependency baseline (verified in `typescript/agentkit/package.json`):** `zod@^4.3.6` (Zod v4), `viem@2.47.4`, `ethers@^6.13.5` (ethers v6). Write against these majors. **All on-chain reads/writes go through viem via the wallet provider.** Pin any new dependency to an exact version (no `^`).

### 0.2 Required file layout
`typescript/agentkit/src/action-providers/lendingRouter/`:
```
lendingRouter/
├── lendingRouterActionProvider.ts   # provider class + @CreateAction methods
├── schemas.ts                       # Zod schemas (plain z.object().describe(); NO .strip())
├── constants.ts                     # per-protocol Base addresses, ABIs, rate-scaling constants
├── adapters/                        # one read/exec adapter per protocol
│   ├── compound.ts                  # getSupplyRate/getBorrowRate/getUtilization/getHealthRatio
│   ├── aave.ts                      # getReserveData / getUserAccountData
│   ├── moonwell.ts                  # supplyRatePerTimestamp / borrowRatePerTimestamp
│   └── morpho.ts                    # GraphQL APY + on-chain position health
├── utils.ts                         # APY annualization, best-venue selection, USD pricing
├── lendingRouterActionProvider.test.ts  # jest unit tests (REQUIRED)
├── index.ts
└── README.md                        # per-provider README (REQUIRED)
```
Re-export the factory from `typescript/agentkit/src/action-providers/index.ts`.

### 0.3 Canonical provider pattern (verbatim shape from the in-repo ERC-721 example)
```typescript
// schemas.ts — match LIVE house style: every field .describe(); object .describe(); NO .strip()
const CompareRatesSchema = z
  .object({
    asset: z.string().describe("The token symbol or address to compare lending rates for (e.g. 'USDC')"),
    side: z.enum(["supply", "borrow"]).describe("Whether to compare supply (lend) APY or borrow APY"),
  })
  .describe("Compare live lending rates for an asset across supported protocols on Base");

// provider
export class LendingRouterActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super("lendingRouter", []);
  }

  @CreateAction({
    name: "compare_lending_rates",
    description: `Reads live supply/borrow APY for an asset across Compound, Aave, Moonwell, and Morpho on Base ...`,
    schema: CompareRatesSchema,
  })
  async compareLendingRates(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CompareRatesSchema>,
  ): Promise<string> {
    try {
      // ... read rates via adapters, rank, return a JSON string
      return JSON.stringify(ranked);
    } catch (error) {
      return `Error comparing lending rates for ${args.asset}: ${error}`;   // errors RETURNED, not thrown
    }
  }

  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.chainId === "8453"; // Base mainnet (Network.chainId is string)
}

export const lendingRouterActionProvider = () => new LendingRouterActionProvider();
```
**Non-negotiable conventions:** class extends `ActionProvider<EvmWalletProvider>`; `super("lendingRouter", [])`; every action is `async`, `@CreateAction`-decorated, returns `Promise<string>`; **errors caught and returned as strings (never thrown)**; schemas plain `z.object().describe()` with `.describe()` on every field and **no `.strip()`**; `supportsNetwork` arrow property; factory export; re-export from `src/action-providers/index.ts`. Decorators need `experimentalDecorators`+`emitDecoratorMetadata` (already on).

### 0.4 Acceptance checklist
- [ ] All actions return `Promise<string>`; errors returned not thrown.
- [ ] Zod schemas plain `z.object().describe()`, every field `.describe()`, no `.strip()`.
- [ ] `supportsNetwork` Base mainnet only (`chainId === "8453"`) for v1.
- [ ] Unit tests pass (`pnpm test`), mirror `pythActionProvider.test.ts`; lint/format clean.
- [ ] Per-provider `README.md`.
- [ ] Changeset (patch, past tense). Signed commits. PR template filled. Tracking issue linked.
- [ ] Naming: dir `lendingRouter`, class `LendingRouterActionProvider`, factory `lendingRouterActionProvider`, name string `"lendingRouter"`.
- [ ] Re-exported from `src/action-providers/index.ts`.

### 0.5 Merge-likelihood — open an issue FIRST (blocking gate)
This is a **composite/middleware** AP — confirm maintainers want middleware in-tree (most existing APs are single-protocol). **Open a GitHub issue first** describing: the router scope, that it composes existing in-tree lending providers + direct reads, the Base-only surface, and the agent-suited justification (live cross-protocol rate decisioning). **No colliding lending-router PR exists** (the EZ-Path PRs are *swap* routers — different lane). Map to WISHLIST's "Other Networks / borrow-lend" theme loosely. **Do not write code until a maintainer responds.** If maintainers decline middleware in-tree, pivot to a standalone community package.

---

## 1. Executive Summary
A best-rate lending router that gives an AgentKit agent live, cross-protocol lending intelligence and execution on Base: **compare supply/borrow APY** across Compound III, Aave v3, Moonwell, and Morpho; **read aggregated position health**; **route a supply or borrow to the best venue**; and **suggest/execute a rebalance** when rates drift. Reads are direct on-chain (viem) + Morpho's GraphQL API; execution composes existing in-tree lending actions where they exist (Compound today) and direct contract calls otherwise. The core value — picking the optimal venue from real-time rates and re-checking health before moving funds — is exactly the cross-protocol decisioning a deterministic script handles poorly.

## 2. Protocol Background (primary-source grounded; all on Base mainnet 8453 — CONFIRMED)

### 2.1 Rate reads (annualize all per-second rates with **SECONDS_PER_YEAR = 31,536,000**)
- **Compound III (Comet):** `getUtilization() → uint`, then `getSupplyRate(uint utilization) → uint64` and `getBorrowRate(uint utilization) → uint64`. Returns are **per-second, scaled 1e18**. APR = `rate × 31_536_000 / 1e18`. (CONFIRMED — docs.compound.finance/interest-rates/.) Per-market Comet address (one per base asset, e.g. USDC on Base).
- **Aave v3:** `IPool.getReserveData(address asset)` returns a **struct** (`DataTypes.ReserveData`/`ReserveDataLegacy`) — decode it; the supply rate is `currentLiquidityRate`, variable borrow is `currentVariableBorrowRate`, both in **RAY (1e27)** as per-second-APR-in-RAY (convert per Aave's RAY math). Pool on Base: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` (CONFIRMED, bgd-labs/aave-address-book `AaveV3Base.sol`). ⚠️ **Decode the struct — do not expect flat scalar returns;** verify field order against the live `IPool.sol`/`DataTypes.sol`.
- **Moonwell (Compound-v2 fork, MToken):** `supplyRatePerTimestamp() → uint` and `borrowRatePerTimestamp() → uint` — **per-second (timestamp-based), NOT per-block**. Annualize with SECONDS_PER_YEAR. (CONFIRMED — Moonwell `MToken.sol`.)
- **Morpho Blue / MetaMorpho:** APY is **NOT a clean on-chain getter** — fetch vault/market APY from the **GraphQL API `https://api.morpho.org/graphql`** (Morpho's recommended path), or compute from the market's IRM + state. (CONFIRMED — docs.morpho.org/build/earn/tutorials/get-data/.) Morpho Blue on Base: `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`.

### 2.2 Health / liquidation reads
- **Compound III:** health-ratio logic **already exists** in the in-tree `compound/utils.js` (`getHealthRatio`, `getHealthRatioAfterBorrow`, `getHealthRatioAfterWithdraw`, `getCollateralBalance`) — reuse/port it.
- **Aave v3:** `IPool.getUserAccountData(address user)` → `healthFactor` in **WAD (1e18)**; `< 1e18` = liquidatable. (CONFIRMED.)
- **Moonwell:** Comptroller `getAccountLiquidity(account) → (error, liquidity, shortfall)`.
- **Morpho Blue:** compute per-position health from `position(marketId, user)` + market LLTV + oracle price (on-chain; confirm formula at build — GAP).

### 2.3 USD pricing (for cross-asset comparisons & rebalance math)
Use an in-tree source: **Pyth** (`pyth` AP) or **Alchemy `token_prices`** (`alchemy` AP), or **DeFiLlama coin-prices API** (`docs.llama.fi/coin-prices-api`). Recommend Pyth/Alchemy (already in-tree).

### 2.4 Aggregator read option
DeFiLlama yields / vaults.fyi can supply cross-protocol APY for the **compare** decision, but **execute against on-chain reads** to avoid acting on stale aggregator data.

## 3. Phasing (because §2 Morpho/Moonwell borrow actions don't exist yet)
- **READS (`compare_lending_rates`, `get_aggregated_position`)** work for **all four protocols today** — they're direct contract/GraphQL reads this AP owns. Ship full.
- **EXECUTION (`route_supply`, `route_borrow`, `rebalance`)**:
  - **v1 (today):** execute on **Compound** (has supply/borrow/withdraw/repay in-tree) and **Aave** (port from the Python aave provider's surface via direct calls) and **supply-only** on Morpho/Moonwell (their `deposit`/`mint` exist).
  - **v2 (after §2 extensions land):** add Morpho/Moonwell borrow/repay routing.
- The PR description must state this phasing explicitly so reviewers see the read/execute split.

## 4. Action-by-Action Spec (return `Promise<string>`, errors returned)

### `compare_lending_rates`
- **Schema:** `{ asset: string, side: "supply"|"borrow" }`.
- **Behavior:** read live APY for `asset`/`side` from each protocol's adapter (Compound/Aave/Moonwell on-chain; Morpho GraphQL), annualize, rank, return JSON `[{protocol, apy, marketAddress, source, notes}]` sorted best-first.
- **Edge cases:** asset not listed on a protocol (omit with a note); GraphQL timeout (return on-chain protocols + flag Morpho unavailable); never block the whole comparison on one failing source.

### `get_aggregated_position`
- **Schema:** `{ user?: string (default wallet) }`.
- **Behavior:** read the user's supply/borrow balances + health on each protocol; return a JSON portfolio view (per-protocol position, health factor, and an aggregate "lowest health across protocols" warning).
- **Edge cases:** no position (return empty + note); per-protocol health units differ (normalize and label).

### `route_supply`
- **Schema:** `{ asset: string, amount: string, preferProtocol?: string }`.
- **Behavior:** call `compare_lending_rates(supply)`; pick the best venue (or honor `preferProtocol`); ensure allowance; execute the supply (Compound/Aave/Morpho/Moonwell adapter). Return tx hash + chosen venue + the APY it routed to.
- **Edge cases:** insufficient balance (preflight); allowance preflight per token/protocol; best-venue tie (deterministic tiebreak); mis-routing guard (re-read rate immediately before executing).

### `route_borrow`  *(v1: Compound/Aave only — see §3)*
- **Schema:** `{ asset: string, amount: string, preferProtocol?: string }`.
- **Behavior:** compare borrow APY; **re-read health on the chosen protocol and simulate post-borrow health** (must stay above a safe threshold — reject if it would approach liquidation); execute borrow. Return tx hash + venue + new health factor.
- **Edge cases:** post-borrow health below threshold (reject with the projected number); protocol lacks borrow action in-tree (skip in v1, document).

### `rebalance`  *(advisory in v1; execution gated on §3 phasing)*
- **Schema:** `{ asset: string, minApyImprovementBps?: number (default 50) }`.
- **Behavior:** detect a supply position earning materially less than the current best venue (> `minApyImprovementBps`); **return a plan** (withdraw from A → supply to B, with gas/slippage estimate). Execute only if both legs are available in-tree and the improvement clears the threshold after costs.
- **Edge cases:** improvement doesn't clear gas cost (advise no-op); withdrawing would breach health on A (block); the move is not atomic across protocols (sequence + verify each leg).

## 5. Security Considerations
- **Mis-routing:** rates and utilization move; **re-read the chosen venue's rate immediately before executing**, not just at compare time.
- **Health before borrow/withdraw:** always simulate post-action health (Compound `getHealthRatioAfterBorrow` pattern; Aave `getUserAccountData`); reject actions that approach liquidation.
- **Allowance scoping:** per-protocol approvals; prefer exact-amount over MAX_UINT where feasible; document the tradeoff.
- **Non-atomic rebalance:** cross-protocol moves are multi-tx; on a mid-sequence failure, funds may sit idle on one protocol — return a clear recoverable state, never leave the agent assuming success.
- **Aggregator staleness:** if DeFiLlama/vaults.fyi is used for compare, never execute solely on it — confirm with an on-chain read.
- **Network guard:** `supportsNetwork` Base-only for v1.

## 6. Testing Plan
- Mock `walletProvider.readContract` / `getPublicClient().call` to return per-protocol rate/health structs; assert annualization (per-second × 31,536,000 / 1e18 for Comet/Moonwell; RAY math for Aave) and ranking.
- Mock the Morpho GraphQL fetch; assert graceful degradation when it fails.
- Mock USD price source; assert allocation/health math.
- `route_borrow`: assert it rejects when projected health < threshold.
- `supportsNetwork`: true only for `8453`.
- Mirror `pythActionProvider.test.ts` structure.

## 7. Open Questions / Gaps (resolve before merge)
- Aave `getReserveData` exact struct field order on Base — verify against live `IPool.sol`/`DataTypes.sol`. (The earlier research verifier wrongly killed the "returns a struct" claim — it DOES return a struct.)
- Morpho Blue per-position health formula (LLTV + oracle) — confirm at build.
- Morpho GraphQL APY query shape — confirm current schema at `api.morpho.org/graphql`.
- Whether maintainers want execution in v1 or a read-only "advisor" first — ask in the issue; a read-only compare/health AP is the lowest-risk first PR and a clean phase-1.
