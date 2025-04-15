require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { WebSocketProvider, Wallet, Contract } = require('ethers');

// 1) Environment
const {
    PROVIDER_URL,       // e.g. wss://mainnet.base.org
    PRIVATE_KEY,
    MNEMONIC,
    ESCROW_CONTRACT,    // deployed EscrowVault
    WARP_PORTAL,        // address of the WarpPortal contract
    WARP_API_URL,
    PORT
} = process.env;

/**
 * ESCROW_ABI: to listen for PaymentEscrowed + call confirmMessageReceived.
 *   - PaymentEscrowed(buyer, paymentId, amountUSDC, userPuzzleHash, nftId, dacCount, warpNonce)
 *   - confirmMessageReceived(paymentId, warpTxHash)
 *   - escrows(paymentId) -> returns the escrow record
 */
const escrowAbi = [
    "event PaymentEscrowed(address indexed buyer, bytes32 indexed paymentId, uint256 amountUSDC, bytes32 userPuzzleHash, bytes32 nftId, uint256 dacCount, bytes32 warpNonce)",
    "function confirmMessageReceived(bytes32 paymentId, string calldata warpTxHash) external",
    "function escrows(bytes32) view returns (address buyer, uint256 amountUSDC, bytes32 userPuzzleHash, bytes32 nftId, uint256 dacCount, bool completed, bytes32 warpNonce)"
];

/**
 * PORTAL_ABI: needed for MessageSent event
 *   event MessageSent(
 *       bytes32 indexed nonce,
 *       address indexed sender,
 *       bytes3 indexed destinationChain,
 *       bytes32 destination,
 *       bytes32[] contents
 *   );
 *
 * We only need the event signature here for logs:
 */
const portalAbi = [
    "event MessageSent(bytes32 indexed nonce, address indexed sender, bytes3 indexed destinationChain, bytes32 destination, bytes32[] contents)"
];

/**
 * Helper: convert the WarpPortal's 0xNN... to a 64-char string w/o '0x'
 */
function toWarpNonceHexString(bytes32Hex) {
    if (!bytes32Hex?.startsWith("0x")) {
        return bytes32Hex || "";
    }
    let raw = bytes32Hex.slice(2).toLowerCase();
    return raw.padStart(64, '0');
}

// We'll store the last block we've scanned for each contract separately:
const ESCROW_BLOCK_FILE = path.join(__dirname, "lastEscrowBlock.json");
const PORTAL_BLOCK_FILE = path.join(__dirname, "lastPortalBlock.json");

// Load or save a JSON { lastBlock: number } to track scanning progress
function loadLastBlock(filePath) {
    try {
        const data = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(data);
        return parsed.lastBlock || 0;
    } catch {
        return 0;
    }
}
function saveLastBlock(filePath, blockNumber) {
    fs.writeFileSync(filePath, JSON.stringify({ lastBlock: blockNumber }), "utf8");
    console.log(`Saved lastBlock=${blockNumber} to ${filePath}`);
}

/**
 * We'll keep:
 * - pendingPaymentIds: a set of all paymentIds that are not completed
 * - paymentIdToNonce: map from paymentId -> real warp nonce from the Portal
 */
const pendingPaymentIds = new Set();
const paymentIdToNonce = {};

/**
 * Catch up on missed PaymentEscrowed events from the EscrowVault
 */
async function loadMissedEscrows(escrowContract, fromBlock, toBlock) {
    console.log(`Loading PaymentEscrowed from blocks ${fromBlock}..${toBlock}`);
    const logs = await escrowContract.queryFilter(
        escrowContract.filters.PaymentEscrowed(),
        fromBlock,
        toBlock
    );
    console.log(`Found ${logs.length} PaymentEscrowed events in that range.`);

    for (const evt of logs) {
        const { paymentId } = evt.args;
        // Check if escrow is completed
        const escrowData = await escrowContract.escrows(paymentId);
        if (!escrowData.completed) {
            // Not completed => we want to track it
            pendingPaymentIds.add(paymentId);
            console.log(` Escrow pending => paymentId=${paymentId}`);
        }
    }
}

/**
 * Catch up on missed MessageSent from the WarpPortal
 * We'll look at contents[2] to see if it matches any known paymentId
 */
async function loadMissedPortalMessages(portalContract, fromBlock, toBlock) {
    console.log(`Loading MessageSent from blocks ${fromBlock}..${toBlock}`);
    const logs = await portalContract.queryFilter(
        portalContract.filters.MessageSent(),
        fromBlock,
        toBlock
    );
    console.log(`Found ${logs.length} MessageSent events in that range.`);

    for (const evt of logs) {
        const { nonce, sender, destinationChain, destination, contents } = evt.args;
        // The depositPayment() used contents[2] = paymentId
        const maybePaymentId = contents?.[2];
        if (!maybePaymentId) continue;

        if (pendingPaymentIds.has(maybePaymentId)) {
            const realNonce = toWarpNonceHexString(nonce);
            paymentIdToNonce[maybePaymentId] = realNonce;
            console.log(` Found matching paymentId=${maybePaymentId}, realNonce=${realNonce}`);
        }
    }
}

async function main() {
    const provider = new WebSocketProvider(PROVIDER_URL);

    let signer;
    if (MNEMONIC) {
        signer = Wallet.fromPhrase(MNEMONIC).connect(provider);
    } else if (PRIVATE_KEY) {
        signer = new Wallet(PRIVATE_KEY, provider);
    } else {
        throw new Error("No MNEMONIC or PRIVATE_KEY provided.");
    }
    const oracleAddr = await signer.getAddress();
    console.log("Oracle address:", oracleAddr);

    // Connect to your contracts
    const escrowContract = new Contract(ESCROW_CONTRACT, escrowAbi, signer);
    const portalContract = new Contract(WARP_PORTAL, portalAbi, signer);

    // 1) On startup, we do a catch-up:
    const currentBlock = await provider.getBlockNumber();

    // 1a) EscrowVault: PaymentEscrowed
    const escrowLastBlock = loadLastBlock(ESCROW_BLOCK_FILE);
    if (escrowLastBlock < currentBlock) {
        await loadMissedEscrows(escrowContract, escrowLastBlock, currentBlock);
        saveLastBlock(ESCROW_BLOCK_FILE, currentBlock);
    }

    // 1b) WarpPortal: MessageSent
    const portalLastBlock = loadLastBlock(PORTAL_BLOCK_FILE);
    if (portalLastBlock < currentBlock) {
        await loadMissedPortalMessages(portalContract, portalLastBlock, currentBlock);
        saveLastBlock(PORTAL_BLOCK_FILE, currentBlock);
    }

    // 2) Now set up real-time event listeners

    // 2a) PaymentEscrowed from EscrowVault
    escrowContract.on("PaymentEscrowed", async (buyer, paymentId, amountUSDC, userPuzzleHash, nftId, dacCount, warpNonce, evt) => {
        console.log(`PaymentEscrowed @ block=${evt.blockNumber}, paymentId=${paymentId}`);
        // Check if completed
        const escrowData = await escrowContract.escrows(paymentId);
        if (!escrowData.completed) {
            pendingPaymentIds.add(paymentId);
            console.log(` -> added paymentId=${paymentId} to pending.`);
        }

        // update last block
        saveLastBlock(ESCROW_BLOCK_FILE, evt.blockNumber);
    });

    // 2b) MessageSent from WarpPortal
    portalContract.on("MessageSent", async (nonce, sender, destChain, destination, contents, evt) => {
        console.log(`MessageSent @ block=${evt.blockNumber}, nonce=${nonce}`);
        // see if contents[2] is a paymentId we know
        const maybePaymentId = contents?.[2];
        if (pendingPaymentIds.has(maybePaymentId)) {
            const realNonce = toWarpNonceHexString(nonce);
            paymentIdToNonce[maybePaymentId] = realNonce;
            console.log(` -> matched paymentId=${maybePaymentId}, realNonce=${realNonce}`);
        }

        saveLastBlock(PORTAL_BLOCK_FILE, evt.blockNumber);
    });

    // 3) Automatic polling of the Warp watcher
    async function pollPendingEscrows() {
        if (pendingPaymentIds.size === 0) {
            console.log("[AutoPoll] No pending escrows at this time.");
            return;
        }

        for (const pid of Array.from(pendingPaymentIds)) {
            const realNonce = paymentIdToNonce[pid];
            if (!realNonce) {
                console.log(`[AutoPoll] paymentId=${pid} => haven't seen MessageSent yet. Skipping.`);
                continue;
            }
            // We have the actual warp nonce, let's check the status
            const url = `${WARP_API_URL}?nonce=${realNonce}`;
            console.log(`[AutoPoll] Checking status for paymentId=${pid}, nonce=${realNonce}: ${url}`);
            try {
                const resp = await axios.get(url);
                const data = resp.data;
                if (!Array.isArray(data) || data.length === 0) {
                    console.log(`[AutoPoll] No message found for nonce=${realNonce}`);
                    continue;
                }
                const msg = data[0];
                const status = msg.status;
                console.log(`[AutoPoll] Warp status=${status} for nonce=${realNonce}`);
                if (status === "received") {
                    // confirm on chain
                    const warpTxHash = msg.destination_transaction_hash || "unknown";
                    console.log(`[AutoPoll] Confirming escrow for paymentId=${pid}, warpTxHash=${warpTxHash}`);
                    const tx = await escrowContract.confirmMessageReceived(pid, warpTxHash);
                    console.log(`[AutoPoll] Tx sent: ${tx.hash}`);
                    const receipt = await tx.wait();
                    console.log(`[AutoPoll] Tx confirmed: ${receipt.transactionHash}`);
                    pendingPaymentIds.delete(pid);
                    delete paymentIdToNonce[pid];
                }
            } catch (err) {
                console.log(`[AutoPoll] Error polling warp for paymentId=${pid}: ${err.message}`);
            }
        }
    }
    setInterval(pollPendingEscrows, 30_000);

    // 4) HTTP endpoint for manual checks
    const app = express();
    app.use(express.json());

    app.post('/poll', async (req, res) => {
        try {
            const { paymentId } = req.body;
            if (!paymentId) {
                return res.status(400).json({ error: "Missing paymentId" });
            }
            const realNonce = paymentIdToNonce[paymentId];
            if (!realNonce) {
                return res.status(400).json({
                    error: `Haven't seen real nonce for paymentId=${paymentId} yet.`
                });
            }
            // check the warp status
            const url = `${WARP_API_URL}?nonce=${realNonce}`;
            console.log(`[ManualPoll] Checking warp status for paymentId=${paymentId}, nonce=${realNonce}`);
            const resp = await axios.get(url);
            const data = resp.data;
            if (!Array.isArray(data) || data.length === 0) {
                return res.json({ message: "No messages found for that nonce" });
            }
            const msg = data[0];
            const status = msg.status;
            if (status !== 'received') {
                return res.json({ message: `Message not 'received'; status=${status}` });
            }
            const warpTxHash = msg.destination_transaction_hash || "unknown";
            console.log(`[ManualPoll] Confirming escrow for paymentId=${paymentId} warpTxHash=${warpTxHash}`);
            const tx = await escrowContract.confirmMessageReceived(paymentId, warpTxHash);
            const receipt = await tx.wait();
            return res.json({ message: "Confirmed", txHash: receipt.transactionHash });
        } catch (err) {
            console.error("[ManualPoll] Error:", err);
            return res.status(500).json({ error: err.message });
        }
    });

    const port = PORT || 3000;
    app.listen(port, () => {
        console.log(`Oracle backend running on port ${port}`);
    });
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
