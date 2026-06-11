# PRD — Hyperliquid ActionProvider (HyperEVM target) for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit), the open-source TypeScript monorepo. **The goal is a PR that Coinbase merges into the official repo.** This document is self-contained: it carries every convention, address, ABI tuple, scaling formula, and acceptance criterion you need. You do **not** have access to prior conversations.
>
> **Evidence grades** are attached to load-bearing facts: `CONFIRMED` (verified against a primary source this revision), `DERIVED` (follows from confirmed facts by standard convention, but not quoted verbatim — safe to implement, must be covered by a test), `VERIFY-BEFORE-SHIP` (do the cited check before relying on it; do not guess), `UNVERIFIED` (could not confirm — do NOT depend on it). Where a fact is graded below `CONFIRMED`, the exact re-verification step is spelled out inline.
>
> **One decisive constraint, design around it from line one:** Hyperliquid's HyperEVM actions are **asynchronous and non-atomic**. A successful EVM transaction to the CoreWriter contract does **NOT** mean an order filled. Reads (precompiles) are start-of-block snapshots; writes (CoreWriter) are queued, few-second-delayed, eventually-consistent L1 actions with **no in-transaction confirmation and no revert on core-side failure** (`CONFIRMED` §2.4/§2.6). Any abstraction that makes `open_position` *look* synchronous to the LLM will produce incorrect agent behavior. Preserve "submitted; settlement is async; poll to confirm" end-to-end — including in the action `description` the LLM reads.
>
> **Second flagged item — RESOLVED:** `set_leverage` has **no CoreWriter action ID** (`CONFIRMED-absent` §2.5/§4/§9). Ship **4 actions**; document leverage as unsupported-from-HyperEVM. Do not ship a guessed action ID.

---

## 0.0 Research-resolution log (revision 2 — 2026-06-11)

This revision resolves every item the previous draft left vague. Primary sources re-verified on **2026-06-11**: canonical `L1Read.sol` (retrieved verbatim from GitHub — `HaroldRobson/Delta0/.../L1Read.sol`, cross-checked against `hyperliquid-dev/hyper-evm-lib/test/utils/L1Read.sol`); `hyperliquid-dev/hyper-evm-lib` `CoreWriterLib.sol` + `common/HLConstants.sol` (CoreWriter action IDs/tuples); deployed `CoreWriter.sol` (`hyperevmscan.io/address/0x3333…3333` + multiple verbatim GitHub mirrors); Hyperliquid GitBook *Interacting with HyperCore* / *Interaction timings* (prose cross-checked via search snippets — GitBook 403s automated fetch); AgentKit conventions read directly from the local repo at `typescript/agentkit/`.

| # | Previously vague | Resolution this revision | Grade |
|---|---|---|---|
| 1 | `set_leverage` action ID | **No leverage action exists in CoreWriter** (IDs 1–13, 15 confirmed; 14 reserved/unknown; none set leverage). Ship 4 actions; document the gap. | `CONFIRMED-absent` |
| 2 | Precompile return structs | Full verbatim Solidity structs + exact viem `decodeAbiParameters` tuples given (§2.3, §A). Current `Position` has **5** fields; `markPx`/`oraclePx`/`spotPx` take **`uint32`** (older copies used `uint16` — do not use them). | `CONFIRMED` |
| 3 | "computed unrealized PnL" | Exact size/notional/entry-price/PnL arithmetic given (§A.3). Size de-scales by `szDecimals` (`DERIVED`); USD notional `entryNtl` de-scales by `1e6` (`DERIVED`). | `DERIVED` |
| 4 | Order `limitPx`/`sz` scaling | Rule: send `uint64(round(human × 1e8))` for **both** (GitBook). `szDecimals` interaction with rounding is the one residual risk → `VERIFY-BEFORE-SHIP` against `hyper-evm-lib` (§2.7). | `CONFIRMED` rule / `VERIFY` rounding |
| 5 | CoreWriter byte layout | `0x01` version + 3-byte big-endian action ID + `abi.encode(payload)`. Header for ID 1 = `0x01000001`. Canonical test vector in §2.7. | `CONFIRMED` |
| 6 | `get_markets` "all markets" | No canonical precompile enumerates the perp set → **require an explicit `indices` array** (min 1). Full enumeration needs the native meta API (out of scope). Documented in README. | `CONFIRMED-design` |
| 7 | AgentKit conventions (wallet param order, schema style, mocks, changeset) | Verified against live repo and pinned in §0.3 / §7. `getPublicClient().call({to,data})` returns `{ data }`; **no in-repo provider uses `.call` yet — this provider is the first**, so the mock pattern is specified explicitly. | `CONFIRMED` |

If you (the implementing agent) find any `CONFIRMED` fact contradicted by the live source, STOP and flag it — do not silently "fix" it in code.

---

## 0. The merge target: AgentKit conventions (authoritative, verified against the local repo 2026-06-11)

These are the rules your PR is graded against. Verified against `typescript/agentkit/` source (not docs) and `CONTRIBUTING-TYPESCRIPT.md`.

### 0.1 Toolchain
- **Node.js v22.x+**, **pnpm 10.7.x+**, Turborepo. Run all commands from the `typescript/` monorepo root.
- `pnpm install` (from `typescript/`) first.
- Tests: `pnpm test` (jest). Lint: `pnpm run lint` / `pnpm run lint:fix`. Format: `pnpm run format` (ESLint + Prettier).
- Changelog: `pnpm run changeset` (interactive) → package `@coinbase/agentkit`, type **patch**, past-tense summary, e.g. *"Added a Hyperliquid action provider for perpetuals trading via HyperEVM."*
- **All commits MUST be signed** (`git commit -S`) — hard merge gate (`cb-heimdall` CI). *(Fork-workflow note: signing is done by the human at PR time; commits on the working branch may be unsigned.)*
- Scaffolding: `generate-action-provider` script at `typescript/agentkit/scripts/generate-action-provider/`; or copy the `pyth` provider layout.

### 0.2 Required file layout
Provider at `typescript/agentkit/src/action-providers/hyperliquid/`:
```
hyperliquid/
├── hyperliquidActionProvider.ts      # provider class + @CreateAction methods
├── schemas.ts                        # Zod schemas
├── constants.ts                      # chainIds, RPC URLs, precompile addrs, CoreWriter addr, action IDs, decode/encode ABI tuples, scaling consts
├── utils.ts                          # action encoding, precompile read (getPublicClient().call) + decode, px/size scaling, PnL
├── hyperliquidActionProvider.test.ts # jest unit tests (REQUIRED)
├── index.ts                          # exports
└── README.md                         # per-provider README (REQUIRED)
```
Re-export from `typescript/agentkit/src/action-providers/index.ts` with one line: `export * from "./hyperliquid";` (alphabetical-ish, matching the existing list).

### 0.3 The canonical provider pattern (verified house style)

> ⚠️ **Repo dependency baseline (verified against `typescript/agentkit/package.json`, 2026-06-11):** the package ships **`zod@^4.3.6` (Zod v4)**, **`viem@2.47.4`**, **`ethers@^6.13.5` (ethers v6)**. Write against these majors. This provider uses **viem only** (no ethers).

**Verified `EvmWalletProvider` API surface** (`typescript/agentkit/src/wallet-providers/evmWalletProvider.ts` + inherited `walletProvider.ts`). These are the only methods an action may call on the wallet:

| Method | Signature | Notes |
|---|---|---|
| `getAddress()` | `(): string` | the agent EOA; default `user` for reads |
| `getNetwork()` | `(): Network` | `{ protocolFamily, networkId?, chainId? }`; `chainId` is a **string** |
| `sendTransaction(tx)` | `(TransactionRequest): Promise<\`0x${string}\`>` | returns tx hash |
| `waitForTransactionReceipt(hash)` | `(\`0x${string}\`): Promise<any>` | receipt typed `any` |
| `readContract(params)` | viem `ReadContractParameters` → `Promise<ReadContractReturnType>` | needs ABI+function; **does NOT fit raw precompiles** |
| `getPublicClient()` | `(): PublicClient` (viem) | use `.call({ to, data })` for raw precompile reads; returns `{ data }` |
| `signTypedData` / `sign` / `signMessage` | … | not needed here |

**There is NO `staticcall` method.** Raw precompile reads go through `getPublicClient().call({ to, data })`. **No existing in-repo provider uses `.call` yet** (reads elsewhere use `readContract`/`multicall`), so this provider establishes the pattern — the test must mock `getPublicClient` to return an object exposing `call` (see §7).

```typescript
// schemas.ts — house style: every field .describe(); object .describe(); NO .strip(), NO .strict()
const OpenPositionSchema = z
  .object({
    asset: z.number().int().nonnegative().describe("HyperCore perp asset index (uint32), e.g. 0 for the first listed perp"),
    isBuy: z.boolean().describe("true = long/buy, false = short/sell"),
    // ...
  })
  .describe("Submit a limit order to open or add to a Hyperliquid perp position via CoreWriter");

// provider class
export class HyperliquidActionProvider extends ActionProvider<EvmWalletProvider> {
  constructor() {
    super("hyperliquid", []);          // super(<name string>, [])
  }

  @CreateAction({
    name: "open_position",
    description: `... LLM prompt: inputs, outputs, the async "submitted ≠ filled, poll to confirm" semantics ...`,
    schema: OpenPositionSchema,
  })
  async openPosition(
    walletProvider: EvmWalletProvider,        // wallet param FIRST
    args: z.infer<typeof OpenPositionSchema>, // args SECOND
  ): Promise<string> {                        // EVERY action returns Promise<string>
    try {
      // ...encode + sendTransaction...
      return JSON.stringify({ success: true, status: "submitted", note: "settlement is async; poll get_positions to confirm", txHash });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error opening position: ${error}` }); // errors RETURNED, never thrown
    }
  }

  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && (network.chainId === "999" || network.chainId === "998");
}

export const hyperliquidActionProvider = () => new HyperliquidActionProvider();   // factory export
```

**Non-negotiable conventions (verified against `erc721`, `erc20`, `pyth`, `actionDecorator.ts`):**
1. Class `extends ActionProvider<EvmWalletProvider>`; wallet param typed `EvmWalletProvider`.
2. Constructor `super("hyperliquid", [])`.
3. Every action: `async`, `@CreateAction({ name, description, schema })`, signature `(walletProvider, args)`, returns `Promise<string>`. (The decorator auto-prefixes the action name to `HyperliquidActionProvider_<name>`; max 2 params enforced.)
4. **Schemas:** plain `z.object({...}).describe(...)`, `.describe()` on **every** field and on the object. **No `.strip()`, no `.strict()`** — verified dominant house style (35/37 schema files; `pyth`/`defillama` `.strict()` are stale outliers; `.strip()` is used nowhere).
5. **Errors are caught and returned as strings** — actions never throw.
6. `description` is an LLM prompt — write-action descriptions MUST state the async "submitted ≠ filled, poll to confirm" semantics so the LLM does not assume a fill.
7. `supportsNetwork` is an arrow-function property (last member of the class).
8. Factory `export const hyperliquidActionProvider = () => new HyperliquidActionProvider();`.
9. Decorators need `experimentalDecorators` + `emitDecoratorMetadata` (already set in the monorepo).

**Return-shape convention for THIS provider (be consistent):** every action returns a JSON string. Success: `{ success: true, ... }`. Failure: `{ success: false, error: "<message>" }`. Write actions additionally carry `status: "submitted"` and a `note` restating async settlement. (Mirrors the `JSON.stringify` style of `pyth`; reads in `erc20`/`erc721` return prose, but JSON is cleaner for the structured data here and is allowed.)

> ⚠️ **How to actually read a precompile (the wallet API has no `staticcall`).** Hyperliquid precompiles take **raw abi-encoded args with no function selector/ABI**, so `readContract` (needs ABI+function name) does NOT fit. Use a **raw viem `eth_call`** via the public client:
> ```typescript
> import { encodeAbiParameters, decodeAbiParameters } from "viem";
> const client = walletProvider.getPublicClient();
> const data = encodeAbiParameters(PRECOMPILE_ARG_TYPES, args);   // e.g. [{type:"address"},{type:"uint16"}]
> const res  = await client.call({ to: PRECOMPILE_ADDR, data });  // returns { data: `0x...` }
> const decoded = decodeAbiParameters(PRECOMPILE_RETURN_TUPLE, res.data!);
> ```
> Everywhere this PRD says "read a precompile," implement it as `getPublicClient().call({ to, data })` + `encode/decodeAbiParameters`. Writes to CoreWriter use `walletProvider.sendTransaction({ to: CoreWriter, data })`.

### 0.4 Acceptance criteria checklist (the PR rubric)
- [ ] All actions return `Promise<string>`; errors returned (not thrown).
- [ ] Zod schemas: plain `z.object({...}).describe(...)`, every field `.describe()`, **no `.strip()`/`.strict()`** (matches live `erc721` schemas; Zod v4).
- [ ] `supportsNetwork` Hyperliquid-only (chainId `"999"` mainnet, `"998"` testnet).
- [ ] Unit tests pass via `pnpm test`; mirror `pythActionProvider.test.ts` (fetch-free) + `erc721ActionProvider.test.ts` (mocked wallet) patterns.
- [ ] `pnpm run lint` and `pnpm run format` clean; `pnpm build` clean.
- [ ] Per-provider `README.md` present **and prominently documents the HyperEVM↔HyperCore async boundary, "submitted ≠ filled" semantics, the `set_leverage` gap, and the funds-on-perp precondition**.
- [ ] Changeset added (patch, past tense).
- [ ] Signed commits (human, at PR time); PR template filled; tracking issue linked.
- [ ] Naming exact: directory `hyperliquid`, class `HyperliquidActionProvider`, factory `hyperliquidActionProvider`, name string `"hyperliquid"`.
- [ ] Re-exported from `src/action-providers/index.ts`.
- [ ] **4 actions shipped** (`get_markets`, `get_positions`, `open_position`, `close_position`); `set_leverage` documented as unsupported-from-HyperEVM (NOT implemented — see §4/§9).

### 0.5 Merge-likelihood note (do this BEFORE writing code — human task)
AgentKit is **Base-first**; Hyperliquid is **chainId 999 / HyperEVM**. **Open a GitHub issue on `coinbase/agentkit` first** describing the provider, the off-Base network, the HyperEVM (vs native-L1-API) approach, and the broadly-useful justification (Hyperliquid is the dominant perp DEX by volume — pin an exact date-stamped OI/volume figure from DeFiLlama/Dune in the issue). Be ready to justify HyperEVM over the native L1 REST API: composability with on-chain contracts and no off-chain signing server. A maintainer may prefer the native-API surface — confirm before building. Re-check `github.com/coinbase/agentkit/pulls` for an in-flight Hyperliquid PR before starting. *(Fork-workflow note: issue/PR creation is human-only; the implementing agent does not open issues or PRs.)*

---

## 1. Executive Summary

The Hyperliquid ActionProvider lets an AgentKit agent interact with Hyperliquid's perp engine **from HyperEVM smart contracts** (not the native L1 REST API): read market data and positions via HyperCore read precompiles, and open/close positions by sending actions through the CoreWriter system contract. The integration surface is HyperEVM (chainId 999) JSON-RPC: raw `eth_call` to read precompiles (`0x0800`–`0x080C`) and a transaction to CoreWriter (`0x3333…3333`). The dominant technical and architectural risk is the **HyperEVM↔HyperCore boundary**: HyperEVM cannot directly reach the L1 order book; reads are snapshotted at EVM block construction, and writes are **asynchronous, queued, delayed-by-a-few-seconds, non-atomic** CoreWriter actions that cannot be confirmed in the same transaction.

**4 actions:** `get_markets`, `get_positions`, `open_position`, `close_position`.
**Not shipped (documented gap):** `set_leverage` — no CoreWriter action exists for it (§4/§9).

---

## 2. Protocol Background (primary-source grounded)

### 2.1 Architecture (`hyperliquid.gitbook.io` /for-developers/hyperevm) — `CONFIRMED`
- **HyperCore** = native L1 order book / perp engine (HyperBFT consensus, one-block finality). No general-purpose smart contracts.
- **HyperEVM** = EVM execution layer (Cancun, no blob). Shares one chain with HyperCore.
- Contracts on HyperEVM **read** HyperCore state via precompiles and **write** via CoreWriter. The direction is strictly **HyperEVM → HyperCore**.

### 2.2 Network details — `CONFIRMED`
- **Mainnet:** chainId **999**, JSON-RPC `https://rpc.hyperliquid.xyz/evm`, native gas token **HYPE** (18 decimals on EVM). Explorer: `hyperevmscan.io` / purrsec.com.
- **Testnet:** chainId **998**, JSON-RPC `https://rpc.hyperliquid-testnet.xyz/evm`.
- ⚠️ chainId 999 collides with **Wanchain Testnet** in some wallet registries (reown/appkit issue #5391) — pin the RPC explicitly; do not rely on registry chain lookups. (`supportsNetwork` matches on `chainId` string only; the wallet provides the RPC — the AP does not construct its own client.)
- Block model: small blocks ~1 s / 2M gas; big blocks ~1 min / 30M gas (needed for contract deploys; not for these actions).

### 2.3 Read precompiles — `CONFIRMED` verbatim against canonical `L1Read.sol` (2026-06-11)
All addresses `0x…0800`–`0x…080C`, read via a **raw `eth_call`** (abi-encoded args, **no function selector**), i.e. `walletProvider.getPublicClient().call({ to, data })` + `encode/decodeAbiParameters`.

> ⚠️ **Version warning (`CONFIRMED`):** older `L1Read.sol` copies (early/mid-2025: Kinetiq, Felix, hello-hl) differ materially — they stop at `0x809`, `markPx`/`oraclePx` take **`uint16`**, and `Position` has only 3 fields `{int64 szi; uint32 leverage; uint64 entryNtl;}`. **Use the CURRENT shape below** (`uint32` price index; 5-field `Position`). Do not copy an old snippet.

| Address | Function | Input ABI | Return |
|---|---|---|---|
| `0x…0800` | `position` | `(address user, uint16 perp)` | `Position` |
| `0x…0801` | `spotBalance` | `(address user, uint64 token)` | `SpotBalance` |
| `0x…0802` | `userVaultEquity` | `(address user, address vault)` | `UserVaultEquity` |
| `0x…0803` | `withdrawable` | `(address user)` | `Withdrawable` |
| `0x…0804` | `delegations` | `(address user)` | `Delegation[]` |
| `0x…0805` | `delegatorSummary` | `(address user)` | `DelegatorSummary` |
| `0x…0806` | `markPx` | `(uint32 index)` | `uint64` |
| `0x…0807` | `oraclePx` | `(uint32 index)` | `uint64` |
| `0x…0808` | `spotPx` | `(uint32 index)` | `uint64` |
| `0x…0809` | `l1BlockNumber` | `()` | `uint64` |
| `0x…080a` | `perpAssetInfo` | `(uint32 perp)` | `PerpAssetInfo` |
| `0x…080b` | `spotInfo` | `(uint32 spot)` | `SpotInfo` |
| `0x…080C` | `tokenInfo` | `(uint32 token)` | `TokenInfo` |

**Verbatim current structs (`CONFIRMED`):**
```solidity
struct Position { int64 szi; uint64 entryNtl; int64 isolatedRawUsd; uint32 leverage; bool isIsolated; }
struct PerpAssetInfo { string coin; uint32 marginTableId; uint8 szDecimals; uint8 maxLeverage; bool onlyIsolated; }
struct SpotBalance { uint64 total; uint64 hold; uint64 entryNtl; }
struct Withdrawable { uint64 withdrawable; }
struct DelegatorSummary { uint64 delegated; uint64 undelegated; uint64 totalPendingWithdrawal; uint64 nPendingWithdrawals; }
struct UserVaultEquity { uint64 equity; uint64 lockedUntilTimestamp; }
struct SpotInfo { string name; uint64[2] tokens; }
struct TokenInfo { string name; uint64[] spots; uint64 deployerTradingFeeShare; address deployer; address evmContract; uint8 szDecimals; uint8 weiDecimals; int8 evmExtraWeiDecimals; }
```
(Exact viem decode tuples for the ones this provider uses are in **Appendix A.1**.)

- **Price conversion (`CONFIRMED`):** divide returned px by `10^(6 − szDecimals)` (perps) or `10^(8 − base szDecimals)` (spot). `szDecimals` comes from `perpAssetInfo(perp).szDecimals` (perps) / `tokenInfo(token).szDecimals` (spot). See §A.2.
- **Precompile gas (`CONFIRMED`):** `2000 + 65 * (input_len + output_len)`. **Invalid inputs (bad asset/vault) return an error and consume ALL gas in the call frame** — validate indices before calling.
- **Staleness (`CONFIRMED`):** reads reflect HyperCore state **at the start of the EVM block**. Block processing order is L1 block → EVM block → EVM⇒Core transfers → CoreWriter actions, so **CoreWriter writes are NOT visible to same-block precompile reads** (read-after-write returns stale data).
- ⚠️ `accountMarginSummary` (`0x80F`), `bbo` (`0x80e`), `coreUserExists` (`0x810`), `tokenSupply` (`0x80D`), `position2` (`0x813`), borrow-lend states (`0x811/0x812`) are **NOT in canonical `L1Read.sol`** — they appear only in community libs (`hyper-evm-lib`). Grade `UNVERIFIED` (may be live on-chain but undocumented). **Do not use them.** This provider touches only `0x0800`, `0x0806`, `0x0807`, `0x080a`.

### 2.4 CoreWriter system contract — `CONFIRMED` (deployed source + GitBook)
- Address: `0x3333333333333333333333333333333333333333`.
- Entry: `function sendRawAction(bytes calldata data) external;` — emits `event RawAction(address indexed user, bytes data);`. The contract burns ~20k gas in an internal loop then emits the log; HyperCore dequeues and executes asynchronously.
- **Encoding (`CONFIRMED`):** byte 0 = version `0x01`; bytes 1–3 = action ID (big-endian `uint24`); bytes 4+ = `abi.encode(payload)`. Header for action ID 1 = `0x01 0x00 0x00 0x01`. (GitBook's worked example uses `0x01 0x00 0x00 0x07` for usdClassTransfer = ID 7, confirming the pattern.)
- Gas: ~20k burned on-contract (verified in source); GitBook cites ~47k for a "basic call" including HyperCore-side processing (`VERIFY` exact figure — GitBook-snippet-sourced).
- **Async/non-atomic (`CONFIRMED`):** order/vault-transfer actions are deliberately delayed onchain a few seconds to prevent latency arbitrage; `sendRawAction` is fire-and-forget — it emits the event and hands off to HyperCore, and **does NOT revert if the core-side action later fails.** (Confirmed in GitBook *Interacting with HyperCore* / *Interaction timings* and independent `ICoreWriter.sol` interface comments.)
- Live on HyperEVM mainnet since **~July 7, 2025** (`CONFIRMED-approx`: official Hyperliquid X post dated 2025-07-21 says "activated two weeks ago"; exact calendar day is relative). ⚠️ The QuickNode guide's stale "not yet available on mainnet" sentence is outdated — ignore it.

### 2.5 CoreWriter action IDs — `CONFIRMED` (IDs from `hyper-evm-lib/common/HLConstants.sol`; tuples from `CoreWriterLib.sol`)
| ID | Action | Fields (order) | Solidity types tuple |
|---|---|---|---|
| 1 | Limit order | (asset, isBuy, limitPx, sz, reduceOnly, encodedTif, cloid) | `(uint32,bool,uint64,uint64,bool,uint8,uint128)` |
| 2 | Vault transfer | (vault, isDeposit, usd) | `(address,bool,uint64)` |
| 3 | Token delegate | (validator, wei, isUndelegate) | `(address,uint64,bool)` |
| 4 | Staking deposit | (wei) | `(uint64)` |
| 5 | Staking withdraw | (wei) | `(uint64)` |
| 6 | Spot send | (destination, token, wei) | `(address,uint64,uint64)` |
| 7 | USD class transfer | (ntl, toPerp) | `(uint64,bool)` |
| 8 | Finalize EVM contract | (token, variant, createNonce) | `(uint64,uint8,uint64)` |
| 9 | Add API wallet | (address, name) | `(address,string)` |
| 10 | Cancel order by oid | (asset, oid) | `(uint32,uint64)` |
| 11 | Cancel order by cloid | (asset, cloid) | `(uint32,uint128)` |
| 12 | Approve builder fee | (maxFeeRate, builder) | `(uint64,address)` |
| 13 | Send asset | (destination, subAccount, source_dex, destination_dex, token, wei) | `(address,address,uint32,uint32,uint64,uint64)` |
| 14 | **RESERVED / UNVERIFIED** — encoder lib skips 14 (defines 13 then 15). Not leverage. Do not use. | — | — |
| 15 | Borrow/lend operation | (encodedOperation, token, wei) | `(uint8,uint64,uint64)` |

- **Only action ID 1 (limit order) is used by this provider.** Both `open_position` and `close_position` are limit orders (the latter with `reduceOnly=true`).
- **Limit-order encoding (`CONFIRMED` types / GitBook scaling):** Tif `1`=Alo, `2`=Gtc, `3`=Ioc; cloid `0` = none. **`limitPx` and `sz` are sent as `uint64(round(human × 1e8))`** (see §2.7 + §A.4 for the residual `szDecimals`-rounding `VERIFY` step).
- ⚠️ **There is NO "set leverage" action (`CONFIRMED-absent`).** Leverage/margin-mode are HyperCore L1 operations (`updateLeverage`/`updateIsolatedMargin` native API), not exposed via CoreWriter. See §4/§9.

### 2.6 Async boundary (verbatim, `CONFIRMED`)
- Reads: "values are guaranteed to match the latest HyperCore state at the time the EVM block is constructed" → start-of-block snapshot.
- Writes: queued, few-second-delayed, executed in the first HyperCore block after the EVM block; non-atomic; no revert on core-side failure.
- **Consequence:** `open_position` / `close_position` CANNOT confirm a fill. They submit a queued action and return *"submitted; settlement is async (few-second delay); poll get_positions to confirm"* — never asserting a fill.

### 2.7 CoreWriter limit-order wire format — exact spec + canonical test vector (`CONFIRMED` layout)

**Construction (in `utils.ts`):**
```typescript
// 1. scale (see §A.4 — VERIFY rounding rule before ship)
const limitPxU64 = BigInt(Math.round(humanLimitPx * 1e8));  // uint64
const szU64      = BigInt(Math.round(humanSize    * 1e8));  // uint64
// 2. abi-encode the payload tuple (no selector)
const payload = encodeAbiParameters(
  [{type:"uint32"},{type:"bool"},{type:"uint64"},{type:"uint64"},{type:"bool"},{type:"uint8"},{type:"uint128"}],
  [asset, isBuy, limitPxU64, szU64, reduceOnly, encodedTif, cloidU128],
);
// 3. prepend version(0x01) + 3-byte big-endian action id (1)
const data = concat(["0x01000001", payload]);   // viem concat; "0x01000001" = version 0x01 + uint24(1)
const txHash = await walletProvider.sendTransaction({ to: CORE_WRITER_ADDRESS, data });
```

**Canonical test fixture (assert exact calldata in the unit test).** Inputs: `asset=1, isBuy=true, humanLimitPx=1.0, humanSize=1.0, reduceOnly=false, tif=Ioc(3), cloid=0`. Then `limitPxU64 = szU64 = 1e8 = 0x05F5E100`. Expected `data` =
```
0x01000001                                                          ← version + action id 1
0000000000000000000000000000000000000000000000000000000000000001   ← asset    (uint32 = 1)
0000000000000000000000000000000000000000000000000000000000000001   ← isBuy    (true)
0000000000000000000000000000000000000000000000000000000005f5e100   ← limitPx  (1e8)
0000000000000000000000000000000000000000000000000000000005f5e100   ← sz       (1e8)
0000000000000000000000000000000000000000000000000000000000000000   ← reduceOnly(false)
0000000000000000000000000000000000000000000000000000000000000003   ← encodedTif(Ioc)
0000000000000000000000000000000000000000000000000000000000000000   ← cloid    (0)
```
The test asserts `mockWallet.sendTransaction` was called with `{ to: CORE_WRITER_ADDRESS, data: <above> }`. (This is the single most important regression test — mis-scaling here mis-sizes orders.)

### 2.8 Existing tooling (reference only)
- `hyperliquid-dev/hyper-evm-lib` (Solidity: `CoreWriterLib`, `PrecompileLib`, `HLConstants`; by Obsidian Audits) — the canonical encoder/decoder reference. **Use it to VERIFY the `sz`/`limitPx` rounding rule (§A.4) and the action-ID constants before shipping.**
- TS L1 SDKs (`nktkas/hyperliquid`, `nomeida/hyperliquid`) target the **native API, not** HyperEVM precompiles/CoreWriter — reference only.

---

## 3. Architecture & Integration Boundary (CRITICAL)
- **HyperEVM (what the AP touches directly):** JSON-RPC at chainId 999. Reads = raw `eth_call` to precompiles `0x0800`–`0x080a` via `walletProvider.getPublicClient().call({ to, data })`. Writes = `walletProvider.sendTransaction` to CoreWriter `0x3333…3333`.
- **HyperCore (reachable only indirectly):** the perp order book / clearinghouse — NOT directly callable from EVM. Reads are snapshots; writes are queued L1 actions.
- **Read path:** EVM → precompile `eth_call` → HyperCore state as of the **start of the current EVM block**. CoreWriter actions submitted this block are NOT reflected until a later block.
- **Write path:** EVM tx → `CoreWriter.sendRawAction(encoded)` → emits a log → HyperCore dequeues and executes after a few-second delay → result observable only via a later precompile read or the native API. **Non-atomic, eventually-consistent, possibly-failing. No return value; no revert if the core action itself fails.**
- **Account model:** CoreWriter actions execute on behalf of the calling address's implied HyperCore account (or an approved API wallet — action ID 9). An EOA AgentKit wallet calling CoreWriter directly acts as that EOA's core account. **Funds must already be on the HyperCore perp side** — moving them there is itself a CoreWriter "USD class transfer" (ID 7) / bridge flow (**out of scope for v1, but documented as a precondition in the README and in the `open_position` description**).
- **Consequence for design:** the write actions submit a queued action and must return *"submitted; settlement is async; poll get_positions to confirm"* — never asserting a fill.

---

## 4. Action-by-Action Spec (sub-task complete)

Conventions for all actions: input validation runs FIRST and returns a `{success:false,error}` string on failure (never throws); all numeric indices validated as non-negative integers within their uint width BEFORE any precompile call (invalid precompile inputs consume all gas — §2.3); all reads use the §0.3 raw-`eth_call` helper; px/size scaling uses the §A formulas.

### 4.1 `get_markets` — read-only
- **Schema (`GetMarketsSchema`):**
  - `indices: number[]` — **required, min length 1**. "Array of HyperCore perp asset indices (uint32) to fetch, e.g. [0, 1, 2]. There is no on-chain way to enumerate all perps from precompiles; pass the explicit indices you care about. Full market discovery uses the native info API (out of scope)."
  - `includePrices?: boolean` (default `true`) — "If true, also fetch mark and oracle prices per asset."
- **Steps:**
  1. Validate every index is an integer in `[0, 2^32)`; dedupe. On any invalid → return error string listing the bad index.
  2. For each index: read `perpAssetInfo(index)` (`0x080a`) → `{coin, marginTableId, szDecimals, maxLeverage, onlyIsolated}`.
  3. If `includePrices`: read `markPx(index)` (`0x0806`) and `oraclePx(index)` (`0x0807`); convert with `szDecimals` via §A.2 (`humanPx = rawPx / 10^(6 − szDecimals)`).
  4. Return JSON: `{ success:true, markets: [{ index, coin, szDecimals, maxLeverage, onlyIsolated, marginTableId, markPx?, oraclePx? }] }` (prices as decimal strings to avoid float loss).
- **Edge cases:** invalid index (validate first); precompile staleness (note in README); decimal conversion (§A.2). A single bad index should not abort the whole batch silently — either validate-all-then-call, or collect per-index errors into the result. Choose validate-all-up-front (simpler, matches the gas-safety rule).
- **Unit tests:** mock `getPublicClient().call` to return encoded `PerpAssetInfo` bytes (+ `markPx`/`oraclePx` words); assert decoded fields and px conversion for a known `szDecimals`; assert invalid index returns an error without calling `.call`.

### 4.2 `get_positions` — read-only
- **Schema (`GetPositionsSchema`):**
  - `user?: string` (default = `walletProvider.getAddress()`) — "EVM address whose HyperCore positions to read; defaults to the agent wallet. Validate as a 0x-prefixed 20-byte address."
  - `perpIndices: number[]` — **required, min length 1** — "Perp asset indices to check (same indices as get_markets)."
- **Steps:**
  1. Resolve `user` (default to wallet address); validate address format and each index (`uint16` range for the `position` precompile arg — `[0, 2^16)`; note the narrower width vs `get_markets`).
  2. For each index: read `position(user, index)` (`0x0800`, arg tuple `(address,uint16)`) → `Position{szi, entryNtl, isolatedRawUsd, leverage, isIsolated}`.
  3. For PnL: also read `markPx(index)` (`0x0806`) and `perpAssetInfo(index).szDecimals` (`0x080a`).
  4. Compute per §A.3: `sizeHuman = szi / 10^szDecimals`; `entryNotional = entryNtl / 1e6`; `markHuman = markPx / 10^(6 − szDecimals)`; `avgEntryPx = entryNotional / |sizeHuman|` (guard `szi == 0`); `unrealizedPnl = sizeHuman * markHuman − sign(szi) * entryNotional`.
  5. Return JSON: `{ success:true, user, positions: [{ index, szi, size: sizeHuman, isLong, leverage, isIsolated, entryNotional, avgEntryPx, markPx: markHuman, unrealizedPnl }] }` (numerics as decimal strings).
- **Edge cases:** zero position (`szi == 0` → return size 0, null avgEntryPx/PnL, do not divide by zero); isolated vs cross (`isIsolated`); decimal scaling (§A); `entryNtl`/`szi` decimal bases are `DERIVED` — cover with a test using a hand-checked example.
- **Unit tests:** mock `.call` to return encoded `Position` + `markPx` + `PerpAssetInfo` bytes; assert size sign, avgEntryPx, and PnL match a hand-computed fixture; assert `szi==0` path returns zeroed/null PnL.

### 4.3 `open_position` — write (CoreWriter, async)
- **Schema (`OpenPositionSchema`):**
  - `asset: number` (int, `[0,2^32)`) — perp asset index.
  - `isBuy: boolean` — true = long, false = short.
  - `size: number` (positive) — human-readable contract size (base units).
  - `limitPx: number` (positive) — human-readable limit price. For a market-like fill, pass an aggressive price (far above mark for buys / below for sells) with `tif="Ioc"`.
  - `tif?: "Alo"|"Gtc"|"Ioc"` (default `"Ioc"`).
  - `reduceOnly?: boolean` (default `false`).
  - `cloid?: string` (default none) — "optional client order id as a uint128 decimal/hex string; omit or 0 for none."
- **Steps:** (1) validate inputs (positive size/px, asset in range, valid tif, cloid parses to `[0, 2^128)`); (2) scale `limitPx`,`size` → `uint64(round(×1e8))` (§A.4); (3) map tif → {Alo:1,Gtc:2,Ioc:3}; (4) parse cloid → uint128 (0 = none); (5) `encodeAbiParameters` the ID-1 payload; (6) prepend `0x01000001` (§2.7); (7) `sendTransaction({to: CoreWriter, data})`; (8) `waitForTransactionReceipt(hash)`; (9) return `{ success:true, status:"submitted", txHash, note:"Order submitted to CoreWriter. Settlement on HyperCore is asynchronous (a few-second delay) and NON-ATOMIC — a successful EVM tx does not mean the order filled. Poll get_positions to confirm." }`.
- **Risks/edge cases:** async non-atomic settlement (EVM tx success ≠ fill — never claim a fill); partial fills; IOC vs GTC resting behavior; `1e8` price/size scaling (the #1 catastrophic-error surface — validate and clamp); funds-on-perp precondition (document); slippage (aggressive `limitPx` + `Ioc` approximates a market order with a protective bound).
- **Unit tests:** assert exact CoreWriter calldata against the §2.7 fixture; assert the return string carries `status:"submitted"` and the async note and **never** the words "filled"/"executed"; assert tif/cloid mapping; assert invalid inputs return an error without calling `sendTransaction`.

### 4.4 `close_position` — write (CoreWriter, async, read-then-write)
- **Schema (`ClosePositionSchema`):**
  - `asset: number` (int, in range) — perp asset index.
  - `size?: number` (positive; default = full position size) — amount to close.
  - `cloid?: string` (optional).
- **Behavior:** (1) read current `position(user, asset)` (`0x0800`) to determine side (`sign(szi)`) and size; if `szi == 0` → return `{success:false,error:"No open position for asset <n>"}`; (2) determine close size = `min(size ?? |sizeHuman|, |sizeHuman|)`; (3) submit a **reduce-only** limit order (ID 1, `reduceOnly=true`, side = opposite of the position, aggressive `limitPx`, `tif=Ioc`); (4) `waitForTransactionReceipt`; (5) return submitted + pending note.
- **Aggressive `limitPx` for the reduce-only order:** read `markPx(asset)` and offset by a protective bound (e.g. for closing a long → sell at `markHuman * (1 − slippageBound)`; for closing a short → buy at `markHuman * (1 + slippageBound)`). Pick a conservative default bound (e.g. 5%) and document it; do NOT pass `0` (would never fill) and do NOT pass an unbounded price.
- **Edge cases:** position may change between the read and the write (stale snapshot — surface this risk in the return note); full vs partial close; reduce-only enforcement; `szi == 0`.
- **Unit tests:** mock `.call` to return a long `Position` + `markPx`; assert the emitted CoreWriter order is `reduceOnly=true`, opposite side, size = position size when `size` omitted; assert the `szi==0` early error; assert async note present.

### 4.5 `set_leverage` — NOT SHIPPED (documented gap, `CONFIRMED-absent`)
- **Verdict (resolved 2026-06-11):** CoreWriter exposes **no** leverage/margin-mode action (IDs 1–13, 15 enumerated; 14 reserved/unknown; none set leverage — §2.5). Leverage is set via the **native L1 API** (`updateLeverage` / `updateIsolatedMargin`) or an approved agent wallet, neither of which is reachable through `sendRawAction`. **Do NOT implement it and do NOT ship a guessed action ID.**
- **What to do instead:** ship 4 actions; in the README add a "Not supported" section explaining that leverage cannot be set from HyperEVM today and pointing to the native API. Do **not** add a stub action that always errors (adds an LLM-visible tool that can only fail — cleaner to omit). If a future CoreWriter revision adds a leverage action ID (verify against `hyper-evm-lib/HLConstants.sol` + the live ABI), it can be added then.

---

## 5. File Structure
(See §0.2.) `constants.ts` holds: chainId strings `"999"/"998"`, RPC URLs, the precompile address map, `CORE_WRITER_ADDRESS`, the limit-order action ID + header bytes, the px/size scale (`1e8`), and the viem ABI tuples (Appendix A.1, A.5). Put ABI tuples `as const` for viem type inference (model: `erc721/constants.ts`). `utils.ts` holds the read/encode helpers (Appendix A.5). Not every provider has `utils.ts`, but this one warrants it given the encode/decode/scaling logic.

---

## 6. Ordered Implementation Steps
1. `pnpm install` from `typescript/`; confirm Node 22 / pnpm 10.7; baseline `pnpm build`/`pnpm test` green.
2. (Human) open the tracking issue (§0.5); pin a Hyperliquid usage stat; re-check for collision PRs.
3. Scaffold `hyperliquid/` via `generate-action-provider` (or copy `pyth` + `erc721`).
4. `constants.ts`: chainIds, RPC URLs, precompile address map (`0x0800`,`0x0806`,`0x0807`,`0x080a`), `CORE_WRITER_ADDRESS`, `LIMIT_ORDER_ACTION_HEADER = "0x01000001"`, `PX_SIZE_SCALE = 1e8`, TIF map, decode/encode ABI tuples (§A.1/§A.5) `as const`.
5. `utils.ts`: `readPrecompile(publicClient, address, argTypes, args, returnTuple)` (`encodeAbiParameters` → `publicClient.call({to,data})` → `decodeAbiParameters`), `encodeLimitOrder(...)`, `convertPx(rawPx, szDecimals)`, `computePosition(...)` (size/entry/PnL), input validators.
6. `schemas.ts`: `GetMarketsSchema`, `GetPositionsSchema`, `OpenPositionSchema`, `ClosePositionSchema` (no `SetLeverageSchema`). Plain `.describe()` everywhere, no `.strict()`.
7. Provider class `HyperliquidActionProvider extends ActionProvider<EvmWalletProvider>`, `super("hyperliquid", [])`.
8. Implement `get_markets` (§4.1).
9. Implement `get_positions` (§4.2).
10. Implement `open_position` (§4.3).
11. Implement `close_position` (§4.4).
12. `supportsNetwork`: chainId `"999"`/`"998"` only.
13. Factory export + re-export from `src/action-providers/index.ts`.
14. **VERIFY-BEFORE-SHIP:** confirm the `sz`/`limitPx` rounding rule (§A.4) against `hyper-evm-lib/CoreWriterLib`; confirm the limit-order action ID constant.
15. Tests (mock `getPublicClient().call` for reads + `sendTransaction`/`waitForTransactionReceipt` for writes — §7).
16. README documenting the async boundary, `set_leverage` gap, and funds-on-perp precondition prominently.
17. `pnpm test`, `pnpm run lint`, `pnpm run format`, `pnpm build` — all green.
18. Changeset (patch, past tense).
19. (Human) signed commits; PR with template filled; link the tracking issue.

Example `supportsNetwork`:
```typescript
supportsNetwork = (network: Network) =>
  network.protocolFamily === "evm" && (network.chainId === "999" || network.chainId === "998");
```

---

## 7. Testing Plan (mirror `pythActionProvider.test.ts` + `erc721ActionProvider.test.ts`)

**Mock wallet shape (this provider needs `getPublicClient().call`):**
```typescript
let callMock: jest.Mock;
let mockWallet: jest.Mocked<EvmWalletProvider>;
beforeEach(() => {
  callMock = jest.fn();
  mockWallet = {
    getAddress: jest.fn().mockReturnValue("0x1111111111111111111111111111111111111111"),
    getNetwork: jest.fn().mockReturnValue({ protocolFamily: "evm", chainId: "999" }),
    getPublicClient: jest.fn().mockReturnValue({ call: callMock }),    // raw eth_call path
    sendTransaction: jest.fn().mockResolvedValue("0xhash"),
    waitForTransactionReceipt: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<EvmWalletProvider>;
});
```
- **Reads:** `callMock.mockResolvedValueOnce({ data: <encoded struct bytes> })` (build the bytes with viem `encodeAbiParameters` from a known struct value); assert decoded fields + px/PnL conversion. Order the `mockResolvedValueOnce` calls to match the action's read order (e.g. `get_positions`: position → markPx → perpAssetInfo).
- **Writes:** assert `sendTransaction` called with **exact CoreWriter calldata** against the §2.7 fixture (version byte, action-ID bytes, `1e8`-scaled words, tif, cloid).
- **Network:** `supportsNetwork` true for `{protocolFamily:"evm",chainId:"999"}` and `"998"`, false for Base (`"8453"`)/Polygon (`"137"`)/non-evm.
- **Async contract:** assert every write action's return string contains `status:"submitted"` and the async note and **never** contains "filled"/"executed"/"confirmed".
- **Validation:** invalid index / negative size / zero-position-close return `{success:false,error}` WITHOUT calling `.call`/`sendTransaction`.

---

## 8. Security Considerations
- **Async/settlement risk is the #1 issue:** never imply a fill; return pending + poll guidance. Treat every CoreWriter action as eventually-consistent and possibly-failing; recommend a two-phase verify (read the precompile after settlement).
- **Scaling errors (#1 catastrophic surface):** `1e8` price/size mis-scaling can cause mis-sized orders — the §2.7 calldata fixture test is mandatory; validate and clamp inputs; verify the rounding rule (§A.4) before ship.
- **Oracle/precompile manipulation:** precompile prices are validator-set-derived. The **JELLY incident (March 2025)** showed the risk — an attacker manipulated the JELLYJELLY memecoin; Hyperliquid's HLP vault was down ~$13.5M before the exchange forcibly closed positions and validators delisted/settled. Use `limitPx` protection and a conservative slippage bound in `close_position`.
- **Stale-read hazard:** precompile snapshots are start-of-block; CoreWriter writes are not reflected in same-block reads.
- **Invalid precompile inputs consume all gas** — validate indices BEFORE calling.
- **Network mismatch** guarded via `supportsNetwork` (999/998 only).
- **Funds-location precondition:** perp actions require collateral on the perp side; document the USD-class-transfer (ID 7) / bridging prerequisites (out of scope for v1).

---

## 9. Open Questions / Gaps (evidence-graded — status this revision)
- **`set_leverage` via CoreWriter — RESOLVED, `CONFIRMED-absent`.** No leverage action in the CoreWriter table; it is an L1-native operation. Ship 4 actions; document. **No longer blocking.**
- Precompile addresses `0x0800`–`0x080C`, structs, input/return types — **`CONFIRMED`** (canonical `L1Read.sol` verbatim, 2026-06-11; current 5-field `Position`, `uint32` price indices).
- CoreWriter address + encoding + action IDs 1–13/15 — **`CONFIRMED`** (deployed source + `hyper-evm-lib`). Action **ID 14 — `UNVERIFIED`** (reserved/skipped by the encoder lib; not used, not leverage).
- CoreWriter live on mainnet — **`CONFIRMED-approx`** (~July 7, 2025).
- **`sz`/`limitPx` × 1e8 scaling — rule `CONFIRMED`, rounding/`szDecimals` interaction `VERIFY-BEFORE-SHIP`** against `hyper-evm-lib/CoreWriterLib` (§A.4). This is the only residual implementation-blocking verification.
- **`szi`/`entryNtl` decimal bases (size ÷ `10^szDecimals`, notional ÷ `1e6`) — `DERIVED`** (consistent with HyperCore conventions; not a verbatim docs formula). Cover with a hand-checked PnL test; if a primary source contradicts, fix the formula.
- Reading "all markets" from precompiles — **RESOLVED by design:** require explicit `indices` (no canonical enumeration precompile). Documented in README.
- `coreUserExists` / `accountMarginSummary` / `bbo` / `tokenSupply` / `position2` precompiles — **`UNVERIFIED`** (community-lib only). Not used.
- Gas figure ~47k for a basic CoreWriter call — **`VERIFY`** (GitBook-snippet-sourced; informational only, not load-bearing).
- Maintainer preference for the native-API approach over HyperEVM — **`WEAK SIGNAL`**; confirm via the tracking issue first (§0.5).

---

## Appendix A — Exact viem ABI tuples, scaling, and helpers

### A.1 Decode tuples (for `decodeAbiParameters`, viem)
> **ABI-decode subtlety (`CONFIRMED`):** a precompile returns `abi.encode(structInstance)`. Decode each as a **single `tuple` component**, NOT as flattened params. For structs containing a dynamic field (`PerpAssetInfo.coin` is a `string`) the top-level encoding is an offset+tuple, so flattened decoding is WRONG. Using the tuple form below is correct for both static and dynamic structs.

```typescript
// position(address,uint16) → Position
export const POSITION_RETURN = [{ type: "tuple", components: [
  { name: "szi", type: "int64" }, { name: "entryNtl", type: "uint64" },
  { name: "isolatedRawUsd", type: "int64" }, { name: "leverage", type: "uint32" },
  { name: "isIsolated", type: "bool" },
]}] as const;
export const POSITION_ARGS = [{ type: "address" }, { type: "uint16" }] as const;

// perpAssetInfo(uint32) → PerpAssetInfo   (NOTE: dynamic — string coin)
export const PERP_ASSET_INFO_RETURN = [{ type: "tuple", components: [
  { name: "coin", type: "string" }, { name: "marginTableId", type: "uint32" },
  { name: "szDecimals", type: "uint8" }, { name: "maxLeverage", type: "uint8" },
  { name: "onlyIsolated", type: "bool" },
]}] as const;
export const UINT32_ARG = [{ type: "uint32" }] as const;     // markPx/oraclePx/perpAssetInfo arg
export const UINT64_RETURN = [{ type: "uint64" }] as const;  // markPx/oraclePx/spotPx return
```
(Only `position`, `perpAssetInfo`, `markPx`, `oraclePx` are used. Other structs in §2.3 are documented for completeness, not implemented.)

### A.2 Price conversion (`CONFIRMED`)
`humanPx = Number(rawPxU64) / 10^(6 − szDecimals)` for perps (`markPx`/`oraclePx`); `10^(8 − szDecimals)` for spot. `szDecimals` from `perpAssetInfo(perp)` / `tokenInfo(token)`. Carry prices as decimal **strings** in output to avoid float precision loss; do the division with care (e.g. scale via BigInt then format) when `szDecimals` makes the exponent large.

### A.3 Position size / entry / PnL (`DERIVED` — must be test-covered)
Given `Position{szi, entryNtl}`, `markPxU64`, and `szDecimals`:
```
sizeHuman      = Number(szi) / 10^szDecimals            // signed; sign = direction
entryNotional  = Number(entryNtl) / 1e6                 // USD (6-dec convention)  [DERIVED]
markHuman      = Number(markPxU64) / 10^(6 − szDecimals)
avgEntryPx     = szi == 0 ? null : entryNotional / Math.abs(sizeHuman)
unrealizedPnl  = szi == 0 ? 0 : sizeHuman * markHuman − Math.sign(Number(szi)) * entryNotional
isLong         = szi > 0
```
Guard `szi == 0` (no divide-by-zero; null avgEntryPx, 0 PnL). Validate the `1e6` notional base and the `10^szDecimals` size base with a hand-computed fixture test; if `hyper-evm-lib/PrecompileLib` or the docs specify a different base, update these two constants (the only `DERIVED` values).

### A.4 Order scaling (`CONFIRMED` rule / `VERIFY-BEFORE-SHIP` rounding)
Rule (GitBook): send `limitPx` and `sz` as `uint64(round(human × 1e8))`. **Before ship, verify against `hyperliquid-dev/hyper-evm-lib/src/CoreWriterLib.sol`** whether HyperCore additionally enforces `szDecimals`-based rounding (i.e. whether `sz` must be quantized to `szDecimals` significant places and `limitPx` to the asset's tick) before the `×1e8` step. If so, quantize first, then scale. Reject inputs that overflow `uint64` after scaling. Reject non-positive size/price.

### A.5 Helper signatures (`utils.ts`)
```typescript
async function readPrecompile<T>(client: PublicClient, to: Hex, argTypes, args, returnTuple): Promise<T>;
function encodeLimitOrder(asset: number, isBuy: boolean, limitPxU64: bigint, szU64: bigint,
                          reduceOnly: boolean, encodedTif: number, cloidU128: bigint): Hex; // returns full data incl. 0x01000001 header
function convertPx(rawPx: bigint, szDecimals: number): string;
function computePosition(p: { szi: bigint; entryNtl: bigint }, markPx: bigint, szDecimals: number): {
  sizeHuman: string; entryNotional: string; avgEntryPx: string | null; unrealizedPnl: string; isLong: boolean;
};
function toEncodedTif(tif: "Alo" | "Gtc" | "Ioc"): number; // Alo:1, Gtc:2, Ioc:3
function parseCloid(cloid?: string): bigint;               // 0 = none
```
