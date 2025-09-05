# Ethereum → Cosmos Hub → Namada Testing

## Setup
```bash
npm install
npm run dev
```
Open browser at http://localhost:5173

Using Keplr for now. Enter a Namada transparent address and click.

This utilizes the callback function on Cosmos Hub to forward the tokens to Namada.

NOTE: Currently, the memo in the IBC packet created by the CosmWasm contract should be empty because the forwarding reuses it. We need to consider how to shield the tokens on Namada.
