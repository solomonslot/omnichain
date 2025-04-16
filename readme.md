Omnichain is a cross‑chain escrow solution that leverages a Solidity smart contract to lock USDC during cross‑chain transfers. The EscrowVault contract sends cross‑chain messages via a Warp Portal, which instructs a remote chain to mint or unlock assets, and—upon receiving a verified return message—releases the escrowed funds to a fixed payout address.

Overview
Omnichain is designed to support cross‑chain transfers by securely escrow‑ing USDC. The EscrowVault contract:

Receives deposits and locks USDC.

Sends out cross‑chain messages using a Warp Portal.

Verifies return messages before releasing escrowed funds.

Provides an admin-controlled emergency mechanism for releasing funds in case of bridging failures.

In addition, the repository includes an example oracle backend that tracks deposit events and Warp Portal messages. Although the current version of EscrowVault does not actively leverage the oracle for its workflow, it serves as a foundation for future contracts where off‑chain message tracking and confirmation may be required.

Features
Secure Escrow Functionality
The contract securely holds USDC and enforces strict deposit rules (unique payment IDs and proper toll payments).

Cross‑Chain Messaging Integration
Utilizes a Warp Portal contract to facilitate cross‑chain communications by sending messages with structured payloads.

Replay Protection and Input Validation
Each message is validated against replay attacks, ensuring that each nonce is used only once.

Admin & Emergency Functions
The owner may pause the contract, reconfigure bridging parameters, or force a payout, providing a fallback mechanism if the normal cross‑chain process fails.

Example Oracle Service
The backend oracle code demonstrates how to track on‑chain events for future use. It provides an example implementation using WebSockets, event listeners, and REST endpoints for manual polling and confirmation.

Contracts
EscrowVault
The primary contract, EscrowVault.sol, implements:

Deposit Process: Users deposit USDC with a unique payment identifier and a toll in ETH.

Cross‑chain Interaction: After depositing, the contract triggers a cross‑chain message.

Receiving Cross‑chain Messages: When the contract receives a valid message from the trusted source, it releases USDC to a fixed payout address.

Admin Functions: Functions like setPayout, pause, and configureBridging enable administrative control and emergency measures.

Key interfaces include:

IERC20: Minimal interface for USDC (transfer and transferFrom).

IPortal: Interface for obtaining message tolls and sending messages via the Warp Portal.

Oracle Backend Example
The oracle backend code is provided as an example of how to track events from the EscrowVault and the Warp Portal contracts using an off‑chain Node.js service. It demonstrates:

WebSocket Connection to listen for on‑chain events.

Polling and Manual Endpoints: An Express server exposes a POST /poll endpoint (protected with an API key) for manually triggering message confirmations.

Event Processing: It logs and tracks pending deposit events and interacts with an external API (Warp API) to check message status.

Note: Currently, the EscrowVault contract uses its own receiveMessage function for on‑chain confirmation. The oracle backend is intended for future enhancements where off‑chain orchestration might be required.

Getting Started
Prerequisites
Node.js (>=14.x)

npm or yarn

Hardhat (installed as a dev dependency)

An Ethereum JSON-RPC provider (e.g., Alchemy, Infura, or a dedicated provider like Base)

A .env file (see below)

Environment Variables
Create a .env file in the repository root (do not commit your actual secrets; see Security below) with variables similar to:

ini
Copy
# RPC and wallet settings
PROVIDER_URL=https://your.rpc.url
MNEMONIC=your mnemonic phrase here

# Contract addresses (will be set during deployment)
ESCROW_CONTRACT=0xYourEscrowVaultAddress
WARP_PORTAL_ADDRESS=0xYourWarpPortalAddress
USDC_ADDRESS=0xUSDCContractAddress

# Oracle backend settings
WARP_API_URL=https://api.warp.example/status
PORT=3000
API_KEY=yourSecureApiKey
An .env.example file can be provided for guidance.

Deployment
Smart Contract
To compile and deploy the EscrowVault contract using Hardhat:

Install Dependencies:

bash
Copy
npm install
Compile the Contract:

bash
Copy
npx hardhat compile
Deploy the Contract:

bash
Copy
npx hardhat run scripts/deploy.js --network yourNetwork
Replace yourNetwork with the network defined in your Hardhat configuration (e.g., mainnet, sepolia).

Oracle Backend
To run the oracle backend service (for demonstration):

Install Dependencies:

bash
Copy
cd backend
npm install
Start the Service:

bash
Copy
npm start
The backend service will connect to your Ethereum network, listen for events, and provide a manual /poll endpoint for testing.

Security
Sensitive Data:
All sensitive data (such as mnemonics, private keys, and API keys) should be provided via environment variables, never hardcoded. Ensure your .env file is excluded from version control by adding it to .gitignore.

Best Practices:
This project uses OpenZeppelin libraries (Ownable, Pausable, ReentrancyGuard) to enhance security. Always review and test any changes before deploying to production.

Future Work
Oracle Integration:
Although not active in this release, the backend oracle code sets the foundation for future contracts that might rely on off‑chain message tracking and event-driven execution.

Enhanced Bridging & Messaging:
Consider further expansion of the bridging mechanism and more granular control over cross‑chain message payloads.

Extensive Testing & Audits:
Prior to production deployment, perform additional unit testing, integration testing, and, if possible, a formal security audit.

License
This project is licensed under the MIT License.