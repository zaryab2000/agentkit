# PRD — Bridge-Then-Deploy ActionProvider for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new MIDDLEWARE ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit). **The goal is a PR that Coinbase merges into the official repo.** This document is self-contained. You do **not** have access to prior conversations. Re-verify any value graded below `CONFIRMED`. Access date for sources: **2026-06-03**.
> Backing research: `docs-internal/research/MIDDLEWARE_PROTOCOL_RESEARCH.md` (Across mechanics, primary-verified) and `docs-internal/research/AP_MARKET_RESEARCH.md`.
>
> **What this AP is:** an intent that **bridges funds to a target chain (via Across) and then deploys them into a lending/vault position** on arrival, as one agent-level workflow. It composes the in-tree `across` provider + a destination lending/vault action.
>
> **One decisive architectural truth, design around it from line one:** Across *does* support destination-side execution — but **only to a deployed handler contract** (`AcrossMessageHandler.handleV3AcrossMessage(...)`), **not to a plain EOA**. An AgentKit agent's wallet is (usually) an EOA, which **cannot** receive the on-arrival callback. Therefore, for the common EOA case, bridge-then-deploy is **inherently TWO-STEP**: bridge → poll deposit status → supply on the destination. Do **not** promise an atomic one-tx cross-chain deposit for EOA wallets. (CONFIRMED — Across `SpokePoolMessageHandler.sol`.)
> **No colliding open PR exists** for bridge-then-deploy (confirmed 2026-06-03).

---

## 0. The merge target: AgentKit conventions (verified against `main`, 2026-06-03)

### 0.1 Toolchain & deps
- Node 22+, pnpm 10.7+, Turborepo; `pnpm install` from `typescript/`. Tests `pnpm test`; lint `pnpm run lint`; format `pnpm run format`. Changeset patch, past-tense. **All commits signed.**
- **Deps baseline:** `zod@^4.3.6` (v4), `viem@2.47.4`, `ethers@^6.13.5` (v6). All chain I/O via viem through the wallet provider. The in-tree `across` provider uses **`@across-protocol/app-sdk` `createAcrossClient`** and takes a **`privateKey` in its constructor config** — mirror that pattern.

### 0.2 File layout
`typescript/agentkit/src/action-providers/bridgeDeploy/`:
```
bridgeDeploy/
├── bridgeDeployActionProvider.ts
├── schemas.ts                 # plain z.object().describe(); NO .strip()
├── constants.ts               # Across SpokePool addrs per chain, deposit-status API base, target-protocol addrs
├── utils.ts                   # Across client wiring, status polling, destination-supply dispatch
├── bridgeDeployActionProvider.test.ts   # REQUIRED
├── index.ts
└── README.md                  # REQUIRED — must document the two-step / non-atomic semantics
```
Re-export factory from `src/action-providers/index.ts`.

### 0.3 Canonical pattern (verbatim shape from in-repo ERC-721)
```typescript
export class BridgeDeployActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super("bridgeDeploy", []);
  }

  @CreateAction({
    name: "bridge_and_deploy",
    description: `Bridges a token to a destination chain via Across, then (after the bridge fills) supplies it into a lending/vault position. NOTE: this is a two-step, non-atomic flow for EOA wallets — it returns after initiating the bridge and tells you to poll status before the destination supply completes. ...`,
    schema: BridgeAndDeploySchema,
  })
  async bridgeAndDeploy(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof BridgeAndDeploySchema>,
  ): Promise<string> {
    try {
      // initiate Across deposit, return depositId + "poll bridge_deploy_status" guidance
      return JSON.stringify(result);
    } catch (error) {
      return `Error bridging and deploying ${args.amount} ${args.token}: ${error}`; // returned, not thrown
    }
  }

  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm"; // origin can be any EVM Across supports; gate destinations in-code
}

export const bridgeDeployActionProvider = () => new BridgeDeployActionProvider();
```
**Conventions:** extends `ActionProvider<EvmWalletProvider>`; `super("bridgeDeploy", [])`; async `@CreateAction` methods → `Promise<string>`; errors returned not thrown; schemas plain `z.object().describe()`, no `.strip()`; factory + re-export.

### 0.4 Acceptance checklist
- [ ] Actions return `Promise<string>`; errors returned. Zod plain `.describe()`, no `.strip()`.
- [ ] `supportsNetwork` scoped to EVM chains Across supports; destination protocols gated in-code (Base-first).
- [ ] Tests pass (mirror `pythActionProvider.test.ts`); lint/format clean.
- [ ] README **prominently documents the two-step, non-atomic, EOA-can't-receive-callback semantics**.
- [ ] Changeset (patch). Signed commits. PR template + tracking issue.
- [ ] Naming: dir `bridgeDeploy`, class `BridgeDeployActionProvider`, factory `bridgeDeployActionProvider`, name `"bridgeDeploy"`. Re-exported.

### 0.5 Merge-likelihood — open an issue FIRST (blocking gate)
Composite AP + cross-chain → confirm maintainers want it in-tree. **No collision.** Maps to WISHLIST "Bridge" (shipped as `across`) + "Other Networks." State clearly that it composes the existing `across` AP rather than re-implementing bridging. **Do not code until a maintainer responds.**

---

## 1. Executive Summary
Bridge-then-deploy lets an agent express "move this capital to chain X and put it to work" as one workflow: it initiates an **Across** bridge, tracks the deposit to a confirmed destination fill, then **supplies the bridged token into a lending/vault position** on the destination chain. Because an EOA cannot receive Across's on-arrival callback, the flow is **deliberately two-step and non-atomic** for agent wallets — the AP is honest about this, returning a pollable status and only triggering the destination supply once funds have landed. Value: collapses a multi-step, multi-chain capital-deployment chore into a guided agent intent with explicit failure handling.

## 2. Protocol Background (primary-source grounded)

### 2.1 Across intent lifecycle (CONFIRMED — docs.across.to/concepts/intent-lifecycle-in-across)
1. **Initiation:** `depositV3()` on the origin SpokePool escrows funds, emits `V3FundsDeposited`.
2. **Fill:** a relayer calls `fillV3Relay()` on the destination using its own capital (fast — exclusivity period then permissionless), emits `FilledV3Relay`. This is when destination funds are available.
3. **Settlement:** background bundling to the HubPool (~every 1.5h) reimburses the relayer. (Not on the agent's critical path.)

### 2.2 Destination execution — handler only, NOT EOA (CONFIRMED — across-protocol/contracts `SpokePoolMessageHandler.sol`)
- Interface: `AcrossMessageHandler.handleV3AcrossMessage(address tokenSent, uint256 amount, address relayer, bytes message)`.
- A **deployed contract** implementing this receives the bridged funds + a `message` payload on arrival → can atomically act (e.g. supply to a lending pool). Across also documents a **generic multicaller handler** for this.
- **A plain EOA cannot implement this** → no atomic on-arrival deposit for EOA agent wallets. ⚠️ This is the central design constraint.

### 2.3 Status read (CONFIRMED — installed `across` AP wraps it)
- Across deposit-status API: `GET /api/deposit/status?originChainId=<id>&depositId=<id>` returns structured JSON (live; the in-tree `across.check_deposit_status` action already calls this). Use it to gate the destination supply.

### 2.4 Base liveness (CONFIRMED)
Across SpokePool, and the destination lending targets (Compound III, Morpho `0xBBBB…FFCb`, Moonwell, Aave Pool `0xA238…d1c5`) are all live on Base (8453). Default destination = Base.

## 3. Architecture & two flows
- **Flow A — EOA (default, v1):** `bridge_and_deploy` initiates the Across deposit to the **agent's own address** on the destination, returns `depositId` + "poll `bridge_deploy_status`". `bridge_deploy_status` polls the Across API; when filled, it (or a follow-up `deploy_on_destination` call) supplies the bridged token into the chosen destination protocol. Non-atomic, recoverable.
- **Flow B — handler contract (v2, optional):** if a destination handler/multicaller contract is available, bridge with a `message` that triggers the supply atomically on arrival. Out of scope for v1 unless maintainers want it; document as the upgrade path.

## 4. Action-by-Action Spec

### `bridge_and_deploy`
- **Schema:** `{ token: string, amount: string, destinationChainId: number (default 8453), destinationProtocol: enum["compound","aave","moonwell","morpho"], maxSlippageBps?: number, recipient?: string }`.
- **Behavior (Flow A):** validate token is bridgeable; initiate Across `depositV3` via `@across-protocol/app-sdk` to `recipient` (default = wallet address) on `destinationChainId`; return `{ depositId, originChainId, destinationChainId, status: "bridging", next: "call bridge_deploy_status with this depositId; once 'filled', the destination supply will run" }`.
- **Edge cases:** unsupported token/route (return supported list); destination protocol not on destinationChainId (reject with which protocols are); never claim the supply has happened yet.

### `bridge_deploy_status`
- **Schema:** `{ depositId: string, originChainId: number }`.
- **Behavior:** call the Across deposit-status API; return the status. If `filled` and a pending deploy is recorded, proceed to the destination supply and return that tx hash; if still bridging, return "pending, poll again."
- **Edge cases:** no-fill timeout / slow-fill / refund path (⚠️ GAP — Across docs don't fully specify timing; surface whatever the API returns and warn the agent to check for a refund if stuck).

### `deploy_on_destination` *(explicit second leg; also callable standalone)*
- **Schema:** `{ token: string, amount: string, protocol: enum[...], chainId: number (default 8453) }`.
- **Behavior:** supply the (already-bridged) token into the chosen destination lending/vault protocol via that protocol's supply path (Compound `supply`, Morpho/Moonwell `deposit`/`mint`, Aave supply). Return tx hash + position.
- **Edge cases:** funds not actually present on destination (balance preflight — the bridge may not have filled); allowance preflight; protocol supply action availability (Base-first).

## 5. Security Considerations
- **Non-atomic / partial failure (#1 issue):** bridge can succeed while the destination supply fails → funds sit on the destination EOA. The AP must return a clear recoverable state and never assume success; `deploy_on_destination` is idempotent-safe (re-checks balance).
- **EOA-callback impossibility:** do not design or imply an atomic one-tx deposit for EOA wallets; that requires a handler contract (Flow B).
- **Bridge settlement assumptions:** relayer-fill model; if no relayer fills, funds follow Across's slow-fill/refund path (timing GAP — verify and document).
- **Slippage / fees:** Across charges a relay fee; surface it; bound with `maxSlippageBps`.
- **Allowance:** destination supply needs token approval on the destination chain.
- **Network guard:** origin = EVM Across supports; destinations gated in-code (Base-first).

## 6. Testing Plan
- Mock `@across-protocol/app-sdk` deposit init; assert `bridge_and_deploy` returns `depositId` + pending status and **never claims a completed supply**.
- Mock the deposit-status API across `bridging`/`filled`/`refunded`; assert correct branching.
- Mock destination supply; assert balance preflight before supplying.
- Assert two-step semantics are preserved (no atomic-deposit code path for EOA).
- Mirror `pythActionProvider.test.ts`.

## 7. Open Questions / Gaps
- Across no-fill timeout / slow-fill / refund exact timing + the API's status enum values — verify against `docs.across.to/reference/api-reference` at build.
- Whether maintainers want Flow B (handler-contract atomic deposit) — needs a deployed handler; ask in the issue. v1 should ship Flow A only.
- Exact `@across-protocol/app-sdk` API for initiating a deposit with a destination `message` (for Flow B) — confirm at build.
