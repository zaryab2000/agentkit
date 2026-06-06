# Bridge-Then-Deploy Action Provider

This directory contains the **BridgeDeployActionProvider** — a composite action
provider that expresses a single agent intent: *"move this capital to chain X
and put it to work."* It bridges a token to a destination chain via
[Across Protocol](https://across.to) and then supplies the bridged token into a
destination lending/vault position.

## ⚠️ Two-step, non-atomic semantics (read this first)

Across destination-side execution only delivers funds to a **deployed handler
contract** that implements `AcrossMessageHandler.handleV3AcrossMessage(...)` —
**never to a plain EOA**. An AgentKit agent wallet is (usually) an EOA and
**cannot** receive the on-arrival callback. Therefore, for the common EOA case,
bridge-then-deploy is **inherently TWO-STEP and NON-ATOMIC**:

1. **Bridge** — `bridge_and_deploy` initiates the Across deposit and returns a
   `depositId`. The destination supply has **not** happened yet.
2. **Poll** — `bridge_deploy_status` polls the Across deposit-status API.
3. **Deploy** — once the bridge is `filled`, the recorded destination supply
   runs automatically (or call `deploy_on_destination` explicitly).

### ⚠️ Pending-supply state is in-memory only

When `bridge_and_deploy` runs, it records the intended destination supply in an
**in-memory map on the provider instance** so `bridge_deploy_status` can fire it
automatically once the bridge fills. This state is **not durable**: it is lost if
the provider is re-instantiated (between agent sessions, or on a process
restart), and a bridge can take up to ~an hour to fill. **The same provider
instance must be reused** across the `bridge_and_deploy` → `bridge_deploy_status`
calls for the auto-supply to fire. If the record is gone, `bridge_deploy_status`
falls back to telling you to run `deploy_on_destination` manually — no funds are
lost, but the second leg becomes a manual step.

This provider is **honest about that**: `bridge_and_deploy` never claims the
supply has completed, and the destination supply only runs once funds have
landed. Because the flow is non-atomic, a bridge can succeed while the
destination supply fails — leaving funds on the destination EOA. The
`deploy_on_destination` action performs a balance preflight and is therefore
safe to **retry** to recover from that state.

## Actions

### `bridge_and_deploy`

Initiates the Across bridge and records the pending destination supply.

- `token` — symbol of the token to bridge (e.g. `ETH`, `USDC`)
- `amount` — amount in whole units
- `destinationChainId` — destination chain ID (defaults to Base `8453`)
- `destinationProtocol` — `compound` (Comet market) or `morpho` (MetaMorpho vault)
- `protocolMarketAddress` — the Comet market or Morpho vault to supply into
- `maxSlippageBps` — (optional) max bridge slippage in basis points (default `100`)
- `recipient` — (optional) destination recipient (defaults to sender)

Returns a JSON payload with the `depositId` and `status: "bridging"`, plus
next-step guidance. **It does not supply yet.**

### `bridge_deploy_status`

Polls the bridge and runs the pending supply once filled.

- `depositId` — the ID returned by `bridge_and_deploy`
- `originChainId` — (optional) origin chain ID (defaults to current chain)

Returns `pending` while bridging, the deploy transaction hash once `filled`, or
a refund warning if the bridge was refunded.

### `deploy_on_destination`

Supplies an already-bridged token into a destination position. Usable as the
explicit second leg or standalone.

- `token` — the destination-chain ERC-20 token **address** (e.g. `0x833...`),
  **not** the symbol. (`bridge_and_deploy` takes a symbol; this action takes an
  address.)
- `amount` — amount in whole units
- `protocol` — `compound` or `morpho`
- `protocolMarketAddress` — Comet market or Morpho vault address
- `chainId` — (optional) destination chain ID (defaults to Base `8453`)
- `recipient` — (optional) position owner (defaults to sender). For Compound
  this uses `supplyTo` so the position is credited to `recipient`, not the sender.

Unlike the auto-deploy path, this action supplies the **exact** amount requested
and errors if the on-chain balance is short.

## Supported networks

- **Origin:** any EVM chain supported by Across.
- **Destination (deploy leg):** gated in-code to **Base** (`8453`, `84532`).

## Configuration

```typescript
import { bridgeDeployActionProvider } from "@coinbase/agentkit";

const provider = bridgeDeployActionProvider({ privateKey: "0x..." });
```

The `privateKey` mirrors the in-tree `across` provider and is used solely to
submit the Across deposit transaction via the Across SDK's wallet client. All
other chain I/O is routed through the wallet provider.

## Upgrade path (Flow B — not implemented in v1)

If a destination **handler/multicaller contract** is available, the bridge can
carry a `message` payload that triggers the supply **atomically on arrival**
(`handleV3AcrossMessage`). That removes the two-step requirement but needs a
deployed handler contract; it is intentionally out of scope for this v1, which
ships the EOA-safe two-step Flow A only.
