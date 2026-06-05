# CLAUDE.md — working rules for this fork of coinbase/agentkit

This is a **fork** of `coinbase/agentkit`. The goal of every feature branch here is **one new ActionProvider (AP) that Coinbase will merge upstream**. Read this file fully before doing anything.

## What you are building
- Each `feat/<apName>` branch builds exactly **one** AP. The spec for the current branch is in **`docs-internal/`** (read it first — it is self-contained and authoritative).
- `docs-internal/` is **internal only**. It must be **stripped from the branch before opening a PR to coinbase/agentkit** (it is on the PR-cleanup checklist). Do not reference it from any committed AP code.

## Hard rules (do not violate)
1. **Branches only — NEVER commit to `main`.** `main` mirrors `upstream/main` and must stay pristine. Work only on the current `feat/*` branch.
2. **Push ONLY when the human explicitly tells you to.** You may `git add` and `git commit` on the feature branch freely. Do NOT `git push` on your own — wait until the human says "push this" (or similar), then push to **this branch's** remote (`origin <currentBranch>`) only. Never push to a different branch, never force-push, never push `main`.
3. **NEVER create a PR.** PR creation is the human's job, done manually at the very end of each branch after the PRE-FINAL-PR checklist below is satisfied. Do not run `gh pr create` or open PRs through any tool, ever.
4. **NEVER push to `upstream` (coinbase/agentkit).** Upstream push is disabled; do not re-enable it.
5. **No secrets needed — this is build + mock-test only.** Do NOT ask for, create, read, or commit any API keys, private keys, `.env` files, CDP keys, or wallet secrets. Unit tests mock the wallet provider entirely. If a task seems to need a real secret, you are doing it wrong — stop and flag it.
6. **Commits may be unsigned here.** The human signs/squashes at PR time from their Mac (see PRE-FINAL-PR checklist). Do not attempt to configure signing.

## AgentKit AP conventions (the merge rubric — match these exactly)
Verified against the repo. An AP that violates these will not merge.
- **Location:** `typescript/agentkit/src/action-providers/<apName>/` with `<apName>ActionProvider.ts`, `schemas.ts`, `<apName>ActionProvider.test.ts` (REQUIRED), `index.ts`, `README.md` (REQUIRED), and usually `constants.ts`/`utils.ts`.
- **Class:** `export class <Name>ActionProvider extends ActionProvider<EvmWalletProvider>` (use `WalletProvider` base for non-EVM); constructor calls `super("<apName>", [])`.
- **Actions:** `async` instance methods decorated with `@CreateAction({ name, description, schema })`, returning **`Promise<string>`**. **Errors are caught and RETURNED as strings, never thrown.**
- **Descriptions** are LLM prompts: describe inputs, outputs, examples, and when to ask the user / call another action first.
- **Schemas (Zod v4):** plain `z.object({ ... }).describe("...")` with `.describe()` on **every** field. **Do NOT use `.strip()`** (it is not the current house style; the snippet in CONTRIBUTING-TYPESCRIPT.md is stale).
- **`supportsNetwork`** is an arrow-function property. `Network.chainId` is a **string** (e.g. Base mainnet is `"8453"`).
- **Factory export:** `export const <apName>ActionProvider = () => new <Name>ActionProvider();`
- **Re-export** the factory from `typescript/agentkit/src/action-providers/index.ts`.
- **Dependency baseline (verified in `typescript/agentkit/package.json`):** `zod@^4.3.6` (v4), `viem@2.47.4`, `ethers@^6.13.5` (v6). All chain I/O goes through **viem via the wallet provider** (`sendTransaction`, `waitForTransactionReceipt`, `signTypedData`, `readContract`, `getPublicClient()` — there is **no `staticcall` method**). Pin any new dependency to an exact version (no `^`).

## Toolchain & commands (run from `typescript/`)
- Node 22+, pnpm 10.7.x (corepack pins it). `pnpm install` once from `typescript/`.
- Build: `pnpm build`. Test: `pnpm test` (jest — mirror `pythActionProvider.test.ts`). Lint: `pnpm run lint` / `pnpm run lint:fix`. Format: `pnpm run format`.
- Changelog: `pnpm run changeset` → package `@coinbase/agentkit`, type **patch**, summary in **past tense** (e.g. "Added a best-rate lending router action provider").

## Definition of done — CODE (Claude completes these on the branch)
- [ ] All actions return `Promise<string>`; errors returned not thrown.
- [ ] Zod schemas plain `.describe()` on every field, no `.strip()`.
- [ ] `supportsNetwork` correctly scoped (Base-first per the PRD).
- [ ] `pnpm test` green (unit tests, mocked wallet); `pnpm run lint` and `pnpm run format` clean; `pnpm build` clean.
- [ ] Per-provider `README.md` present.
- [ ] Factory re-exported from `src/action-providers/index.ts`.
- [ ] Changeset added (patch, past tense).

## ⚠️ PRE-FINAL-PR CHECKLIST (memorize — do these BEFORE the PR is merge-worthy)
The human creates the PR, but Claude must remember and proactively run/remind these whenever a branch is "ready". A PR that skips any of these will NOT be merged upstream. In order:

1. **Strip internal docs.** `git rm -r docs-internal/` and commit — `docs-internal/` must NOT appear in the PR diff to coinbase/agentkit. Also remove the fork-only `CLAUDE.md`, `.claude/`, and the fork-local `.gitignore` additions if they would show in the diff (they live on the feature branch for our workflow; they are not part of the AP contribution).
2. **Sync with upstream.** `git fetch upstream && git checkout main && git merge --ff-only upstream/main`, then `git checkout <branch> && git rebase main`. The repo moves fast — branch must rebase cleanly on the latest `main`.
3. **Re-run all checks on the rebased branch:** `pnpm build`, `pnpm test`, `pnpm run lint`, `pnpm run format` — all green.
4. **Changeset present** (patch, past tense, package `@coinbase/agentkit`).
5. **SIGN the commits.** Upstream **hard-requires all commits signed** (`cb-heimdall` CI rejects unsigned). The human signs/squashes from their Mac: e.g. squash the branch to clean commits and `git commit -S` / `git rebase --exec 'git commit --amend --no-edit -S'`. Verify with `git log --show-signature`. **This is the single most common reason a PR cannot merge — do not forget it.**
6. **Tracking issue opened** on coinbase/agentkit for this AP (the PRD's merge-likelihood gate — off-Base / middleware APs should be confirmed with maintainers first), to link in the PR.
7. **PR hygiene:** clean commit history, PR template filled, issue linked, only the AP's files in the diff (no `docs-internal/`, no fork tooling).

Claude: when a branch's CODE definition-of-done is met, summarize this checklist to the human and offer to perform steps 1–4 on request; **steps 5 (signing) and the PR itself are human-only.**

## When unsure
Re-read the branch's `docs-internal/` PRD. If the PRD and this file conflict, this file's hard rules win. If something needs a real secret, a push, or a PR — stop and ask the human.
