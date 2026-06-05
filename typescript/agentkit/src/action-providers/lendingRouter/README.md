# Lending Router Action Provider

A cross-protocol lending router that compares live supply/borrow APY across Compound III, Aave v3, Moonwell, and Morpho Blue on Base mainnet, then routes deposits and borrows to the optimal venue.

## Directory Structure

```
lendingRouter/
├── lendingRouterActionProvider.ts      # Provider class with @CreateAction methods
├── lendingRouterActionProvider.test.ts # Jest unit tests
├── schemas.ts                          # Zod input schemas
├── constants.ts                        # Per-protocol addresses, ABIs, scaling constants
├── utils.ts                            # Rate ranking, health aggregation, formatting
├── adapters/
│   ├── compound.ts                     # Compound III rate/position reader + supply/borrow encoding
│   ├── aave.ts                         # Aave v3 rate/position reader + supply/borrow encoding
│   ├── moonwell.ts                     # Moonwell rate/position reader + mint encoding
│   └── morpho.ts                       # Morpho Blue GraphQL rate reader + position stub
├── index.ts                            # Re-exports
└── README.md
```

## Actions

| Action | Description |
|--------|-------------|
| `compare_lending_rates` | Read live APY for an asset/side from all 4 protocols, rank best-first |
| `get_aggregated_position` | Read supply/borrow balances + health per protocol, flag lowest health |
| `route_supply` | Compare supply rates, pick best venue (or honor preference), execute supply |
| `route_borrow` | Compare borrow APY, simulate health, reject if unsafe, execute borrow (v1: Compound/Aave only) |
| `rebalance` | Detect underperforming positions, return advisory or executable rebalance plan |

## Network Support

Base mainnet only (chain ID `8453`) for v1.

## Protocol Coverage

| Protocol | Rate Reads | Position Reads | Supply Execution | Borrow Execution |
|----------|-----------|----------------|-----------------|-----------------|
| Compound III | On-chain | On-chain | Yes | Yes |
| Aave v3 | On-chain | On-chain | Yes | Yes |
| Moonwell | On-chain | On-chain | Yes (mint) | v2 |
| Morpho Blue | GraphQL API | Stub (v2) | v2 | v2 |

## v1 Limitations

- Borrow routing is Compound and Aave only (Moonwell/Morpho borrow actions do not exist in AgentKit yet)
- Morpho position tracking is minimal — full support requires market enumeration via GraphQL
- Rebalance action is advisory — returns a plan rather than auto-executing multi-leg rebalances
- USD values for Moonwell positions are not populated (requires oracle integration)

## Adding New Protocols

1. Create a new adapter in `adapters/` implementing `getRates()` and `getPosition()`
2. Add protocol constants to `constants.ts`
3. Wire the adapter into the provider's fetcher arrays
4. Add tests for the new adapter
