# PRD — Polymarket ActionProvider for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit), the open-source TypeScript monorepo. **The goal is a PR that Coinbase merges into the official repo.** This document is self-contained: it carries every convention, address, and acceptance criterion you need. You do **not** have access to prior conversations. Where a value is graded below `CONFIRMED`, you MUST re-verify it against the cited primary source before hardcoding it. All source access dates are **2026-06-03**; re-verify recency-sensitive items (Polymarket V2 is a recent cutover).
>
> **One decisive constraint, design around it from line one:** Polymarket migrated to **CTF Exchange V2 + pUSD collateral on April 28, 2026**. V1-signed orders are now rejected. You must target V2 exclusively — V2 EIP-712 domain (`version: "2"`), V2 exchange contracts, pUSD collateral, and the `@polymarket/clob-client-v2` SDK.

---

## 0. The merge target: AgentKit conventions (authoritative, verbatim from the repo)

These are the rules your PR is graded against. Sources: `CONTRIBUTING.md`, `CONTRIBUTING-TYPESCRIPT.md` (raw.githubusercontent.com/coinbase/agentkit/main/, accessed 2026-06-03).

### 0.1 Toolchain
- **Node.js v22.x+**, **pnpm 10.7.x+**, Turborepo. Run all commands from the `typescript/` monorepo root.
- `pnpm install` (from `typescript/`) before anything.
- Tests: `pnpm test` (jest). Lint: `pnpm run lint` / `pnpm run lint:fix`. Format: `pnpm run format` (ESLint + Prettier).
- Changelog: `pnpm run changeset` (interactive). For a new provider, select package `@coinbase/agentkit`, type **patch**, summary in **past tense**, e.g. *"Added a Polymarket action provider for prediction market trading."*
- **All commits MUST be signed** (`git commit -S`). Unsigned commits block merge — this is a hard gate (`cb-heimdall` CI rejects them).
- Scaffolding: a `generate-action-provider` script exists at `typescript/agentkit/scripts/generate-action-provider/` (see its README). Use it to scaffold, or copy the `pyth`/`erc721` provider layout.

### 0.2 Required file layout
A provider lives at `typescript/agentkit/src/action-providers/polymarket/`:
```
polymarket/
├── polymarketActionProvider.ts      # provider class + @CreateAction methods
├── schemas.ts                       # Zod schemas
├── constants.ts                     # addresses, ABIs, API base URLs, EIP-712 domains
├── utils.ts                         # order building, EIP-712/HMAC helpers, signer adapter
├── polymarketActionProvider.test.ts # jest unit tests (REQUIRED)
├── index.ts                         # exports
└── README.md                        # per-provider README (REQUIRED)
```
The provider must be **re-exported from `typescript/agentkit/src/action-providers/index.ts`** so it ships in the package.

### 0.3 The canonical provider pattern (verbatim shape from the ERC-721 example in CONTRIBUTING-TYPESCRIPT.md)
> ⚠️ **Repo dependency baseline (verified against `typescript/agentkit/package.json`, 2026-06-03):** the package ships **`zod@^4.3.6` (Zod v4)**, **`viem@2.47.4`**, **`ethers@^6.13.5` (ethers v6)**. Write against these exact majors. In particular: **do NOT use `.strip()` on schemas** — the current in-repo providers (`erc721/schemas.ts`, `pyth/schemas.ts`) use plain `z.object({...}).describe(...)` with `.describe()` on every field and **no `.strip()`**. The `.strip()` shown in `CONTRIBUTING-TYPESCRIPT.md` is a stale doc snippet; match the live provider style, not the doc.

```typescript
// schemas.ts — match the LIVE house style: every field .describe(); object .describe(); NO .strip()
const MintSchema = z
  .object({
    contractAddress: z.string().describe("The contract address of the NFT to mint"),
    destination: z.string().describe("The destination address that will receive the NFT"),
  })
  .describe("Instructions for minting an NFT");

// erc721ActionProvider.ts
export class Erc721ActionProvider extends ActionProvider {
  constructor() {
    super("erc721", []);          // super(<name string>, [])
  }

  @CreateAction({
    name: "mint",
    description: `
This tool will mint an NFT (ERC-721) ...   // multi-line; describe inputs, outputs, examples, and when to ask the user
`,
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
      return `Successfully minted NFT ${args.contractAddress} to ${args.destination}`;  // include tx hash / useful info
    } catch (error) {
      return `Error minting NFT ...: ${error}`;   // errors are RETURNED as strings, not thrown
    }
  }

  supportsNetwork = (network: Network) => network.protocolFamily === "evm";
}

export const erc721ActionProvider = () => new Erc721ActionProvider();   // factory export
```
**Non-negotiable conventions extracted from the above:**
1. Class `extends ActionProvider` (you MAY use the typed form `ActionProvider<EvmWalletProvider>`; the wallet param is typed `EvmWalletProvider`).
2. Constructor calls `super("polymarket", [])`.
3. Every action is an `async` instance method decorated with `@CreateAction({ name, description, schema })` and returns `Promise<string>`.
   - Schemas: plain `z.object({...}).describe(...)`, `.describe()` on every field, **no `.strip()`** (Zod v4; see the dependency-baseline note above).
4. **Action errors are caught and returned as strings** (`return \`Error ...: ${error}\``) — do not let actions throw.
5. The `description` is an LLM prompt — describe inputs/outputs, give examples, and tell the LLM when to ask the user or call another action first (e.g. "if no tokenId is provided, call get_markets first").
6. `supportsNetwork` is an arrow-function property.
7. Factory export `export const polymarketActionProvider = () => new PolymarketActionProvider();`.
8. TS config: decorators require `experimentalDecorators` + `emitDecoratorMetadata` (already set in the monorepo).

### 0.4 Acceptance criteria checklist (the PR rubric)
- [ ] All actions return `Promise<string>`; errors returned (not thrown).
- [ ] Zod schemas: plain `z.object({...}).describe(...)`, every field `.describe()`, **no `.strip()`** (matches live `erc721`/`pyth` schemas; Zod v4).
- [ ] `supportsNetwork` correctly scoped (Polygon mainnet only — see §3).
- [ ] Unit tests in `polymarketActionProvider.test.ts` pass via `pnpm test`; mirror `pythActionProvider.test.ts`.
- [ ] `pnpm run lint` and `pnpm run format` clean.
- [ ] Per-provider `README.md` present (use the ERC-20 provider README as the reference format).
- [ ] Changeset added (patch, past tense).
- [ ] Signed commits; PR template filled; tracking issue linked.
- [ ] Naming exact: directory `polymarket`, class `PolymarketActionProvider`, factory `polymarketActionProvider`, action-provider name string `"polymarket"`.
- [ ] Re-exported from `src/action-providers/index.ts`.

### 0.5 Merge-likelihood note (do this BEFORE writing code)
AgentKit is **Base-first**; Polymarket is **Polygon-only**. That is the single biggest non-technical risk to acceptance. **Open a GitHub issue on `coinbase/agentkit` first**, describing the provider, the off-Base network, and the broadly-useful justification (prediction markets are a major DeFi vertical: on-chain prediction-market monthly volume scaled from ~$1.2B in early 2025 to >$20B by Jan 2026, with a $425M Polymarket single-day record on 2026-02-28 — TRM Labs, pub. 2026-03-27). Ask maintainers to confirm they'll accept an off-Base provider. Proceed to build once a maintainer signals interest. As of 2026-06-03 there is **no in-flight Polymarket PR** (collision-checked) — but re-check `github.com/coinbase/agentkit/pulls` before starting.

---

## 1. Executive Summary

The Polymarket ActionProvider gives an AgentKit agent the full prediction-market order lifecycle on Polymarket's hybrid-decentralized CLOB on Polygon: discover markets (`get_markets`), read odds/liquidity (`get_market`), sign and place buy/sell orders (`place_order`), read positions (`get_positions`), and redeem winnings on-chain after resolution (`redeem_winnings`). The integration surface is two-fold: **REST** calls to Polymarket's Gamma/CLOB/Data APIs (off-chain order matching) plus **on-chain Polygon** contract calls (Conditional Tokens `redeemPositions`, ERC-20/ERC-1155 approvals, pUSD wrapping). The key technical risk is the **V2 + pUSD migration (April 28, 2026)**: V1-signed orders are rejected, the EIP-712 order struct changed, and collateral is now pUSD (not USDC.e), so the provider targets V2 exclusively.

**5 actions:** `get_markets`, `get_market`, `place_order`, `get_positions`, `redeem_winnings`.

---

## 2. Protocol Background (primary-source grounded)

### 2.1 APIs (base URLs — `docs.polymarket.com/quickstart/reference/endpoints`)
- **Gamma API:** `https://gamma-api.polymarket.com` — public, no auth. Discovery: `GET /markets`, `GET /events`, `GET /markets/{id}`. Returns `question, conditionId, clobTokenIds, outcomes, outcomePrices, bestBid, bestAsk, liquidityNum, volumeNum, spread, orderMinSize, orderPriceMinTickSize, negRisk`.
- **CLOB API:** `https://clob.polymarket.com`. Post-cutover, V2 took over this main URL (the staging URL was `clob-v2.polymarket.com`; no base-URL change needed now — **verify this is still true at implementation time**). Public: `GET /book`, `GET /price`, `GET /midpoint`, tick size. Authenticated (L2 HMAC headers): order management.
- **Data API:** `https://data-api.polymarket.com` — public. `GET /positions?user=<wallet>&sizeThreshold=1`, `GET /trades?user=<wallet>&limit=50`, `GET /activity`.
- **WebSocket:** `wss://ws-subscriptions-clob.polymarket.com/ws/` — OPTIONAL, out of scope for v1 of this AP.

### 2.2 Authentication (`docs.polymarket.com/developers/CLOB/authentication`)
- **L1 (private-key):** EIP-712 signature over a `ClobAuth` struct, domain `{ name: "ClobAuthDomain", version: "1", chainId: 137 }`. Used to create/derive API credentials. **Note the version is `"1"` here — distinct from the order domain.**
- **L2 (HMAC):** per-request headers `POLY_ADDRESS`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`, `POLY_SIGNATURE` where `POLY_SIGNATURE = HMAC-SHA256(secret, timestamp + method + path + body)`. Used for all order operations.
- Even with L2 credentials, the **order payload itself must be EIP-712 signed by the private key**.

### 2.3 EIP-712 Order struct (V2 — `Polymarket/ctf-exchange-v2` + `docs.polymarket.com/v2-migration`)
- **V2 fields:** `salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder`.
  (V1 had `salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, feeRateBps, side, signatureType` — **rejected post-cutover**.)
- `signatureType`: `0` = EOA, `1` = POLY_PROXY, `2` = POLY_GNOSIS_SAFE (SDK also references `3` = POLY_1271). **For an AgentKit EOA wallet, use `0`.**
- `makerAmount`/`takerAmount` are **6-decimal** (pUSD has 6 decimals; $100 = `100_000_000`). For BUY: `makerAmount` = pUSD spent, `takerAmount` = shares = `makerAmount / price`.
- **EIP-712 domain (standard):** `{ name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B" }`.
- **EIP-712 domain (neg-risk):** `{ name: "Polymarket Neg Risk CTF Exchange", version: "2", chainId: 137, verifyingContract: "0xe2222d279d744050d28e00520010520000310F59" }`.
- ⚠️ **The single biggest migration pitfall: mixing up the two `version` fields.** Exchange order-domain version is `"2"`. ClobAuth domain version is `"1"`.

### 2.4 Contract addresses (Polygon, chainId 137)
| Contract | Address | Grade |
|---|---|---|
| CTF Exchange **V2** (standard) | `0xE111180000d2663C0091e4f400237545B87B996B` | **CONFIRMED** (`docs.polymarket.com/v2-migration`, used as EIP-712 verifyingContract) |
| Neg Risk CTF Exchange **V2** | `0xe2222d279d744050d28e00520010520000310F59` | **CONFIRMED** (v2-migration) |
| Conditional Tokens (Gnosis CTF, ERC-1155) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | **CONFIRMED** (PolygonScan) |
| pUSD (V2 collateral, ERC-20, **6 decimals**) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | **CONFIRMED** (`/concepts/pusd`) |
| CollateralOnramp `wrap(address _asset, address _to, uint256 _amount)` | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | **CONFIRMED** (`/concepts/pusd`) |
| USDC.e (legacy collateral / wrap source) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | **CONFIRMED** |
| UMA CTF Adapter v3.0 (resolution oracle) | `0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49` | **CONFIRMED** (PolygonScan) |
| CTF Exchange V1 (DEPRECATED — do NOT use) | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | reference only |
| Neg Risk V1 (DEPRECATED) | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | reference only |
| NegRiskAdapter V2 + V2 collateral adapters (`CtfCollateralAdapter`, `NegRiskCtfCollateralAdapter`) | **PULL FROM `docs.polymarket.com/resources/contracts` AT IMPLEMENTATION** | **GAP — must verify before merge** |

### 2.5 CTF token model (`docs.polymarket.com/developers/CTF/overview`)
Outcomes are ERC-1155 tokens.
- `positionId = getPositionId(collateralToken, getCollectionId(bytes32(0), conditionId, indexSet))`
- `conditionId = getConditionId(oracle = UMA adapter, questionId, outcomeSlotCount = 2)`
- Binary `indexSet`: `1` (0b01) = first outcome, `2` (0b10) = second.
- **Token IDs are returned directly in the Gamma `tokens`/`clobTokenIds` arrays**, so manual computation is only needed for direct contract integration — prefer the API-provided IDs.

### 2.6 Redeem (`redeemPositions`)
- Standard CTF: `redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)`. `parentCollectionId = bytes32(0)`; binary markets `indexSets = [1, 2]`.
- Neg-risk markets: use the **NegRiskAdapter's 2-arg** `redeemPositions(conditionId, uint256[] amounts)`.
- V2 collateral adapters can redeem directly into pUSD.

### 2.7 Allowances / prerequisites
The EOA must, before trading/redeeming:
1. `approve` pUSD (ERC-20) for the CTF Exchange V2 (and the neg-risk exchange when used).
2. `setApprovalForAll` on the CTF ERC-1155 (`0x4D97…6045`) for the exchange/adapter operators.
3. To fund pUSD: `approve` the CollateralOnramp to spend USDC.e, then call `wrap(usdce, to, amount)`.
Reference impls (NautilusTrader, rs-clob-client) use `MAX_UINT256` approvals for UX — see §9 for the security tradeoff.

### 2.8 Signing & client library — READ CAREFULLY (this is the #1 technical risk)

⚠️ **Do NOT introduce ethers v5.** AgentKit already depends on **ethers v6** (`^6.13.5`) and **viem `2.47.4`**. Adding ethers v5 creates a conflicting duplicate dependency a reviewer will reject. The original research note that `@polymarket/clob-client-v2` "requires an ethers v5 signer" is a trap — design around it.

**Signing options, in order of preference:**
1. **Sign EIP-712 directly via the wallet provider.** `EvmWalletProvider` exposes `signTypedData(typedData)` (verified in `wallet-providers/evmWalletProvider.ts`). Build the V2 Order typed-data object yourself (domain + types + message from §2.3) and sign with `walletProvider.signTypedData(...)`. This is the cleanest path and needs no external signer dependency. Submit the signed order to the CLOB via plain `fetch`/HTTP with the L2 HMAC headers.
2. **Follow the `across` provider precedent for a raw key.** The canonical pattern in the repo for providers that need a raw signer is `acrossActionProvider.ts`: it accepts a **`privateKey` in its constructor config** and builds a **viem account** via `privateKeyToAccount(privateKey)` — it does NOT adapt `EvmWalletProvider`. If you need a standalone signer (e.g. for L1 credential derivation), mirror this: take `privateKey` via constructor config and use a viem account.
3. **Only if `@polymarket/clob-client-v2` is genuinely required** for order serialization, wrap a **viem account / ethers v6 signer** to satisfy its signer interface — never ethers v5. Pin the exact SDK version and verify its peer-dependency on ethers at install time; if it hard-requires ethers v5, prefer option 1 (hand-roll the EIP-712 signing) instead of pulling in a conflicting major.

The V1 `@polymarket/clob-client` stops working post-cutover — do not use it.

**Recommendation:** start with option 1 (`walletProvider.signTypedData` + `fetch`). Treat the SDK as optional convenience, not a hard dependency.

---

## 3. Architecture & Integration Boundary
- **Off-chain (REST, no signing):** `get_markets`, `get_market`, `get_positions` are pure REST reads (Gamma + CLOB + Data).
- **Off-chain (REST, signed):** `place_order` requires L1 (create/derive API creds) + L2 HMAC headers + EIP-712 order signing, then POST to the CLOB operator.
- **On-chain (Polygon):** `redeem_winnings` calls CTF `redeemPositions` (or NegRiskAdapter). Allowance setup + pUSD wrapping are on-chain.
- **Matching/settlement boundary:** orders are matched off-chain by Polymarket's operator and settled on-chain by the CTF Exchange. The provider **never matches** — it signs and submits. Redemption is fully on-chain.
- **Network:** Polygon-only (chainId 137). **`supportsNetwork` must return true ONLY for EVM + Polygon mainnet (chainId 137), false for Base/everything else.** Example:
  ```typescript
  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.chainId === "137";
  ```

---

## 4. Action-by-Action Spec

### `get_markets`
- **Schema:** `{ limit?: number (default 20), active?: boolean, order?: string (e.g. "volume24hr"), ascending?: boolean, tagSlug?: string }`.
- **Behavior:** Gamma `GET /markets` with query params. Returns a JSON string of markets (`question, conditionId, clobTokenIds, outcomePrices, liquidityNum, volumeNum, negRisk`). No wallet, no signing.
- **Edge cases:** pagination, empty results (return a clear "no markets found" string).

### `get_market`
- **Schema:** `{ conditionId?: string, tokenId?: string, slug?: string }` — at least one required (enforce in Zod with a refinement).
- **Behavior:** Gamma `GET /markets/{id}` for metadata, merged with CLOB `GET /book` / `GET /midpoint` / `GET /price` for live odds/liquidity. Returns merged JSON (`bestBid, bestAsk, spread, midpoint, orderbook depth, tick size`).
- **Edge cases:** closed/resolved markets; 50/50 markets; **taker-delay markets** (a 250 ms hold applies to marketable orders on selected crypto/finance up-down markets; orders cannot be cancelled during the hold — surface this in the returned data).

### `place_order`
- **Schema:** `{ tokenId: string, side: "BUY"|"SELL", price: number (0–1), size: number, orderType?: "GTC"|"GTD"|"FOK"|"FAK" (default "GTC"), negRisk?: boolean }`.
- **Steps:** (1) ensure API creds (L1 create/derive); (2) build the V2 Order with the correct domain (standard vs neg-risk per `negRisk`); (3) EIP-712 sign via `walletProvider.signTypedData(...)` (signatureType `0` for EOA — see §2.8; do NOT add ethers v5); (4) POST to the CLOB with L2 HMAC headers; (5) return order id + status.
- **Returns:** order id and status (matched / live / unmatched).
- **Risks/edge cases:** wrong EIP-712 domain version (must be `"2"`); wrong collateral (must hold **pUSD**, not USDC.e); 6-decimal scaling; insufficient allowance ("not enough balance or allowance" — trigger the allowance preflight); partial fills (FAK); tick-size rejection; taker-delay window; heartbeat requirement (open orders cancelled if no valid heartbeat within ~10 s). Slippage/MEV: GTC/GTD rest at price; FOK/FAK execute against resting liquidity with slippage bounded by `price`.

### `get_positions`
- **Schema:** `{ user?: string (default = wallet address), sizeThreshold?: number (default 1) }`.
- **Behavior:** Data API `GET /positions?user=...`. Returns positions (`asset/tokenId, conditionId, size, avgPrice, curPrice, title, outcome, redeemable`). No signing.
- **Trustless alternative:** on-chain ERC-1155 `balanceOf(user, positionId)` — document as a fallback.
- **Edge case:** resolved-but-unredeemed positions flagged `redeemable`.

### `redeem_winnings`
- **Schema:** `{ conditionId: string, negRisk?: boolean, indexSets?: number[] (default [1, 2]) }`.
- **Steps:** (1) verify market resolved (payoutNumerators set / UMA resolved); (2) standard → CTF `redeemPositions(pUSD, bytes32(0), conditionId, [1,2])`; (3) neg-risk → NegRiskAdapter 2-arg variant; (4) `waitForTransactionReceipt`; (5) return tx hash + redeemed amount. Use `walletProvider.sendTransaction` + `walletProvider.waitForTransactionReceipt`.
- **Edge cases:** unresolved market (revert — guard before sending); zero balance; neg-risk amounts-array shape; adapter approval needed; redemption-to-pUSD vs USDC.e path.

---

## 5. File Structure
(See §0.2 — `polymarket/` with `polymarketActionProvider.ts`, `schemas.ts`, `constants.ts`, `utils.ts`, `polymarketActionProvider.test.ts`, `index.ts`, `README.md`.)

---

## 6. Ordered Implementation Steps
1. From `typescript/`, run `pnpm install`; confirm Node 22 / pnpm 10.7.
2. **Open the tracking issue first** (§0.5) and re-check for collision PRs.
3. Scaffold `polymarket/` via the `generate-action-provider` script (or copy the `pyth`/`erc721` skeleton).
4. `constants.ts`: API base URLs; Polygon chainId 137; V2 addresses (`0xE111…996B`, `0xe222…0F59`); pUSD / USDC.e / CTF / Onramp / UMA addresses; EIP-712 domains (standard + neg-risk); minimal ABIs (CTF `redeemPositions`, ERC-20 `approve`/`allowance`, ERC-1155 `setApprovalForAll`/`isApprovedForAll`/`balanceOf`, CollateralOnramp `wrap`).
5. `schemas.ts`: `GetMarketsSchema`, `GetMarketSchema`, `PlaceOrderSchema`, `GetPositionsSchema`, `RedeemWinningsSchema`, each `z.object({...}).describe(...)` with `.describe()` on every field — **no `.strip()`** (Zod v4 house style).
6. Set up signing per §2.8 — **preferred: hand-roll the V2 Order EIP-712 typed-data and sign via `walletProvider.signTypedData(...)`; submit via `fetch` + L2 HMAC headers. Do NOT add ethers v5.** If a standalone signer is needed for L1 cred derivation, follow the `across` provider's `privateKey`-in-config + viem `privateKeyToAccount` pattern. Only pull in `@polymarket/clob-client-v2` if necessary, wrapping a viem/ethers-v6 signer.
7. Implement `get_markets` (Gamma REST).
8. Implement `get_market` (Gamma + CLOB REST merge).
9. Implement the credential-bootstrap helper (L1 create/derive API creds via the signer).
10. Implement `place_order` (build → sign → post; standard vs neg-risk domain selection).
11. Implement `get_positions` (Data API; optional on-chain fallback).
12. Implement `redeem_winnings` (CTF / NegRiskAdapter call + receipt).
13. Implement the allowance-preflight helper (approve pUSD + `setApprovalForAll`), invoked inside `place_order`/`redeem_winnings` when missing.
14. Implement `supportsNetwork` restricting to Polygon mainnet (chainId 137).
15. Add the factory export and re-export from `src/action-providers/index.ts`.
16. Write `polymarketActionProvider.test.ts` (mock HTTP client + wallet provider).
17. Write `README.md`.
18. Run `pnpm test`, `pnpm run lint`, `pnpm run format` — all green.
19. `pnpm run changeset` → patch: "Added a Polymarket action provider for prediction market trading."
20. Sign commits; open the PR with the template filled; link the tracking issue.

---

## 7. Testing Plan
- Mock REST (Gamma/CLOB/Data) via jest mocks of the HTTP client; assert URL/params and response parsing.
- Mock `EvmWalletProvider.signTypedData` to assert the order typed-data passed to it: order struct fields, **domain selection (standard vs neg-risk)**, signatureType `0`, and 6-decimal scaling. (If you used `@polymarket/clob-client-v2`, mock it instead and assert the same.)
- Mock `EvmWalletProvider` (`sendTransaction`, `waitForTransactionReceipt`, `readContract`, `getAddress`, `signTypedData`) for order/redeem/allowance tests.
- Assert `supportsNetwork` returns true ONLY for Polygon mainnet (chainId 137), false for Base.
- Error paths: unresolved-market redeem, insufficient allowance, wrong network. Mirror `pythActionProvider.test.ts` structure.

---

## 8. Security Considerations
- Private key never logged; EIP-712 signing only via the wallet provider.
- **Allowance scoping:** prefer exact-amount approvals over `MAX_UINT256` where feasible; document the UX tradeoff (most reference impls use `MAX_UINT256`).
- **Domain/version correctness:** hardcode V2 domain version `"2"` and the V2 verifyingContracts to prevent rejection/replay confusion.
- **Slippage:** enforce price bounds (0–1) in schema; document FOK/FAK semantics for market orders.
- **Settlement/oracle risk:** redemption depends on UMA resolution (~2-hour liveness, dispute path); guard against redeeming unresolved markets.
- **Network mismatch** guarded via `supportsNetwork`.
- **ToS / geo (legal acceptance risk):** Polymarket's ToS prohibits U.S. persons and certain jurisdictions — **including agents developed by persons in restricted jurisdictions**. This is a real merge/legal risk for a Coinbase-owned repo. The README MUST warn that operators are responsible for compliance, and the PR description must surface it explicitly. Do not assume maintainers will merge a trading provider without this addressed.

---

## 9. Open Questions / Gaps (evidence-graded — resolve before merge)
- CTF Exchange V2 + Neg Risk V2 (`0xE111…996B`, `0xe222…0F59`): **CONFIRMED**.
- pUSD / CollateralOnramp / USDC.e / CTF / UMA adapter: **CONFIRMED**.
- **NegRiskAdapter V2 + V2 collateral-adapter mainnet addresses: GAP** — documented in `ctf-exchange-v2` but pull exact addresses from `docs.polymarket.com/resources/contracts` before merge. **Blocking for neg-risk markets.**
- **Canonical V2 Order EIP-712 type hash / field ordering: STRONG SIGNAL** — field list confirmed (§2.3). Since the recommended path hand-rolls signing via `walletProvider.signTypedData` (§2.8), **lift the exact type hash / field ordering from `ctf-exchange-v2/Structs.sol` and verify it** before relying on it. This is now load-bearing (no SDK abstracting it).
- **CLOB base URL post-cutover (whether `clob.polymarket.com` is the V2 endpoint): verify at implementation** — the staging URL was `clob-v2.polymarket.com`.
- **Maintainer acceptance of a Polygon-only provider: WEAK SIGNAL** — open the issue first (§0.5).
- **Recency:** the V2 cutover (April 28, 2026) is recent and the SDK/address ecosystem is still settling — re-verify addresses and the SDK version immediately before implementation.
