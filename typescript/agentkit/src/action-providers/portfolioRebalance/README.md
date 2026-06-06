# Portfolio Rebalance Action Provider

This directory contains the `PortfolioRebalanceActionProvider` implementation, which plans
the minimum set of swaps required to move a wallet from its current token allocation to a
requested target allocation on **Base mainnet**.

This is a **portfolio-level rebalancer, not a DEX router.** It reads all known holdings,
values them in USD, measures each token's drift from the requested target weights, and
computes the smallest set of source→sink swaps to restore the target. It does **not**
implement a routing engine and does **not** compete with single-swap best-execution
providers — a future execution action is intended to **compose** the existing in-tree
`zeroX` / `enso` swap actions rather than replace them.

## Actions

| Action          | Description                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_rebalance` | **Read-only.** Reads balances, prices them in USD, computes drift from the target allocation, and returns the planned swaps. Never executes any transaction. |

### `plan_rebalance`

**Inputs:**

- `targets`: list of `{ token, weightBps }`, where `token` is a supported symbol (or 0x
  address) and `weightBps` is the target weight in basis points. Weights **must sum to
  exactly 10000** (100%).
- `rebalanceThresholdBps` _(optional, default 100)_: minimum absolute drift in basis points
  before a token is included in the plan. Drift below this is treated as dust and ignored.

**Output:** stringified JSON containing the current weights, per-token drift, the planned
swaps (`from`, `to`, `amountUsd`, `estSellAmount`), the total USD value, and whether a
rebalance is needed.

## Planning algorithm

Drift is computed per token as `currentWeightBps − targetWeightBps`. Tokens above target
(beyond the threshold) are **sources**; tokens below target are **sinks**. The planner uses
a **greedy largest-surplus → largest-deficit** match in USD space: it repeatedly pairs the
biggest remaining surplus with the biggest remaining deficit until all deficits are filled.

This greedy approach minimizes the number of swap legs and is fully explainable. A
holistic/global optimizer could in some cases reduce total notional further; greedy is the
v1 choice for predictability and is sufficient for typical baskets.

## Pricing

USD prices come from the keyless [DefiLlama price API](https://coins.llama.fi). A held token
with no available price is reported as a warning and excluded from the valuation.

## Supported tokens (v1)

USDC, WETH, CBBTC, CBETH, EURC, DAI, AERO — all on Base mainnet.

## Network support

Base mainnet only (`evm`, chain ID `8453`).

## Adding to AgentKit

The factory is re-exported from `src/action-providers/index.ts` as
`portfolioRebalanceActionProvider`.
