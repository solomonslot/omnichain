# Omnichain

A simple, beginner‑friendly smart‑contract project that demonstrates a cross‑chain escrow flow. Funds are locked in an on‑chain escrow (EscrowVault). A message is emitted to a Warp Portal, and funds are released when a verified return message is received. An optional Node.js “backend oracle” shows how to watch events and confirm cross‑chain receipts.

## Features

- Secure escrow: Lock funds under a unique payment ID
- Cross‑chain messaging: Integrates with a Warp Portal pattern
- Replay protection: Uses unique nonces to prevent double‑processing
- Admin controls: Pause, configure bridging settings, and emergency payout
- Optional oracle: Example Node.js service to listen for events and confirm messages

## Repository Structure

- contracts/ — Solidity contracts (EscrowVault, NftRedemption, TestToken)
- scripts/ — Hardhat scripts (deployment, utilities, and demos)
- test/ — Hardhat tests
- backend/ — Example Node/Express service for event watching and manual confirmation
- hardhat.config.js — Hardhat configuration
- package.json — Project metadata and dev dependencies
- .env.example — Sample environment file (do not commit real secrets)
- readme.md — This guide

Common build artifacts (artifacts/, cache/, node_modules/, logs) are ignored by default.

## Prerequisites

- Node.js 18+ and npm
- Git
- A public RPC endpoint for your target network (e.g., Base)
- A funded wallet (for deployment and on‑chain interactions)
- Optional: A WebSocket RPC endpoint for the backend oracle

## Setup

1) Clone and install dependencies

    git clone https://github.com/your-org/omnichain.git
    cd omnichain
    npm install

2) Copy the example environment file and fill in values

    cp .env.example .env
    # Edit .env with your keys and addresses

3) (Optional) Install backend dependencies

    cd backend
    npm install
    cd ..

## Quick Start (Contracts)

1) Compile

    npx hardhat compile

2) Run tests (if any)

    npx hardhat test

3) Deploy (example: using the baseMainnet network from hardhat.config.js)

    npx hardhat run scripts/deploy.js --network baseMainnet

Adjust the network flag to match your configuration.

## Environment Variables

Create a .env in the project root (never commit secrets). See .env.example for a full, documented template. Common variables:

- BASE_MAINNET_RPC_URL — HTTPS RPC for Hardhat tasks and scripts
- MNEMONIC — 12/24‑word seed for deploying and scripts (dev or throwaway recommended)
- PRIVATE_KEY — Alternative to MNEMONIC (use one or the other)

Optional (backend oracle):

- PROVIDER_URL — WebSocket or HTTPS RPC for the backend (wss:// recommended)
- ESCROW_CONTRACT — Deployed EscrowVault address
- WARP_PORTAL — Warp Portal contract address
- WARP_API_URL — Public API to query message status
- PORT — Backend HTTP port (default 3000)

Tip: Keep addresses consistent with the network your RPC points to.

## Deploy Instructions (Typical Flow)

1) Configure your .env for the chosen network (RPC + MNEMONIC/PRIVATE_KEY).
2) Compile the contracts:

    npx hardhat compile

3) Deploy using your preferred script:

    npx hardhat run scripts/deploy.js --network baseMainnet

4) Note the deployed addresses and update your .env (e.g., ESCROW_CONTRACT).

5) Interact via scripts or Hardhat tasks as needed.

## Optional: Backend Oracle (Demo)

The backend is an example service that:
- Connects to your RPC endpoint
- Watches EscrowVault PaymentEscrowed events and Warp Portal MessageSent events
- Optionally calls back on chain when it sees a “received” status for a message nonce

Start the backend:

    cd backend
    npm start

HTTP endpoint (manual check):

- POST /poll
  - body: { "paymentId": "0x..." }
  - Returns whether the related message is “received” and, if so, confirms on chain

Important:
- The sample endpoint is not authenticated. Use only in trusted environments.
- Prefer WebSocket RPC (wss://) for reliable live event streaming.

## Security

- Never commit secrets. Only commit .env.example.
- Use distinct keys for development vs. production and rotate regularly.
- Verify contract code, dependencies, and addresses before deploying to mainnets.
- Consider audits and thorough testing before production use.

## License

MIT