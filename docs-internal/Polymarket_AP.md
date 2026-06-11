# PRD — Polymarket ActionProvider for Coinbase AgentKit (TypeScript)

> **Read this first — context for the implementing agent.**
> You are building a **new ActionProvider** for [`coinbase/agentkit`](https://github.com/coinbase/agentkit), the open-source TypeScript monorepo. **The goal is a PR that Coinbase merges into the official repo.** This document is self-contained: it carries every convention, address, signing detail, and acceptance criterion you need. You do **not** have access to prior conversations.
>
> **One decisive constraint, design around it from line one:** Polymarket migrated to **CTF Exchange V2 + pUSD collateral on April 28, 2026**. V1-signed orders are now rejected. Target V2 exclusively — V2 EIP-712 order domain (`version: "2"`), V2 exchange contracts, pUSD collateral.
>
> **Verification status of this PRD.** Items graded **CONFIRMED** were re-verified against primary sources on **2026-06-11** (PolygonScan, Polymarket docs, and Polymarket's official `clob-client` source). Items graded **STRONG SIGNAL** are corroborated by official client code but should be sanity-checked against a live response at implementation time. Items graded **GAP / VERIFY** are recency-sensitive (post-cutover ecosystem still settling) — resolve them before opening the PR. Source-access date for all web items: **2026-06-11**.

---

## 0.5 LOCKED DECISIONS (read before anything — these resolve every prior ambiguity)

These are settled. Do **not** re-open them; build to them.

1. **Signing path = hand-rolled EIP-712 via the wallet provider.** Use `walletProvider.signTypedData(...)` for both the V2 order and the L1 ClobAuth struct. **Do NOT add `@polymarket/clob-client-v2`, `@polymarket/clob-client`, or ethers v5.** AgentKit already ships `viem@2.47.4` and `ethers@^6.13.5`; adding ethers v5 creates a duplicate-major conflict a reviewer will reject. See **Appendix A** for the exact typed-data objects and **Appendix B** for the HMAC.

2. **API credentials are derived on the fly — no secrets in the constructor.** `place_order` derives L2 API credentials at call time: try `GET /auth/derive-api-key` (deterministic from the signing key); if that 404s/401s, fall back to `POST /auth/api-key` to create them. Both calls use **L1 headers** (an EIP-712 ClobAuth signature — Appendix A.2). Cache the derived `{apiKey, secret, passphrase}` on the provider instance for the process lifetime. **The constructor takes no `privateKey`, no `apiKey`, no secrets** (CLAUDE.md hard rule #5). This keeps the whole provider mock-testable.
   - *Consequence:* the wallet provider MUST be able to sign EIP-712 (`signTypedData`) for `place_order` to work. Read-only actions need no creds.

3. **Neg-risk markets ARE supported in v1, using verified addresses.** The standard vs neg-risk exchange split is handled by selecting the EIP-712 domain (Appendix A.1) and the redeem contract (§4.5) on the `negRisk` flag. The exchange addresses are CONFIRMED; the neg-risk **redeem** adapter is the one item still graded VERIFY (§2.4) — handle it but flag it on the pre-PR checklist.

4. **HMAC encoding is url-safe base64, NOT hex.** This is a known foot-gun: at least one popular third-party cheatsheet documents hex — it is wrong. The authoritative algorithm (Polymarket `clob-client/src/signing/hmac.ts`) is in **Appendix B**. Getting this wrong returns `401`/`invalid signature` on every L2 call.

5. **HMAC uses Node's built-in `crypto`** (`crypto.createHmac("sha256", key)`). No new dependency.

---

## 0. The merge target: AgentKit conventions (authoritative, verbatim from the repo)

These are the rules your PR is graded against. Sources: `CONTRIBUTING.md`, `CONTRIBUTING-TYPESCRIPT.md` (coinbase/agentkit), and the live in-repo providers (`pyth`, `erc721`, `across`).

### 0.1 Toolchain
- **Node.js v22.x+**, **pnpm 10.7.x+**, Turborepo. Run all commands from the `typescript/` monorepo root.
- `pnpm install` (from `typescript/`) before anything.
- Tests: `pnpm test` (jest). Lint: `pnpm run lint` / `pnpm run lint:fix`. Format: `pnpm run format` (ESLint + Prettier).
- Changelog: `pnpm run changeset` (interactive). Package `@coinbase/agentkit`, type **patch**, summary in **past tense**: *"Added a Polymarket action provider for prediction market trading."*
- **All commits MUST be signed** (`git commit -S`). Unsigned commits block merge (`cb-heimdall` CI). *(Human-only step at PR time — not Claude's job on the branch.)*
- Scaffolding: `typescript/agentkit/scripts/generate-action-provider/` exists, or copy the `pyth`/`erc721` layout.

### 0.2 Required file layout
Provider at `typescript/agentkit/src/action-providers/polymarket/`:
```
polymarket/
├── polymarketActionProvider.ts      # provider class + @CreateAction methods
├── schemas.ts                       # Zod v4 schemas
├── constants.ts                     # addresses, ABIs, API base URLs, EIP-712 domains + types
├── utils.ts                         # HTTP client, EIP-712 builders, HMAC/L1/L2 header helpers, scaling, creds cache
├── polymarketActionProvider.test.ts # jest unit tests (REQUIRED)
├── index.ts                         # exports
└── README.md                        # per-provider README (REQUIRED)
```
Re-export from `typescript/agentkit/src/action-providers/index.ts` (flat `export * from "./polymarket";`).

### 0.3 The canonical provider pattern (verified against live `erc721`/`pyth`)
> ⚠️ **Dependency baseline (verified in `typescript/agentkit/package.json`, 2026-06-11):** `zod@^4.3.6` (v4), `viem@2.47.4`, `ethers@^6.13.5` (v6). Write against these majors. **Do NOT use `.strip()`** — live `erc721`/`pyth` schemas use plain `z.object({...}).describe(...)` with `.describe()` on every field. The `.strip()` in `CONTRIBUTING-TYPESCRIPT.md` is stale.

**Non-negotiable conventions:**
1. Class `export class PolymarketActionProvider extends ActionProvider<EvmWalletProvider>`.
2. Constructor calls `super("polymarket", [])`.
3. Every action is an `async` instance method decorated with `@CreateAction({ name, description, schema })` returning **`Promise<string>`**.
4. **Action errors are caught and RETURNED as strings**, never thrown. (House convention: return a JSON string `{"success":false,"error":"..."}` — matches `pyth`. Use this shape consistently; see §4.)
5. The `description` is an LLM prompt — describe inputs/outputs, give examples, and say when to call another action first (e.g. "if you only have a market slug, call `get_market` first to obtain the `tokenId`").
6. `supportsNetwork` is an **arrow-function property**. `Network.chainId` is a **string**.
7. Factory export `export const polymarketActionProvider = () => new PolymarketActionProvider();`.
8. Wallet I/O goes through the provider: `signTypedData`, `sendTransaction`, `waitForTransactionReceipt`, `readContract`, `getAddress`, `getNetwork`. (All verified present on `EvmWalletProvider`.) On-chain calldata via viem `encodeFunctionData`. There is **no `staticcall`** method — reads use `readContract`.

### 0.4 Acceptance criteria checklist (the PR rubric)
- [ ] All 5 actions return `Promise<string>`; errors returned (not thrown).
- [ ] Zod schemas: plain `z.object({...}).describe(...)`, every field `.describe()`, **no `.strip()`**.
- [ ] `supportsNetwork` returns true **only** for `protocolFamily === "evm" && chainId === "137"`.
- [ ] Unit tests pass via `pnpm test`; mirror `pythActionProvider.test.ts` (mock `global.fetch` + wallet provider).
- [ ] `pnpm build`, `pnpm run lint`, `pnpm run format` clean.
- [ ] Per-provider `README.md` present (ERC-20 README as format reference) **including the ToS/geo compliance warning** (§8).
- [ ] Changeset added (patch, past tense).
- [ ] Naming exact: directory `polymarket`, class `PolymarketActionProvider`, factory `polymarketActionProvider`, name string `"polymarket"`.
- [ ] Re-exported from `src/action-providers/index.ts`.

### 0.5b Merge-likelihood note (do this BEFORE writing code)
AgentKit is **Base-first**; Polymarket is **Polygon-only**. This is the biggest non-technical risk. **Open a GitHub issue on `coinbase/agentkit` first**, describing the provider, the off-Base network, and the justification (prediction markets are a major DeFi vertical). Ask maintainers to confirm they'll accept an off-Base provider; proceed once a maintainer signals interest. Re-check `github.com/coinbase/agentkit/pulls` for a collision PR before starting. *(Issue/PR creation is human-only per CLAUDE.md.)*

---

## 1. Executive Summary

The Polymarket ActionProvider gives an AgentKit agent the full prediction-market lifecycle on Polymarket's hybrid-decentralized CLOB on Polygon: discover markets (`get_markets`), read odds/liquidity (`get_market`), sign and place buy/sell orders (`place_order`), read positions (`get_positions`), and redeem winnings on-chain after resolution (`redeem_winnings`). The surface is two-fold: **REST** to Polymarket's Gamma/CLOB/Data APIs (off-chain order matching) plus **on-chain Polygon** contract calls (Conditional Tokens `redeemPositions`, ERC-20/ERC-1155 approvals). The key technical risk is the **V2 + pUSD migration (April 28, 2026)**: V1-signed orders are rejected, the EIP-712 order struct changed, collateral is now pUSD (6 decimals). Target V2 exclusively.

**5 actions:** `get_markets`, `get_market`, `place_order`, `get_positions`, `redeem_winnings`.

---

## 2. Protocol Background (primary-source grounded)

### 2.1 APIs (base URLs)
- **Gamma API:** `https://gamma-api.polymarket.com` — public, no auth. Discovery: `GET /markets`, `GET /events`, `GET /markets/{id}`. Returns `question, conditionId, clobTokenIds, outcomes, outcomePrices, bestBid, bestAsk, liquidityNum, volumeNum, spread, orderMinSize, orderPriceMinTickSize, negRisk, closed, active`. **CONFIRMED.**
- **CLOB API:** `https://clob.polymarket.com` — **CONFIRMED** this is the V2 production host post-cutover (the staging `clob-v2.polymarket.com` is deprecated; no base-URL switch needed). Public reads: `GET /book?token_id=`, `GET /price?token_id=&side=BUY|SELL`, `GET /midpoint?token_id=`, `GET /tick-size?token_id=` *(tick-size path: STRONG SIGNAL — confirm against a live call)*. Authenticated: `POST /order` (L2), `POST /auth/api-key` + `GET /auth/derive-api-key` (L1).
- **Data API:** `https://data-api.polymarket.com` — public. `GET /positions?user=<wallet>&sizeThreshold=1`, `GET /trades?user=<wallet>&limit=50`, `GET /activity`. **CONFIRMED.**
- **WebSocket** `wss://ws-subscriptions-clob.polymarket.com/ws/` — OUT OF SCOPE for v1.

### 2.2 Authentication model (two levels) — see Appendices A.2 and B for exact code
- **L1 (private-key / EIP-712):** an EIP-712 signature over a `ClobAuth` struct. Domain `{ name: "ClobAuthDomain", version: "1", chainId: 137 }`. **Used only to create/derive API credentials.** Headers it produces: `POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE`. **CONFIRMED** (`clob-client/src/signing/eip712.ts`, `headers/index.ts`).
- **L2 (HMAC):** per-request headers `POLY_ADDRESS, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE, POLY_SIGNATURE`, where `POLY_SIGNATURE = urlSafeBase64( HMAC-SHA256(base64UrlDecode(secret), timestamp + method + requestPath + body) )`. **Used for all order operations.** **CONFIRMED** (`clob-client/src/signing/hmac.ts`).
- ⚠️ **Two distinct `version` fields — do not mix them up.** ClobAuth domain version is `"1"`. The order domain version is `"2"`.

### 2.3 EIP-712 Order struct (V2) — **CONFIRMED** (`Polymarket/ctf-exchange-v2`, docs `v2-migration`)
Field list & types, **in this exact order** (the type hash depends on ordering):
```
uint256 salt
address maker
address signer
uint256 tokenId
uint256 makerAmount
uint256 takerAmount
uint8   side            // 0 = BUY, 1 = SELL  (numeric in the SIGNED struct)
uint8   signatureType   // 0 = EOA  (use 0)
uint256 timestamp       // milliseconds
bytes32 metadata        // 0x000...0 by default
bytes32 builder         // 0x000...0 by default (builder-code attribution)
```
(V1 — now rejected — had `salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, feeRateBps, side, signatureType`.)
- `signatureType`: `0`=EOA, `1`=POLY_PROXY, `2`=POLY_GNOSIS_SAFE, `3`=POLY_1271. **For an AgentKit EOA, use `0`.**
- For an EOA, `maker == signer == walletProvider.getAddress()`.
- Amounts are **6-decimal** (pUSD = 6 decimals). See §2.6 for scaling.
- **EIP-712 domains** (full objects in Appendix A.1):
  - standard: `{ name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B" }`
  - neg-risk: `{ name: "Polymarket Neg Risk CTF Exchange", version: "2", chainId: 137, verifyingContract: "0xe2222d279d744050d28e00520010520000310F59" }`

> ⚠️ **The signed struct and the POST body differ.** The struct above is what you sign (numeric `side`, no `expiration`). The `POST /order` JSON body re-serializes it with **string** `side` (`"BUY"`/`"SELL"`), string amounts, and adds `signature`. See §4.3 / Appendix C.

### 2.4 Contract addresses (Polygon, chainId 137) — re-verified 2026-06-11

| Contract | Address | Grade |
|---|---|---|
| CTF Exchange **V2** (standard) — order verifyingContract | `0xE111180000d2663C0091e4f400237545B87B996B` | **CONFIRMED** (docs `v2-migration`) |
| Neg Risk CTF Exchange **V2** — order verifyingContract | `0xe2222d279d744050d28e00520010520000310F59` | **CONFIRMED** (docs `v2-migration`) |
| Conditional Tokens (Gnosis CTF, ERC-1155) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | **CONFIRMED** (PolygonScan "Polymarket: Conditional Tokens") |
| pUSD (V2 collateral, ERC-20, **6 decimals**) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | **CONFIRMED** (PolygonScan "Polymarket: pUSD Token") |
| CollateralOnramp `wrap(...)` (USDC → pUSD) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | **CONFIRMED** (docs `/concepts/pusd`) |
| NegRiskAdapter (neg-risk redeem, 2-arg) | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | **VERIFY** — confirm this is the correct neg-risk redeem target under V2/pUSD before relying on it |
| NegRiskCtfCollateralAdapter (V2) | `0xAdA200001000ef00D07553cEE7006808F895c6F1` | **VERIFY** — pull/confirm from `docs.polymarket.com/resources/contracts` |
| USDC.e (legacy collateral / possible wrap source) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | **CONFIRMED** |
| Native USDC (Circle, Polygon) | `0x3c499c542cef5e3811e1192cE70d8cc03d5c3359` | **CONFIRMED** — pUSD is backed by USDC; confirm which the onramp consumes (§2.7) |
| UMA CTF Adapter (resolution oracle — multiple versions live) | v3 `0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49`; "V2" `0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74`; NegRisk UMA `0x2f5e3684cb1f318ec51b00edba38d79ac2c0aa9d` | **REFERENCE ONLY** — do NOT depend on a specific adapter; check resolution via the API (§4.5), not the oracle contract |
| CTF Exchange V1 (DEPRECATED) | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | reference only — do NOT use |
| Neg Risk Exchange V1 (DEPRECATED) | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | reference only — do NOT use |

> **VERIFY items are blocking only for neg-risk `redeem_winnings`.** Standard binary markets are fully unblocked. Put the two VERIFY addresses in `constants.ts` with an inline `// TODO: verify against docs.polymarket.com/resources/contracts before PR` and add a line to the pre-PR checklist.

### 2.5 CTF token model
Outcomes are ERC-1155 tokens. **Token IDs are returned directly in the Gamma `clobTokenIds` array**, so prefer the API-provided IDs over manual computation.
- `conditionId = getConditionId(oracle, questionId, outcomeSlotCount=2)`.
- Binary `indexSet`: `1` (0b01) = first outcome, `2` (0b10) = second.
- Manual computation (`getPositionId`/`getCollectionId`) is only needed for the on-chain `balanceOf` fallback (§4.4); otherwise use API IDs.

### 2.6 Amount scaling (6-decimal pUSD) — STRONG SIGNAL, confirm rounding against a live order
`price` ∈ (0,1); `size` = number of shares. With `D = 10^6`:
- **BUY:** `makerAmount = round(price * size * D)` (pUSD spent); `takerAmount = round(size * D)` (shares received).
- **SELL:** `makerAmount = round(size * D)` (shares sold); `takerAmount = round(price * size * D)` (pUSD received).
- Rounding: Polymarket's clients round to the market `tick size` / size precision (helpers like `roundDown`/`roundNormal`). **Implement a single `scaleAmounts(side, price, size, tickSize)` helper in `utils.ts`; verify the rounding direction against one real `get_market` tick size + a dry-run order before merge.** Reject in-schema any `price` outside `[0,1]`.

### 2.7 Allowances / prerequisites (on-chain, before trading/redeeming)
1. `approve` pUSD (ERC-20) for the CTF Exchange V2 (and the neg-risk exchange when `negRisk`).
2. `setApprovalForAll` on the CTF ERC-1155 (`0x4D97…6045`) for the exchange/adapter operators.
3. To fund pUSD: `approve` the CollateralOnramp to spend the source token, then `wrap(...)`. **Confirm the wrap source token (USDC.e vs native USDC) against `/concepts/pusd` before implementing the wrap path.**
- An **allowance-preflight helper** (Appendix D) checks `allowance`/`isApprovedForAll` via `readContract` and only sends approvals when missing. Prefer **exact-amount** approvals; document the `MAX_UINT256` UX tradeoff in the README (§8).

### 2.8 Redeem (`redeemPositions`)
- **Standard binary:** CTF `redeemPositions(address collateralToken=pUSD, bytes32 parentCollectionId=bytes32(0), bytes32 conditionId, uint256[] indexSets=[1,2])`.
- **Neg-risk:** NegRiskAdapter 2-arg `redeemPositions(bytes32 conditionId, uint256[] amounts)` — adapter address VERIFY (§2.4).
- Guard: only call when the market is **resolved** (§4.5).

---

## 3. Architecture & Integration Boundary
- **Off-chain REST, no signing:** `get_markets`, `get_market`, `get_positions` (Gamma + CLOB + Data reads).
- **Off-chain REST, signed:** `place_order` — derive L2 creds (L1 EIP-712) → build V2 order → EIP-712 sign → `POST /order` with L2 HMAC headers.
- **On-chain (Polygon):** `redeem_winnings` (`redeemPositions`), plus the allowance/wrap preflight.
- **Matching boundary:** orders are matched off-chain by Polymarket's operator and settled on-chain by the CTF Exchange. The provider **never matches** — it signs and submits. Redemption is fully on-chain.
- **Network:** Polygon-only.
  ```typescript
  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" && network.chainId === "137";
  ```
- **Provider state:** a private, lazily-populated `#creds?: { apiKey, secret, passphrase }` cache (per §0.5 decision 2). No secrets in the constructor.

---

## 4. Action-by-Action Spec

> **Return shape (all actions):** a JSON string. Success: `{"success":true, ...payload}`. Failure: `{"success":false,"error":"<message>"}`. Mirrors the `pyth` provider. Never throw.

### 4.1 `get_markets`
- **Schema:** `{ limit?: number (default 20), active?: boolean, order?: string (e.g. "volume24hr"), ascending?: boolean, tagSlug?: string }`. Every field `.describe()`.
- **Sub-steps:** (1) build query string from provided args; (2) `GET {GAMMA}/markets?<params>`; (3) on `!ok` return `{success:false,error:"HTTP <status>"}`; (4) map results to a compact shape (`question, conditionId, clobTokenIds, outcomes, outcomePrices, liquidityNum, volumeNum, negRisk, active, closed`); (5) empty → `{success:true, markets:[], message:"No markets found"}`.
- **No wallet, no signing.**

### 4.2 `get_market`
- **Schema:** `{ conditionId?: string, tokenId?: string, slug?: string }` — `.refine(...)` requiring **at least one**.
- **Sub-steps:** (1) resolve the market via Gamma (`GET /markets/{id}` by conditionId, or `GET /markets?slug=` / filter — confirm the by-slug path); (2) extract a `tokenId` from `clobTokenIds` if not supplied; (3) merge live CLOB data: `GET /book?token_id=`, `GET /midpoint?token_id=`, `GET /price?token_id=&side=BUY|SELL`, tick size; (4) return merged JSON (`bestBid, bestAsk, spread, midpoint, orderbook depth, tickSize, negRisk, closed`).
- **Edge cases:** closed/resolved markets; surface the **taker-delay** note (a ~250 ms hold applies to marketable orders on selected crypto/finance up-down markets; orders can't be cancelled during the hold) in the returned data when the market flags it.

### 4.3 `place_order`  *(the only signed-REST action)*
- **Schema:** `{ tokenId: string, side: "BUY"|"SELL", price: number (0–1), size: number, orderType?: "GTC"|"GTD"|"FOK"|"FAK" (default "GTC"), negRisk?: boolean (default false) }`. Bound `price` to `[0,1]` and `size > 0` in Zod.
- **Sub-steps:**
  1. **Creds:** if `#creds` unset → `ensureCreds()` (Appendix A.2 / B): build L1 headers from a ClobAuth EIP-712 signature, try `GET /auth/derive-api-key`; on failure `POST /auth/api-key`; cache result.
  2. **Allowance preflight** (Appendix D): ensure pUSD approval (BUY) or ERC-1155 `setApprovalForAll` (SELL) for the correct exchange (standard vs neg-risk); send approvals only if missing.
  3. **Build order:** compute `makerAmount`/`takerAmount` via `scaleAmounts` (§2.6); assemble the signed struct (numeric `side`, `signatureType=0`, `timestamp=Date.now()`, random `salt`, `metadata=bytes32(0)`, `builder=bytes32(0)`, `maker=signer=getAddress()`).
  4. **Sign:** `walletProvider.signTypedData({ domain, types, primaryType:"Order", message })` with the domain selected by `negRisk` (Appendix A.1).
  5. **POST:** serialize the POST body (string `side`, string amounts, `signature`, `owner=apiKey`, `orderType`) (Appendix C); send to `POST /order` with **L2 HMAC headers** (Appendix B) over the JSON body.
  6. **Return:** `{success:true, orderId, status}` (status: matched / live / unmatched).
- **Edge cases / errors (return as strings):** wrong domain version (must be `"2"`); insufficient pUSD balance/allowance ("not enough balance or allowance" → preflight already ran, surface clearly); tick-size rejection; taker-delay window; partial fills (FAK); heartbeat (open orders cancelled if no valid heartbeat within ~10 s — note in description, do not implement WS). Slippage: GTC/GTD rest at price; FOK/FAK execute against resting liquidity bounded by `price`.

### 4.4 `get_positions`
- **Schema:** `{ user?: string (default = wallet address), sizeThreshold?: number (default 1) }`.
- **Sub-steps:** (1) `user = args.user ?? walletProvider.getAddress()`; (2) `GET {DATA}/positions?user=<user>&sizeThreshold=<n>`; (3) map to `{ asset/tokenId, conditionId, size, avgPrice, curPrice, title, outcome, redeemable }`; (4) flag `redeemable` (resolved-but-unredeemed). No signing.
- **Trustless fallback (document, optional):** on-chain ERC-1155 `balanceOf(user, positionId)` via `readContract`.

### 4.5 `redeem_winnings`  *(on-chain)*
- **Schema:** `{ conditionId: string, negRisk?: boolean (default false), indexSets?: number[] (default [1,2]) }`.
- **Sub-steps:**
  1. **Resolution guard:** confirm the market is resolved before sending (e.g. Gamma market `closed`/resolution flag or Data API position `redeemable=true`). If unresolved → `{success:false,error:"Market not resolved"}` (avoid an on-chain revert).
  2. **Standard:** `encodeFunctionData` for CTF `redeemPositions(pUSD, bytes32(0), conditionId, indexSets)` → `sendTransaction({to: CTF, data})`.
  3. **Neg-risk:** NegRiskAdapter 2-arg `redeemPositions(conditionId, amounts)` (adapter address VERIFY §2.4); compute `amounts` from positions.
  4. `waitForTransactionReceipt(hash)`.
  5. **Return:** `{success:true, txHash, conditionId}` (+ redeemed amount if derivable from logs/positions).
- **Edge cases:** unresolved (guarded); zero balance; neg-risk amounts-array shape; adapter approval needed; redemption-to-pUSD path.

---

## 5. File Structure
See §0.2. `constants.ts` holds the verified §2.4 address table, the two EIP-712 domains + the `Order` and `ClobAuth` `types` objects (Appendix A), API base URLs, `POLYGON_CHAIN_ID="137"`, and minimal ABIs (CTF `redeemPositions`; NegRiskAdapter `redeemPositions`; ERC-20 `approve`/`allowance`; ERC-1155 `setApprovalForAll`/`isApprovedForAll`/`balanceOf`; CollateralOnramp `wrap`). `utils.ts` holds the HTTP client, `scaleAmounts`, EIP-712 message builders, `buildL1Headers`/`buildL2Headers`/`buildPolyHmacSignature`, `ensureCreds`, and the allowance-preflight helper.

---

## 6. Ordered Implementation Steps
1. From `typescript/`: `pnpm install`; confirm Node 22 / pnpm 10.7.
2. **Open the tracking issue first** (§0.5b); re-check for collision PRs. *(human-only)*
3. Scaffold `polymarket/` (script or copy `pyth`/`erc721`).
4. `constants.ts` — addresses (§2.4), domains + `Order`/`ClobAuth` types (Appendix A), base URLs, chainId, ABIs.
5. `schemas.ts` — the 5 schemas (§4), every field `.describe()`, no `.strip()`, with `price`/`size` bounds and the `get_market` refinement.
6. `utils.ts` core — HTTP wrapper (fetch + `!ok` handling), `scaleAmounts`, EIP-712 builders.
7. `get_markets` (Gamma).
8. `get_market` (Gamma + CLOB merge).
9. `get_positions` (Data API; optional on-chain fallback).
10. `utils.ts` auth — `buildPolyHmacSignature` (Appendix B), `buildL1Headers`/`buildL2Headers`, `ensureCreds` (derive→create, cache).
11. `place_order` (creds → preflight → build → sign → POST).
12. Allowance-preflight helper (Appendix D); wire into `place_order`/`redeem_winnings`.
13. `redeem_winnings` (CTF / NegRiskAdapter + receipt).
14. `supportsNetwork` (Polygon-only).
15. Factory export + re-export from `src/action-providers/index.ts`.
16. `polymarketActionProvider.test.ts` (§7).
17. `README.md` (incl. ToS/geo warning).
18. `pnpm build`, `pnpm test`, `pnpm run lint`, `pnpm run format` — all green.
19. `pnpm run changeset` → patch, past tense.
20. Pre-PR checklist (CLAUDE.md) — strip `docs-internal/`, rebase, sign commits. *(human-only steps flagged there.)*

---

## 7. Testing Plan (mirror `pythActionProvider.test.ts`)
- **Harness:** `global.fetch = jest.fn()`; a mock `EvmWalletProvider` exposing `signTypedData`, `sendTransaction`, `waitForTransactionReceipt`, `readContract`, `getAddress`, `getNetwork`. `jest.resetAllMocks()` in `beforeEach`.
- **`get_markets`/`get_market`/`get_positions`:** assert URL + query params, response parsing, `!ok` → error string, empty → "no results".
- **`place_order`:**
  - Mock derive/create creds responses; assert L1 headers were sent for cred derivation.
  - Assert `signTypedData` was called with the **correct domain** (standard vs neg-risk by flag), `primaryType:"Order"`, `signatureType=0`, and **6-decimal** `makerAmount`/`takerAmount` for a known `price`/`size` (both BUY and SELL).
  - Assert the `POST /order` body shape (string side, string amounts, `signature`, `owner`, `orderType`) and that **L2 HMAC headers** are present.
  - Allowance: one test where allowance is sufficient (no approve tx) and one where it's missing (approve tx sent).
- **`redeem_winnings`:** standard path encodes `redeemPositions(pUSD, 0x0, conditionId, [1,2])` and sends tx; neg-risk path targets the adapter; unresolved-market → error string, **no tx sent**.
- **`supportsNetwork`:** true for `{protocolFamily:"evm", chainId:"137"}`; false for Base `"8453"` and non-evm.
- **HMAC unit test:** feed a known `secret/timestamp/method/path/body` and assert the signature equals the url-safe-base64 reference (guards against the hex foot-gun).

---

## 8. Security Considerations
- Private key never logged; EIP-712 signing only via the wallet provider; HMAC secret never logged.
- **Allowance scoping:** prefer exact-amount approvals over `MAX_UINT256`; document the UX tradeoff in the README.
- **Domain/version correctness:** hardcode order domain version `"2"` and the V2 verifyingContracts; ClobAuth version `"1"`. Prevents rejection/replay confusion.
- **Slippage:** enforce `price ∈ [0,1]` in schema; document FOK/FAK semantics.
- **Settlement/oracle risk:** redemption depends on UMA resolution (~2 h liveness + dispute path); guard against redeeming unresolved markets.
- **Network mismatch** guarded via `supportsNetwork`.
- **ToS / geo (legal acceptance risk) — REQUIRED in README and PR description:** Polymarket's ToS prohibits U.S. persons and certain jurisdictions, **including agents operated by persons in restricted jurisdictions**. This is a real merge/legal risk for a Coinbase-owned repo. The README MUST warn that operators are responsible for compliance; the PR description must surface it explicitly.

---

## 9. Open Questions / Gaps (evidence-graded — resolve before merge)
- **NegRiskAdapter redeem address + NegRiskCtfCollateralAdapter (V2): VERIFY** — confirm exact addresses and the correct neg-risk redeem target under V2/pUSD from `docs.polymarket.com/resources/contracts`. **Blocking for neg-risk redeem only.**
- **Amount rounding direction (§2.6): STRONG SIGNAL** — confirm `roundDown`/tick rounding against one live `get_market` tick size + a dry-run order.
- **`POST /order` body exact field set under V2 (§4.3 / Appendix C): STRONG SIGNAL** — the V2 signed struct dropped `expiration`; some docs still show `expiration` in the POST body. Confirm whether the V2 `POST /order` body includes `expiration`/`orderType` GTD handling against a live call before relying on it.
- **`GET /auth/derive-api-key` vs `POST /auth/api-key` behavior: STRONG SIGNAL** — confirm derive returns the same creds deterministically; keep the create fallback.
- **Wrap source token (USDC.e vs native USDC) for the onramp (§2.7): VERIFY** before implementing the wrap path (the wrap path is optional for v1 — orders assume the wallet already holds pUSD; document that assumption).
- **tick-size endpoint path & by-slug Gamma lookup (§4.2): STRONG SIGNAL** — confirm against live calls.
- **Maintainer acceptance of a Polygon-only provider: WEAK SIGNAL** — open the issue first (§0.5b).
- **Recency:** the V2 cutover (Apr 28, 2026) is recent; re-verify addresses/endpoints immediately before implementation.

---

## Appendix A — EIP-712 typed-data objects (paste-ready, CONFIRMED unless noted)

> Build these as plain JS objects and pass to `walletProvider.signTypedData(...)`. Do not import any Polymarket SDK.

### A.1 Order domains + types
```typescript
// constants.ts
export const EXCHANGE_DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "2",
  chainId: 137,
  verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B",
} as const;

export const NEG_RISK_EXCHANGE_DOMAIN = {
  name: "Polymarket Neg Risk CTF Exchange",
  version: "2",
  chainId: 137,
  verifyingContract: "0xe2222d279d744050d28e00520010520000310F59",
} as const;

export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;
```
> Field ordering matches `ctf-exchange-v2` (CONFIRMED). If a live order is rejected with a signature error, re-diff this ordering against `ctf-exchange-v2/src/.../Structs.sol` — ordering is load-bearing for the type hash.

### A.2 ClobAuth (L1) — CONFIRMED (`clob-client/src/signing`)
```typescript
export const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
} as const;

export const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

export const MSG_TO_SIGN = "This message attests that I control the given wallet";
// message value above; timestamp is a unix-seconds STRING; nonce defaults to 0.
```
L1 header build: `POLY_ADDRESS = getAddress()`, `POLY_TIMESTAMP = ts`, `POLY_NONCE = "0"`, `POLY_SIGNATURE = signTypedData({domain: CLOB_AUTH_DOMAIN, types: CLOB_AUTH_TYPES, primaryType:"ClobAuth", message:{address, timestamp: ts, nonce: 0, message: MSG_TO_SIGN}})`.

## Appendix B — L2 HMAC (CONFIRMED, `clob-client/src/signing/hmac.ts`) — url-safe base64, NOT hex
```typescript
import crypto from "crypto";

export function buildPolyHmacSignature(
  secret: string,        // the derived API secret (url-safe base64 string)
  timestamp: string,     // unix seconds
  method: string,        // "GET" | "POST"
  requestPath: string,   // e.g. "/order"
  body?: string,         // exact JSON string POSTed (or undefined)
): string {
  const key = Buffer.from(secret, "base64url");       // base64-url DECODE the secret
  const message = `${timestamp}${method}${requestPath}${body ?? ""}`;
  const digest = crypto.createHmac("sha256", key).update(message).digest("base64");
  return digest.replace(/\+/g, "-").replace(/\//g, "_"); // url-safe; keep "=" padding
}
```
L2 headers: `POLY_ADDRESS, POLY_TIMESTAMP, POLY_API_KEY, POLY_PASSPHRASE, POLY_SIGNATURE`. The `body` passed to the HMAC MUST be byte-identical to the body sent.

## Appendix C — `POST /order` body (STRONG SIGNAL — confirm `expiration` under V2)
```jsonc
{
  "order": {
    "salt": "<uint as string>",
    "maker": "0x...",
    "signer": "0x...",
    "tokenId": "<uint as string>",
    "makerAmount": "<6dp uint as string>",
    "takerAmount": "<6dp uint as string>",
    "side": "BUY",            // STRING here (numeric 0/1 only in the signed struct)
    "signatureType": 0,
    "timestamp": "<ms as string>",
    "metadata": "0x0000...0",
    "builder": "0x0000...0",
    "signature": "0x<eip712 sig>"
    // "expiration": "0"      // V1 field; confirm whether V2 POST body still expects it
  },
  "owner": "<apiKey UUID>",
  "orderType": "GTC"          // GTC | GTD | FOK | FAK
}
```

## Appendix D — Allowance preflight (pattern)
```
BUY  → read pUSD.allowance(owner, exchange);    if < makerAmount → pUSD.approve(exchange, amount)
SELL → read CTF.isApprovedForAll(owner, exchange); if false      → CTF.setApprovalForAll(exchange, true)
exchange = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE
```
Use `readContract` for the checks and `sendTransaction` + `waitForTransactionReceipt` for the approvals. Prefer exact-amount over `MAX_UINT256`.
