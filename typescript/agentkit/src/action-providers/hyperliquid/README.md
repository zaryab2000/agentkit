# Hyperliquid Action Provider

This directory contains the **HyperliquidActionProvider**, which lets an AgentKit agent trade
Hyperliquid perpetuals **from HyperEVM** (chainId 999 mainnet / 998 testnet). It reads HyperCore
market data and positions through read precompiles and submits orders through the CoreWriter system
contract.

## ⚠️ The HyperEVM ↔ HyperCore async boundary (read this first)

Hyperliquid has two layers that share one chain:

- **HyperCore** — the native L1 order book / perp engine.
- **HyperEVM** — the EVM execution layer this provider talks to.

Contracts on HyperEVM can only **read** HyperCore state (via precompiles) and **write** to it (via
CoreWriter). The boundary has two consequences this provider cannot hide:

1. **Reads are start-of-block snapshots.** Precompile values reflect HyperCore state as of the start
   of the current EVM block. An order you just submitted via `open_position` may **not** be visible
   to `get_positions` until a later block.
2. **Writes are asynchronous and non-atomic.** `open_position` / `close_position` send an action to
   CoreWriter, which **queues** it; HyperCore executes it a few seconds later. The EVM transaction
   succeeding does **NOT** mean the order filled — there is no in-transaction confirmation and **no
   revert if the core-side action fails.** Every write action returns `status: "submitted"` (never
   "filled"); always poll `get_positions` afterwards to confirm the result.

## Actions

| Action | Type | Description |
| --- | --- | --- |
| `get_markets` | read | Perp metadata (and optional mark/oracle prices) for the given asset indices. |
| `get_positions` | read | Positions with computed unrealized PnL for the agent (or a given user). |
| `open_position` | write | Submit a limit order to open/add to a perp position (CoreWriter action id 1). |
| `close_position` | write | Submit a reduce-only order to close/reduce a position. |

### Notes & limitations

- **Market enumeration:** precompiles cannot list all perps, so `get_markets` / `get_positions`
  require an explicit array of asset indices. Full discovery needs the native Hyperliquid info API,
  which this provider does not use.
- **Funds-on-perp precondition:** perp orders require collateral already on the HyperCore perp side.
  Moving funds there (USD class transfer / bridging) is out of scope for this provider.
- **Price/size scaling:** `limitPx` and `size` are sent to CoreWriter as `uint64(round(value × 1e8))`.
  Tick-size and significant-figure constraints are enforced by HyperCore; pass valid values.
- **`set_leverage` is not supported.** CoreWriter exposes no leverage/margin-mode action, so leverage
  **cannot be set from HyperEVM**. Set it via the native Hyperliquid L1 API (`updateLeverage` /
  `updateIsolatedMargin`) or an approved agent wallet instead.

## Network support

HyperEVM only: `chainId` `"999"` (mainnet) or `"998"` (testnet), `protocolFamily === "evm"`.

## Example

```typescript
import { hyperliquidActionProvider } from "@coinbase/agentkit";

const provider = hyperliquidActionProvider();

// Read markets 0 and 1 with prices.
await provider.getMarkets(walletProvider, { indices: [0, 1], includePrices: true });

// Submit a market-like long: aggressive price + Ioc.
await provider.openPosition(walletProvider, {
  asset: 0,
  isBuy: true,
  size: 0.1,
  limitPx: 999999, // aggressive bound for an Ioc fill
  tif: "Ioc",
});

// Confirm — settlement is async, so poll.
await provider.getPositions(walletProvider, { perpIndices: [0] });
```

## Security considerations

- **Never assume a fill** from a successful transaction — settlement is asynchronous and may fail
  silently on the core side. Verify with a follow-up `get_positions` read.
- **Scaling errors** (`× 1e8`) can mis-size orders; inputs are validated and the encoding is
  regression-tested against a fixed calldata vector.
- **Oracle/precompile risk:** precompile prices are validator-set-derived and have been manipulated
  in the past (the March 2025 JELLY incident). Use `limitPx` protection; `close_position` applies a
  configurable slippage bound (`slippageBps`, default 5%).
- **Invalid precompile inputs consume all gas** — asset indices are range-validated before any call.
