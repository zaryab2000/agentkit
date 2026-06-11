# Polymarket Action Provider

This directory contains the **PolymarketActionProvider** implementation, which provides actions to interact with **Polymarket**, the prediction-market CLOB (CTF Exchange V2 + pUSD collateral) on **Polygon mainnet**.

## Directory Structure

```
polymarket/
├── polymarketActionProvider.ts        # Main provider with Polymarket functionality
├── polymarketActionProvider.test.ts   # Tests
├── schemas.ts                         # Action schemas
├── constants.ts                       # Addresses, ABIs, API URLs, EIP-712 domains
├── utils.ts                           # HTTP client, EIP-712/HMAC helpers, scaling
├── index.ts                           # Main exports
└── README.md                          # This file
```

## Actions

- `get_markets`: Discover prediction markets via the Gamma API
- `get_market`: Fetch a single market with live odds and liquidity (Gamma + CLOB orderbook)
- `place_order`: Sign (EIP-712) and place a buy/sell order on the CLOB
- `get_positions`: Read a wallet's positions via the Data API
- `redeem_winnings`: Redeem winnings from a resolved market on-chain

## Adding New Actions

To add new Polymarket actions:

1. Define your action schema in `schemas.ts`
2. Implement the action in `polymarketActionProvider.ts`
3. Add tests in `polymarketActionProvider.test.ts`

## Network Support

The Polymarket provider supports **Polygon mainnet only** (chainId `137`). Polymarket
trades exclusively on Polygon, so `supportsNetwork` returns true only for that network.

## Collateral

Trading collateral is **pUSD** (Polymarket USD), an ERC-20 with 6 decimals backed 1:1
by USDC. Ensure the wallet holds enough pUSD before placing buy orders. `place_order`
automatically sets the required token allowances (pUSD for buys, the Conditional Tokens
operator approval for sells) when they are missing.

## Authentication

`place_order` derives Polymarket API credentials on the fly using an EIP-712 signature
from the connected wallet (L1), then authenticates each order request with HMAC headers
(L2). No API keys or secrets need to be configured.

## ⚠️ Compliance Warning

Polymarket's Terms of Service prohibit use by U.S. persons and persons in certain other
restricted jurisdictions, **including agents operated by persons in those jurisdictions**.
Operators of an agent using this provider are solely responsible for ensuring their use
complies with Polymarket's Terms of Service and all applicable laws and regulations in
their jurisdiction.

## Notes

For more information on **Polymarket**, visit the [Polymarket Documentation](https://docs.polymarket.com/).
