# Ethereum → Cosmos Hub → Namada Testing

## Setup
```bash
npm install
npm run dev
```
Open browser at http://localhost:5173

Using Keplr and Namada keychain for now. Enter the amount to be transferred and click.
The destination address on Ethereum/Namada is loaded from Keplr or Namada keychain (default accont).

This utilizes the callback function on Cosmos Hub to forward the tokens to Namada/Ethereum.

NOTE: Currently, the memo in the IBC packet created by the CosmWasm contract should be empty because the forwarding reuses it. We need to consider how to shield the tokens on Namada.
