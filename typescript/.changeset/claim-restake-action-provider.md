---
"@coinbase/agentkit": patch
---

Added a claim-and-restake action provider that harvests Compound III, Moonwell and Morpho lending rewards, applies a gas-vs-reward threshold gate, optionally swaps the reward, and restakes into the same protocol or a generic ERC-4626 vault on Base.
