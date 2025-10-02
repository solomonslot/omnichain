# Omnichain

Omnichain is a Solidity-based system for cross‑chain value flows composed of two contracts: EscrowVault, which escrows USDC and bridges intent via a Warp Portal, and NftRedemption, which settles ERC‑20 rewards based on off‑chain EIP‑712 attestations. EscrowVault locks funds, pays a message toll, and emits a canonical payload to a destination chain; a verified return message finalizes with either a payout to a fixed recipient or a refund. NftRedemption verifies attestor signatures, enforces per‑NFT one‑time redemption, and transfers rewards to the signed EVM recipient.

## Features

- EscrowVault: Deterministic USDC escrow keyed by paymentId; records collectionId, quantity, offerId, and three Chia puzzle hashes (bridgingPuzzle, trustedPuzzle, destinationPuzzle).
- Bridging mechanics: Queries IPortal.messageToll(), pays the exact toll, then calls IPortal.sendMessage(sourceChain, bridgingPuzzle, contents) with contents = [paymentId, amountUSDC, quantity, collectionId, offerId, destinationPuzzle].
- Finalization: receiveMessage enforces msg.sender == warpPortal, source_chain == configured sourceChain, nonce anti‑replay, _source == trustedPuzzle, and remoteAmount ≤ escrowed amount; routes funds to payoutAddress on pass, or refunds depositor on fail.
- Admin/Emergency (EscrowVault): pause/unpause, setSourceChain, and owner setPayout(paymentId, recipient) to resolve stuck escrows.
- NftRedemption: EIP‑712 domain "Solslot‑Redemption" v1; verifies attestor signature over {poolId, evmAddress, blsPubkey, nftSetHash, pricingHash, nftCount, totalReward, issuedAt, nonce}; prevents replay via nonce and per‑NFT redeemed flags.
- Integrity and payout (NftRedemption): Requires strictly ascending nftIds and nftSetHash = keccak256(lowerhex(ids joined by "\n")); optional maxClaimAge; payouts via SafeERC20 to the signed evmAddress.
- Security: Uses OpenZeppelin Ownable, Pausable, ReentrancyGuard, and SafeERC20 where applicable.


## Repository Structure

- contracts/ — Solidity contracts (EscrowVault, NftRedemption)
- scripts/ — Hardhat scripts (deployment, utilities, and demos)
- test/ — Hardhat tests

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


## Setup

1) Clone and install dependencies

    git clone https://github.com/your-org/omnichain.git
    cd omnichain
    npm install

2) Copy the example environment file and fill in values

    cp .env.example .env
    # Edit .env with your keys and addresses



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



Tip: Keep addresses consistent with the network your RPC points to.

## Deploy Instructions (Typical Flow)

1) Configure your .env for the chosen network (RPC + MNEMONIC/PRIVATE_KEY).
2) Compile the contracts:

    npx hardhat compile

3) Deploy using your preferred script:

    npx hardhat run scripts/deploy.js --network baseMainnet

4) Note the deployed addresses and update your .env (e.g., ESCROW_CONTRACT).

5) Interact via scripts or Hardhat tasks as needed.



## Security

- Never commit secrets. Only commit .env.example.
- Use distinct keys for development vs. production and rotate regularly.
- Verify contract code, dependencies, and addresses before deploying to mainnets.
- Consider audits and thorough testing before production use.

## License

MIT