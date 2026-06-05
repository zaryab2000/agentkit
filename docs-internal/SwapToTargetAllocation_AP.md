# PRD — Swap-to-Target-Allocation ActionProvider for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new MIDDLEWARE ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit). **The goal is a PR that Coinbase merges into the official repo.** Self-contained; no access to prior conversations. Re-verify anything graded below `CONFIRMED`. Access date: **2026-06-03**.
> Backing research: `docs-internal/research/MIDDLEWARE_PROTOCOL_RESEARCH.md` and `docs-internal/research/AP_MARKET_RESEARCH.md`.
>
> **What this AP is:** a **portfolio rebalancer**. Given target weights (e.g. 50% USDC / 30% WETH / 20% cbBTC), it reads current balances, prices them in USD, computes drift, plans the **minimum set of swaps** to reach the target, and executes them via the existing in-tree `zeroX`/`enso` swap actions.
>
> **⚠️ READ THE COLLISION SECTION (§0.6) BEFORE BUILDING.** This is a crowded lane. There are open swap-related PRs (EZ-Path #1219/#1226, paladinTrust #1245). Research verdict: **no hard collision** — those are *single-swap* best-execution routers / risk gates, not *portfolio-level* rebalancers — but the differentiation must be explicit in the PR or it will be read as duplicate work. If you cannot make the portfolio-level distinction land with maintainers, this is the **lowest-merge-likelihood** of the four middleware APs; consider building it last.

---

## 0. The merge target: AgentKit conventions (verified against `main`, 2026-06-03)

### 0.1 Toolchain & deps
- Node 22+, pnpm 10.7+; `pnpm install` from `typescript/`. `pnpm test` / `pnpm run lint` / `pnpm run format`. Changeset patch, past-tense. **All commits signed.**
- **Deps baseline:** `zod@^4.3.6` (v4), `viem@2.47.4`, `ethers@^6.13.5` (v6). All chain I/O via viem through the wallet provider.
- **Composes existing in-tree actions:** `zeroX` (`get_swap_price_quote_from_0x`, `execute_swap_on_0x`; needs `ZEROX_API_KEY`), `enso` (`route`; supports Base 8453), `erc20` (`get_balance`). Pricing via `pyth` or `alchemy` (`token_prices_by_address`).

### 0.2 File layout
`typescript/agentkit/src/action-providers/portfolioRebalance/`:
```
portfolioRebalance/
├── portfolioRebalanceActionProvider.ts
├── schemas.ts                 # plain z.object().describe(); NO .strip()
├── constants.ts               # default token lists, price-source config, Base tokens
├── utils.ts                   # valuation, drift calc, min-swap planning, swap dispatch
├── portfolioRebalanceActionProvider.test.ts   # REQUIRED
├── index.ts
└── README.md                  # REQUIRED
```
Re-export factory from `src/action-providers/index.ts`.

### 0.3 Canonical pattern (verbatim shape from in-repo ERC-721)
```typescript
export class PortfolioRebalanceActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super("portfolioRebalance", []);
  }

  @CreateAction({
    name: "plan_rebalance",
    description: `Reads the wallet's token balances, prices them in USD, and computes the minimum set of swaps to reach the requested target allocation (weights). Returns a plan; does NOT execute. ...`,
    schema: PlanRebalanceSchema,
  })
  async planRebalance(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof PlanRebalanceSchema>,
  ): Promise<string> {
    try {
      return JSON.stringify(plan);
    } catch (error) {
      return `Error planning rebalance: ${error}`; // returned, not thrown
    }
  }

  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.chainId === "8453"; // Base-first v1
}

export const portfolioRebalanceActionProvider = () => new PortfolioRebalanceActionProvider();
```
**Conventions:** extends `ActionProvider<EvmWalletProvider>`; `super("portfolioRebalance", [])`; async `@CreateAction` → `Promise<string>`; errors returned; schemas plain `z.object().describe()`, no `.strip()`; factory + re-export.

### 0.4 Acceptance checklist
- [ ] Actions return `Promise<string>`; errors returned. Zod plain `.describe()`, no `.strip()`.
- [ ] `supportsNetwork` Base-only v1 (`chainId === "8453"`).
- [ ] Tests pass (mirror `pythActionProvider.test.ts`); lint/format clean.
- [ ] README + the §0.6 differentiation stated in the PR description.
- [ ] Changeset (patch). Signed commits. PR template + tracking issue.
- [ ] Naming: dir `portfolioRebalance`, class `PortfolioRebalanceActionProvider`, factory `portfolioRebalanceActionProvider`, name `"portfolioRebalance"`. Re-exported.

### 0.5 Merge-likelihood — open an issue FIRST (blocking gate)
**Do this before any code** — and lead with the §0.6 differentiation. Lowest-merge-likelihood of the four; the issue is where you find out if maintainers see it as distinct from the EZ-Path swap routers.

### 0.6 COLLISION & DIFFERENTIATION (decisive — confirmed 2026-06-03)
- **Open PRs in this lane:** #1219 "EZ Path Agentic" and #1226 "EZ-Path best-execution DEX router" — both **single-swap meta-routers** (race 0x/ParaSwap/Aerodrome/Uniswap/Curve/etc. for the best rate on ONE ERC-20 swap, x402-paid, Base). #1245 "paladinTrust" — a **pre-swap token-risk gate** (`check_token_risk`, decision-only). (CONFIRMED, direct PR fetch.)
- **Why this AP is NOT a duplicate:** it operates **one layer up** — at the **portfolio level**: read *all* balances → value in USD → compute drift from *target weights* → plan the *minimum set of swaps* → execute each via existing `zeroX`/`enso`. It does **not** implement a new DEX router or routing engine; it **consumes** best-execution swaps (and could even consume EZ-Path if merged). State in the PR: *"This is a portfolio rebalancer, not a DEX router. It composes the existing zeroX/enso swap actions; it does not compete with single-swap best-execution PRs."*
- **If maintainers still see overlap:** fall back to a **read-only `plan_rebalance` advisor** (no execution) — minimal surface, clearly distinct from routers, still useful. That is the safest first PR.

---

## 1. Executive Summary
A portfolio rebalancer that turns "keep me at 50/30/20" into action: it reads the wallet's holdings, prices them in USD, measures drift from the requested target weights, computes the smallest set of swaps to restore the target, and executes them through AgentKit's existing `zeroX`/`enso` swap actions. The agent-suited value is the **portfolio-level planning** — valuing a basket, deciding *which* swaps minimize churn and cost, and respecting a drift threshold — which a single-swap tool doesn't do. It deliberately composes (not replaces) best-execution routing.

## 2. Mechanics (primary-source grounded)

### 2.1 Read current allocation
- Token balances: in-tree `erc20.get_balance` per token, or `walletProvider.readContract` `balanceOf`. Native ETH via balance read.
- **USD pricing:** in-tree **`pyth`** (`fetch_price`) or **`alchemy` `token_prices_by_address`**; fallback DeFiLlama coin-prices API (`docs.llama.fi/coin-prices-api`). Recommend Alchemy `token_prices_by_address` (address-keyed, Base-aware). (Pricing sources CONFIRMED present in-tree.)

### 2.2 Drift + min-swap planning
- Compute each token's current weight = `usdValue_i / totalUsd`; drift = `current - target`.
- Tokens **above** target are sources; **below** target are sinks. Plan swaps source→sink to minimize count/notional (greedy largest-surplus → largest-deficit is sufficient and explainable; document the algorithm).
- Apply a **drift threshold** (`rebalanceThresholdBps`) so dust drift doesn't trigger swaps.

### 2.3 Execute
- For each planned swap, call in-tree `zeroX.execute_swap_on_0x` (or `enso.route`) with `slippageBps`. Re-check the quote (`get_swap_price_quote_from_0x`) before executing.

## 3. Action-by-Action Spec

### `plan_rebalance` *(read-only — safest standalone PR)*
- **Schema:** `{ targets: Array<{ token: string, weightBps: number }> (sum=10000), rebalanceThresholdBps?: number (default 100) }`.
- **Behavior:** read balances → price → compute weights/drift → return JSON plan `{ currentWeights, drift, swaps: [{ from, to, amountUsd, est }], totalUsd }`. No execution.
- **Edge cases:** weights don't sum to 10000 (reject); token with no price (flag, exclude from total or error); drift under threshold (return "no rebalance needed").

### `rebalance_portfolio`
- **Schema:** `{ targets: [...], rebalanceThresholdBps?: number, slippageBps?: number (default 100), maxSwaps?: number }`.
- **Behavior:** run `plan_rebalance`; execute each swap via `zeroX`/`enso` with allowance preflight; return per-swap tx hashes + resulting weights.
- **Edge cases:** partial execution (some swaps succeed, some fail — return per-swap status, never claim full success); slippage exceeded (skip that leg, report); `maxSwaps` cap respected; ensure no swap pushes another token past target (recompute after each or plan holistically).

## 4. Security Considerations
- **Slippage/MEV:** bound every swap with `slippageBps`; re-quote immediately before execution.
- **Oracle/price trust:** allocation math depends on the price source — use a robust one (Pyth/Alchemy), tolerate staleness, and never execute a large swap on a single stale price.
- **Allowance:** per-token approval before each swap; prefer exact-amount.
- **Partial-rebalance state:** multi-swap and non-atomic — report per-leg outcomes; idempotent re-run reaches target without double-swapping.
- **Network guard:** Base-only v1.

## 5. Testing Plan
- Mock balance reads + price source; assert weight/drift math and the min-swap plan (including the under-threshold no-op).
- Mock `zeroX`/`enso` execution; assert allowance preflight, slippage passthrough, and per-leg partial-failure reporting.
- Assert `plan_rebalance` never executes.
- `supportsNetwork`: true only for `8453`.
- Mirror `pythActionProvider.test.ts`.

## 6. Open Questions / Gaps
- Confirm EZ-Path PRs' merge status before submitting (re-fetch `coinbase/agentkit/pulls`); if one merges, reference it as the execution backend to strengthen the "I compose, not compete" framing.
- Whether to ship read-only `plan_rebalance` first (recommended) or both actions — decide via the issue.
- Holistic vs greedy swap planning — greedy is fine for v1; note the tradeoff.
