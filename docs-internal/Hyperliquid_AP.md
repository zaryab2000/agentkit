# PRD — Hyperliquid ActionProvider (HyperEVM target) for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit), the open-source TypeScript monorepo. **The goal is a PR that Coinbase merges into the official repo.** This document is self-contained: it carries every convention, address, and acceptance criterion you need. You do **not** have access to prior conversations. Where a value is graded below `CONFIRMED`, you MUST re-verify it against the cited primary source before relying on it. All source access dates are **2026-06-03**.
>
> **One decisive constraint, design around it from line one:** Hyperliquid's HyperEVM actions are **asynchronous and non-atomic**. A successful EVM transaction to the CoreWriter contract does **NOT** mean an order filled. Reads (precompiles) are start-of-block snapshots; writes (CoreWriter) are queued, few-second-delayed, eventually-consistent L1 actions with **no in-transaction confirmation and no revert on core-side failure**. Any abstraction that makes `open_position` *look* synchronous to the LLM will produce incorrect agent behavior. Preserve "submitted; settlement is async; poll to confirm" end-to-end — including in the action `description` the LLM reads.
>
> **Second flagged item:** `set_leverage` has **no published CoreWriter action ID**. Do not ship a guessed action ID — see §4 and §9.

---

## 0. The merge target: AgentKit conventions (authoritative, verbatim from the repo)

These are the rules your PR is graded against. Sources: `CONTRIBUTING.md`, `CONTRIBUTING-TYPESCRIPT.md` (raw.githubusercontent.com/coinbase/agentkit/main/, accessed 2026-06-03).

### 0.1 Toolchain
- **Node.js v22.x+**, **pnpm 10.7.x+**, Turborepo. Run all commands from the `typescript/` monorepo root.
- `pnpm install` (from `typescript/`) first.
- Tests: `pnpm test` (jest). Lint: `pnpm run lint` / `pnpm run lint:fix`. Format: `pnpm run format` (ESLint + Prettier).
- Changelog: `pnpm run changeset` (interactive) → package `@coinbase/agentkit`, type **patch**, past-tense summary, e.g. *"Added a Hyperliquid action provider for perpetuals trading via HyperEVM."*
- **All commits MUST be signed** (`git commit -S`) — hard merge gate (`cb-heimdall` CI).
- Scaffolding: `generate-action-provider` script at `typescript/agentkit/scripts/generate-action-provider/`; or copy the `pyth` provider layout.

### 0.2 Required file layout
Provider at `typescript/agentkit/src/action-providers/hyperliquid/`:
```
hyperliquid/
├── hyperliquidActionProvider.ts      # provider class + @CreateAction methods
├── schemas.ts                        # Zod schemas
├── constants.ts                      # chainIds, RPC URLs, precompile addrs, CoreWriter addr, action IDs, ABIs
├── utils.ts                          # action encoding, precompile read (getPublicClient().call) + decode, px scaling
├── hyperliquidActionProvider.test.ts # jest unit tests (REQUIRED)
├── index.ts                          # exports
└── README.md                         # per-provider README (REQUIRED)
```
Re-export from `typescript/agentkit/src/action-providers/index.ts`.

### 0.3 The canonical provider pattern (verbatim shape from the ERC-721 example in CONTRIBUTING-TYPESCRIPT.md)
> ⚠️ **Repo dependency baseline (verified against `typescript/agentkit/package.json`, 2026-06-03):** the package ships **`zod@^4.3.6` (Zod v4)**, **`viem@2.47.4`**, **`ethers@^6.13.5` (ethers v6)**. Write against these exact majors. In particular: **do NOT use `.strip()` on schemas** — the current in-repo providers (`erc721/schemas.ts`, `pyth/schemas.ts`) use plain `z.object({...}).describe(...)` with `.describe()` on every field and **no `.strip()`**. The `.strip()` shown in `CONTRIBUTING-TYPESCRIPT.md` is a stale doc snippet; match the live provider style. All on-chain reads/writes go through **viem** via the wallet provider (see §3 / §0.3 note below) — there is no ethers usage in this provider.

```typescript
// schemas.ts — match the LIVE house style: every field .describe(); object .describe(); NO .strip()
const MintSchema = z
  .object({
    contractAddress: z.string().describe("The contract address of the NFT to mint"),
    destination: z.string().describe("The destination address that will receive the NFT"),
  })
  .describe("Instructions for minting an NFT");

// provider class
export class Erc721ActionProvider extends ActionProvider {
  constructor() {
    super("erc721", []);          // super(<name string>, [])
  }

  @CreateAction({
    name: "mint",
    description: `This tool will mint an NFT ...`,   // multi-line LLM prompt: inputs, outputs, examples
    schema: MintSchema,
  })
  async mint(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof MintSchema>,
  ): Promise<string> {            // EVERY action returns Promise<string>
    try {
      const data = encodeFunctionData({ abi: ERC721_ABI, functionName: "mint", args: [args.destination as Hex, 1n] });
      const hash = await walletProvider.sendTransaction({ to: args.contractAddress as `0x${string}`, data });
      await walletProvider.waitForTransactionReceipt(hash);
      return `Successfully minted NFT ${args.contractAddress} to ${args.destination}`;
    } catch (error) {
      return `Error minting NFT ...: ${error}`;   // errors RETURNED as strings, not thrown
    }
  }

  supportsNetwork = (network: Network) => network.protocolFamily === "evm";
}

export const erc721ActionProvider = () => new Erc721ActionProvider();   // factory export
```
**Non-negotiable conventions:**
1. Class `extends ActionProvider` (typed form `ActionProvider<EvmWalletProvider>` allowed); wallet param typed `EvmWalletProvider`.
2. Constructor `super("hyperliquid", [])`.
3. Every action: `async`, `@CreateAction({ name, description, schema })`, returns `Promise<string>`.
   - Schemas: plain `z.object({...}).describe(...)`, `.describe()` on every field, **no `.strip()`** (Zod v4; see the dependency-baseline note above).
4. **Errors are caught and returned as strings** — actions never throw.
5. `description` is an LLM prompt — for Hyperliquid, the write-action descriptions MUST state the async "submitted ≠ filled, poll to confirm" semantics so the LLM does not assume a fill.
6. `supportsNetwork` is an arrow-function property.
7. Factory `export const hyperliquidActionProvider = () => new HyperliquidActionProvider();`.
8. Decorators need `experimentalDecorators` + `emitDecoratorMetadata` (already set in the monorepo).

> ⚠️ **How to actually read a precompile (critical — the wallet API has no `staticcall` method).** `EvmWalletProvider` exposes `sendTransaction`, `waitForTransactionReceipt`, `signTypedData`, `readContract`, and **`getPublicClient(): PublicClient`** (viem) — verified in `wallet-providers/evmWalletProvider.ts`. There is **no `staticcall` method**. Hyperliquid precompiles take **raw abi-encoded args with no function selector/ABI**, so `readContract` (which needs an ABI + function name) does NOT fit. The correct mechanism is a **raw viem `eth_call`**:
> ```typescript
> import { encodeAbiParameters, decodeAbiParameters } from "viem";
> const client = walletProvider.getPublicClient();
> const data = encodeAbiParameters(PRECOMPILE_ARG_TYPES, args);     // e.g. [{type:"address"},{type:"uint16"}]
> const raw = await client.call({ to: PRECOMPILE_ADDR, data });     // returns { data }
> const decoded = decodeAbiParameters(PRECOMPILE_RETURN_TYPES, raw.data!);
> ```
> Everywhere this PRD says "`staticcall` to a precompile," implement it as `getPublicClient().call({ to, data })` + `encode/decodeAbiParameters`. Writes to CoreWriter use `walletProvider.sendTransaction({ to: CoreWriter, data })` as normal.

### 0.4 Acceptance criteria checklist (the PR rubric)
- [ ] All actions return `Promise<string>`; errors returned (not thrown).
- [ ] Zod schemas: plain `z.object({...}).describe(...)`, every field `.describe()`, **no `.strip()`** (matches live `erc721`/`pyth` schemas; Zod v4).
- [ ] `supportsNetwork` Hyperliquid-only (chainId 999 mainnet, 998 testnet).
- [ ] Unit tests pass via `pnpm test`; mirror `pythActionProvider.test.ts`.
- [ ] `pnpm run lint` and `pnpm run format` clean.
- [ ] Per-provider `README.md` present **and prominently documents the HyperEVM↔HyperCore async boundary and "submitted ≠ filled" semantics**.
- [ ] Changeset added (patch, past tense).
- [ ] Signed commits; PR template filled; tracking issue linked.
- [ ] Naming exact: directory `hyperliquid`, class `HyperliquidActionProvider`, factory `hyperliquidActionProvider`, name string `"hyperliquid"`.
- [ ] Re-exported from `src/action-providers/index.ts`.
- [ ] `set_leverage` status explicitly resolved (implemented against a verified on-chain action ID, or shipped as documentation-only — never a guessed ID).

### 0.5 Merge-likelihood note (do this BEFORE writing code)
AgentKit is **Base-first**; Hyperliquid is **chainId 999 / HyperEVM**. **Open a GitHub issue on `coinbase/agentkit` first**, describing the provider, the off-Base network, the HyperEVM (vs native-L1-API) approach, and the broadly-useful justification (Hyperliquid is the dominant perp DEX by TVL/volume — `defillama.com/protocol/hyperliquid`, accessed 2026-06-03; **pin an exact date-stamped OI/volume figure from DeFiLlama or Dune in the issue** — the headline is a STRONG SIGNAL but was not pinned to a single number in research). Be ready to justify HyperEVM over the native L1 REST API: composability with on-chain contracts and no off-chain signing server. A maintainer may prefer the native-API surface — confirm before building. As of 2026-06-03 there is **no in-flight Hyperliquid PR** (collision-checked) — re-check `github.com/coinbase/agentkit/pulls` before starting.

---

## 1. Executive Summary

The Hyperliquid ActionProvider lets an AgentKit agent interact with Hyperliquid's perp engine **from HyperEVM smart contracts** (not the native L1 REST API): read market data and positions via HyperCore read precompiles, and open/close positions (and, conditionally, set leverage) by sending actions through the CoreWriter system contract. The integration surface is HyperEVM (chainId 999) JSON-RPC: `staticcall` to read precompiles (`0x0800`–`0x080C`) and a transaction to CoreWriter (`0x3333…3333`). The dominant technical and architectural risk is the **HyperEVM↔HyperCore boundary**: HyperEVM cannot directly reach the L1 order book; reads are snapshotted at EVM block construction, and writes are **asynchronous, queued, delayed-by-a-few-seconds, non-atomic** CoreWriter actions that cannot be confirmed in the same transaction.

**5 actions (one conditional):** `get_markets`, `get_positions`, `open_position`, `close_position`, `set_leverage` (conditional — see §4/§9).

---

## 2. Protocol Background (primary-source grounded)

### 2.1 Architecture (`hyperliquid.gitbook.io` /for-developers/hyperevm)
- **HyperCore** = native L1 order book / perp engine (HyperBFT consensus, one-block finality, ~200k orders/second). No general-purpose smart contracts.
- **HyperEVM** = EVM execution layer (Cancun, no blob). Shares one chain with HyperCore.
- Contracts on HyperEVM **read** HyperCore state via precompiles and **write** via CoreWriter. The direction is strictly **HyperEVM → HyperCore**.

### 2.2 Network details
- **Mainnet:** chainId **999**, JSON-RPC `https://rpc.hyperliquid.xyz/evm`, native gas token **HYPE** (18 decimals on EVM). Explorer: purrsec.com.
- **Testnet:** chainId **998**, JSON-RPC `https://rpc.hyperliquid-testnet.xyz/evm`.
- ⚠️ chainId 999 collides with **Wanchain Testnet** in some wallet registries (reown/appkit issue #5391) — pin the RPC explicitly; do not rely on registry chain lookups.
- Block model: small blocks ~1 s / 2M gas; big blocks ~1 min / 30M gas (needed for contract deploys; not for these actions).

### 2.3 Read precompiles — verified from canonical `L1Read.sol` (Hyperliquid GitBook attachment + QuickNode verbatim reproduction)
All addresses `0x0000…0800`–`0x0000…080C`, read via a **raw `eth_call`** (abi-encoded args, **no function selector/ABI**). From this provider that means `walletProvider.getPublicClient().call({ to, data })` with `encodeAbiParameters`/`decodeAbiParameters` — **not** `readContract`, and there is no `staticcall` method on the wallet (see the §0.3 read-mechanism note).

| Address | Function | Returns |
|---|---|---|
| `0x…0800` | `position(address user, uint16 perp)` | `Position{int64 szi; uint64 entryNtl; int64 isolatedRawUsd; uint32 leverage; bool isIsolated}` |
| `0x…0801` | `spotBalance(address user, uint64 token)` | `SpotBalance{uint64 total; uint64 hold; uint64 entryNtl}` |
| `0x…0802` | `userVaultEquity(address user, address vault)` | `UserVaultEquity{uint64 equity; uint64 lockedUntilTimestamp}` |
| `0x…0803` | `withdrawable(address user)` | `Withdrawable{uint64 withdrawable}` |
| `0x…0804` | `delegations(address user)` | `Delegation[]` |
| `0x…0805` | `delegatorSummary(address user)` | `DelegatorSummary{uint64 delegated; uint64 undelegated; uint64 totalPendingWithdrawal; uint64 nPendingWithdrawals}` |
| `0x…0806` | `markPx(uint32 index)` | `uint64` |
| `0x…0807` | `oraclePx(uint32 index)` | `uint64` |
| `0x…0808` | `spotPx(uint32 index)` | `uint64` |
| `0x…0809` | `l1BlockNumber()` | `uint64` |
| `0x…080a` | `perpAssetInfo(uint32 perp)` | `PerpAssetInfo{string coin; uint32 marginTableId; uint8 szDecimals; uint8 maxLeverage; bool onlyIsolated}` |
| `0x…080b` | `spotInfo(uint32 spot)` | `SpotInfo{string name; uint64[2] tokens}` |
| `0x…080C` | `tokenInfo(uint32 token)` | `TokenInfo{string name; uint64[] spots; uint64 deployerTradingFeeShare; address deployer; address evmContract; uint8 szDecimals; uint8 weiDecimals; int8 evmExtraWeiDecimals}` |

- **Price conversion:** divide returned px by `10^(6 - szDecimals)` (perps) or `10^(8 - base szDecimals)` (spot).
- **Precompile gas:** `2000 + 65 * (input_len + output_len)`. **Invalid inputs return an error and consume all gas in the call frame** — validate indices before calling.
- **Staleness:** reads reflect state at the **start of the EVM block**. CoreWriter writes are NOT visible until a later block (read-after-write returns stale data).
- ⚠️ `accountMarginSummary`, `bbo`, and `coreUserExists` are **NOT** in canonical `L1Read.sol` (they appear only in community libs like `hyper-evm-lib`) — treat as **unofficial**; do not depend on them without on-chain verification.

### 2.4 CoreWriter system contract (confirmed, GitBook)
- Address: `0x3333333333333333333333333333333333333333`.
- Entry: `sendRawAction(bytes data)`.
- **Encoding:** byte 1 = version `0x01`; bytes 2–4 = action ID (big-endian uint24); remaining = ABI-encoded args. (So the header for action ID 1 is `0x01 0x00 0x00 0x01`.)
- Gas: "burns ~25,000 gas before emitting a log… in practice ~47,000 for a basic call" (Hyperliquid Docs, verbatim).
- **Order/vault-transfer actions are deliberately delayed onchain a few seconds** to prevent latency arbitrage and appear twice in the L1 explorer (enqueue, then HyperCore execution).
- Live on HyperEVM mainnet since **July 5, 2025** (official Hyperliquid X stated July 21, 2025 it activated "two weeks ago"; The Defiant; founder Jeff Yan flagged July 5 in Discord). ⚠️ The QuickNode guide, despite a 2026 timestamp, **still contains a stale sentence claiming CoreWriter is "not yet available on mainnet" — that is outdated. Ignore it.**

### 2.5 CoreWriter action IDs (GitBook table)
| ID | Action | Fields | Solidity types |
|---|---|---|---|
| 1 | Limit order | (asset, isBuy, limitPx, sz, reduceOnly, encodedTif, cloid) | (uint32,bool,uint64,uint64,bool,uint8,uint128) |
| 2 | Vault transfer | (vault, isDeposit, usd) | (address,bool,uint64) |
| 3 | Token delegate | (validator, wei, isUndelegate) | (address,uint64,bool) |
| 4 | Staking deposit | wei | uint64 |
| 5 | Staking withdraw | wei | uint64 |
| 6 | Spot send | (destination, token, wei) | (address,uint64,uint64) |
| 7 | USD class transfer | (ntl, toPerp) | (uint64,bool) |
| 8 | Finalize EVM contract | (token, variant, createNonce) | (uint64,uint8,uint64) |
| 9 | Add API wallet | (address, name) | (address,string) |
| 10 | Cancel order by oid | (asset, oid) | (uint32,uint64) |
| 11 | Cancel order by cloid | (asset, cloid) | (uint32,uint128) |
| 12 | Approve builder fee | (maxFeeRate, builder) | (uint64,address) |
| 13 | Send asset | (destination, subAccount, source_dex, destination_dex, token, wei) | (address,address,uint32,uint32,uint64,uint64) |
| 14 | Reflect EVM supply change | (token, wei, is_mint) | (uint64,uint64,bool) |
| 15 | Borrow/lend operation | (encodedOperation, token, wei) | (uint8,uint64,uint64) |

- **Limit-order encoding:** Tif `1`=Alo, `2`=Gtc, `3`=Ioc; cloid `0` = none. **`limitPx` and `sz` are sent as `10^8 ×` the human-readable value.**
- ⚠️ **There is NO dedicated "set leverage" action in this table.** See §4 / §9.

### 2.6 Existing tooling (reference only)
- `hyperliquid-dev/hyper-evm-lib` (Solidity: `CoreWriterLib`, `PrecompileLib`, `TokenRegistry`; by Obsidian Audits) — best reference for encoding/decoding and bridging.
- TS L1 SDKs (`nktkas/hyperliquid`, `nomeida/hyperliquid`) target the **native API, not** HyperEVM precompiles/CoreWriter — reference only.

---

## 3. Architecture & Integration Boundary (CRITICAL)
- **HyperEVM (what the AP touches directly):** JSON-RPC at chainId 999. Reads = raw `eth_call` to precompiles `0x0800`–`0x080C` via `walletProvider.getPublicClient().call({ to, data })` (see §0.3 note). Writes = `walletProvider.sendTransaction` to CoreWriter `0x3333…3333`.
- **HyperCore (reachable only indirectly):** the perp order book / clearinghouse — NOT directly callable from EVM. Reads are snapshots; writes are queued L1 actions.
- **The boundary, explicitly:**
  - **Read path:** EVM → precompile `staticcall` → HyperCore state as of the **start of the current EVM block**. CoreWriter actions submitted this block are NOT reflected until a later block (read-after-write returns stale data).
  - **Write path:** EVM tx → `CoreWriter.sendRawAction(encoded)` → emits a log → HyperCore dequeues and executes after a few-second delay → result observable only via a later precompile read or the native API. **Non-atomic, eventually-consistent, possibly-failing. No return value; no revert if the core action itself fails.**
- **Account model nuance:** CoreWriter actions execute on behalf of the calling address's implied HyperCore account, or via an approved API wallet/agent (action ID 9 adds an API wallet). An EOA AgentKit wallet calling CoreWriter directly acts as that EOA's core account. **Funds must already be on the HyperCore perp side** — moving them there is itself a CoreWriter "USD class transfer" (ID 7) / bridge flow (out of scope for v1, but document as a precondition).
- **Consequence for design:** `open_position` / `close_position` / `set_leverage` CANNOT be synchronous AgentKit actions that confirm fills. They submit a queued action and must return *"submitted; settlement is async (few-second delay); poll get_positions to confirm"* — never asserting a fill.

---

## 4. Action-by-Action Spec

### `get_markets`
- **Schema:** `{ indices?: number[], includePrices?: boolean }`.
- **Behavior:** read `perpAssetInfo(index)` (`0x080a`) for metadata + `markPx`/`oraclePx` (`0x0806`/`0x0807`) per index via the raw `eth_call` mechanism (§0.3). Returns JSON (`coin, szDecimals, maxLeverage, onlyIsolated, markPx, oraclePx`). No write.
- **Edge cases:** invalid index consumes all gas (validate range first); precompile staleness; px decimal conversion. **Practical note:** full market enumeration is easier via the native info API; pure-precompile enumeration requires an explicit index list — document the chosen approach in the README.

### `get_positions`
- **Schema:** `{ user?: string (default wallet), perpIndices: number[] }`.
- **Behavior:** read `position(user, perp)` (`0x0800`) per index. Returns `szi` (signed size), `entryNtl`, `leverage`, `isIsolated`, `isolatedRawUsd`, plus computed unrealized PnL using `markPx`. No write.
- **Edge cases:** zero positions (`szi = 0`); isolated vs cross; decimal scaling.

### `open_position`
- **Schema:** `{ asset: number, isBuy: boolean, size: number, limitPx: number, tif?: "Alo"|"Gtc"|"Ioc" (default "Ioc"), reduceOnly?: boolean (default false), cloid?: string }`.
- **Steps:** (1) encode the limit-order action (ID 1): `abi.encode(asset, isBuy, uint64(limitPx*1e8), uint64(size*1e8), reduceOnly, encodedTif, cloid)`; (2) prepend the 4 header bytes `0x01 0x00 0x00 0x01`; (3) `CoreWriter.sendRawAction(data)` via `walletProvider.sendTransaction`; (4) `waitForTransactionReceipt`; (5) return tx hash + *"submitted; settlement is async (few-second delay); poll get_positions to confirm."*
- **Risks/edge cases:** async non-atomic settlement (EVM tx success ≠ fill); partial fills; IOC vs GTC resting behavior; `1e8` price/size scaling; funds-on-perp precondition; latency-delay window; slippage (use an aggressive `limitPx` + `Ioc` to approximate a market order with a protective bound).

### `close_position`
- **Schema:** `{ asset: number, size?: number (default = full), cloid?: string }`.
- **Behavior:** read the current `position` to determine side/size, then submit a reduce-only limit order (ID 1, `reduceOnly = true`, opposite side, aggressive `limitPx`, `Ioc`). Return tx hash + pending note.
- **Edge cases:** position may change between the read and the write (stale snapshot — surface the risk); full vs partial close; reduce-only enforcement.

### `set_leverage` (CONDITIONAL — resolve before implementing)
- **Schema:** `{ asset: number, leverage: number, isCross?: boolean }`.
- ⚠️ **DESIGN GAP (CONFIRMED-absent in the published table):** there is no "update leverage" action in CoreWriter IDs 1–15. The native L1 exposes an `updateLeverage` action, but it is not in the CoreWriter list.
- **Resolution required:** (a) implement **only if** a leverage action is confirmed in the **current on-chain `CoreWriter` ABI** (fetch and verify before coding); OR (b) mark `set_leverage` as unsupported-from-HyperEVM and document that leverage must be set via the native API or an approved agent wallet. **Do NOT ship a guessed action ID.** If unresolved, ship 4 actions and document the gap.

---

## 5. File Structure
(See §0.2 — `hyperliquid/` with `hyperliquidActionProvider.ts`, `schemas.ts`, `constants.ts`, `utils.ts`, `hyperliquidActionProvider.test.ts`, `index.ts`, `README.md`.)

---

## 6. Ordered Implementation Steps
1. `pnpm install` from `typescript/`; confirm Node 22 / pnpm 10.7.
2. **Open the tracking issue first** (§0.5); pin a Hyperliquid usage stat; re-check for collision PRs.
3. Scaffold `hyperliquid/` via the `generate-action-provider` script (or copy `pyth`).
4. `constants.ts`: chainIds 999/998, RPC URLs, precompile address map (`0x0800`–`0x080C`), CoreWriter `0x3333…3333`, action IDs, decode-struct ABIs, px-scaling constants.
5. `utils.ts`: `encodeLimitOrder()`, `encodeAction(version, id, payload)`, `readPrecompile(publicClient, address, argTypes, args, returnTypes)` (`encodeAbiParameters` → `publicClient.call({to,data})` → `decodeAbiParameters`; **no `staticcall` method exists** — see §0.3), `convertPx()`.
6. `schemas.ts`: `GetMarketsSchema`, `GetPositionsSchema`, `OpenPositionSchema`, `ClosePositionSchema`, (`SetLeverageSchema` gated on the §4 ABI check).
7. Provider class `HyperliquidActionProvider extends ActionProvider<EvmWalletProvider>`, `super("hyperliquid", [])`.
8. Implement `get_markets` (precompile reads).
9. Implement `get_positions` (precompile reads + PnL calc).
10. Implement `open_position` (encode + CoreWriter tx).
11. Implement `close_position` (read position → reduce-only order).
12. Resolve `set_leverage` (verify CoreWriter ABI; implement or document unsupported).
13. `supportsNetwork`: chainId 999 (and 998 testnet) only.
14. Factory export + re-export from `src/action-providers/index.ts`.
15. Tests (mock `walletProvider.getPublicClient().call` for reads + `sendTransaction` for writes).
16. README documenting the async boundary prominently.
17. `pnpm test`, `pnpm run lint`, `pnpm run format` — all green.
18. Changeset (patch).
19. Signed commits; PR with template filled; link the tracking issue.

Example `supportsNetwork`:
```typescript
supportsNetwork = (network: Network) =>
  network.protocolFamily === "evm" && (network.chainId === "999" || network.chainId === "998");
```

---

## 7. Testing Plan
- Mock `EvmWalletProvider.getPublicClient().call` (the raw `eth_call`; there is no `staticcall` method) to return encoded precompile struct bytes; assert `decodeAbiParameters` + px conversion.
- Mock `sendTransaction` to assert **exact CoreWriter calldata** (version byte, action-ID bytes, abi-encoded payload, `1e8` scaling) against the GitBook example byte layout.
- Assert `supportsNetwork` true for 999/998, false for Base/Polygon.
- Test open/close encode correctness and invalid-index handling.
- Assert the async "pending" return string is produced **and never claims a fill**.

---

## 8. Security Considerations
- **Async/settlement risk is the #1 issue:** never imply a fill; return pending + poll guidance. Treat every CoreWriter action as eventually-consistent and possibly-failing; recommend a two-phase verify (read the precompile after settlement).
- **Oracle/precompile manipulation:** precompile prices are validator-set-derived. The **JELLY incident (March 2025)** showed the risk — an attacker manipulated the JELLYJELLY memecoin; Hyperliquid's HLP vault was down ~$13.5M at one point before the exchange forcibly closed positions and validators voted to delist/settle at $0.0095 (vs the ~$0.50 oracle-fed price). Use `limitPx` protection and consider circuit-breaker thresholds.
- **Stale-read hazard:** precompile snapshots are start-of-block; do not assume CoreWriter writes are reflected in same-block reads.
- **Scaling errors:** `1e8` price/size mis-scaling can cause catastrophic mis-sized orders — validate and clamp inputs.
- **Network mismatch** guarded via `supportsNetwork` (999/998 only).
- **Funds-location precondition:** perp actions require collateral on the perp side; document the USD-class-transfer / bridging prerequisites.
- **Invalid precompile inputs consume all gas** — validate indices before calling.

---

## 9. Open Questions / Gaps (evidence-graded — resolve before merge)
- **`set_leverage` via CoreWriter: GAP / CONFIRMED-absent** — no leverage action in the published table (1–15). Verify against the live on-chain `CoreWriter` ABI before implementing; otherwise document as unsupported-from-HyperEVM and ship 4 actions. **Blocking decision for the 5th action.**
- Precompile addresses `0x0800`–`0x080C`: **CONFIRMED** (canonical `L1Read.sol` via GitBook + QuickNode, cross-checked).
- CoreWriter address + encoding + action IDs: **CONFIRMED** (Hyperliquid GitBook).
- CoreWriter live on mainnet: **CONFIRMED** (since July 5, 2025; official X + The Defiant).
- Reading "all markets" purely from precompiles: **WEAK SIGNAL** — needs an explicit index list or the native meta API; document the chosen approach.
- Maintainer preference for the native-API approach over HyperEVM: **WEAK SIGNAL** — task scope mandates HyperEVM; confirm via the issue first and be ready to justify or split.
- `coreUserExists` / `accountMarginSummary` / `bbo` precompiles: **WEAK SIGNAL** (community libs only, not canonical `L1Read.sol`) — do not depend on them without on-chain verification.
- Hyperliquid usage stat for the merge justification: **STRONG SIGNAL but unpinned** — pin an exact date-stamped OI/volume number from DeFiLlama/Dune in the issue.
