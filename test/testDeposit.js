/**
 * testDeposit.js
 *
 * Demonstrates how to:
 *  1) Connect to a network (Base, Sepolia, etc.) using an RPC from .env
 *  2) Use a wallet from a mnemonic in .env
 *  3) Approve USDC to the EscrowVault
 *  4) Call depositPayment() with a Warp Portal toll (ETH)
 */

require("dotenv").config(); // Read .env
const { ethers } = require("ethers");

// For ethers v6 utilities
const { parseUnits, id: ethersId, formatUnits, formatEther } = ethers;

async function main() {
    // === 1) LOAD ENVIRONMENT VARIABLES ===
    // If not found, fallback to placeholders
    const RPC_URL = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
    const MNEMONIC = process.env.MNEMONIC || "test test test...";

    // Deployed contract addresses (loaded from .env or fallback)
    const ESCROW_VAULT_ADDRESS = process.env.ESCROW_CONTRACT || "0xD9CA8Ca9375C011054a07dc947261EBa9fe3709e";
    const PORTAL_ADDRESS = process.env.WARP_PORTAL_ADDRESS || "0x382bd36d1dE6Fe0a3D9943004D3ca5Ee389627EE";
    const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    // === 2) SET UP PROVIDER & SIGNER ===
    console.log("[testDeposit] => Connecting via mnemonic-derived wallet");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signer = ethers.Wallet.fromPhrase(MNEMONIC).connect(provider);
    const myAddress = await signer.getAddress();
    console.log(`Using signer address: ${myAddress}`);

    // === 3) CONTRACT ABIs & INSTANCES ===
    // Minimal ABIs just for the functions we call:
    const escrowVaultAbi = [
        // Must match your contract's depositPayment signature that takes 5 params + payable
        "function depositPayment(bytes32 nftId, bytes32 paymentId, bytes32 chiaPuzzleHash, uint256 amountUSDC, uint256 dacCount) external payable"
    ];
    const portalAbi = [
        "function messageToll() view returns (uint256)",
        "function sendMessage(bytes3 destinationChain, bytes32 destination, bytes32[] contents) external payable"
    ];
    const erc20Abi = [
        "function approve(address spender, uint256 amount) public returns (bool)",
        "function balanceOf(address owner) view returns (uint256)",
        "function allowance(address owner, address spender) view returns (uint256)",
        "function decimals() view returns (uint8)"
    ];

    // Instantiate contracts
    const escrowVault = new ethers.Contract(ESCROW_VAULT_ADDRESS, escrowVaultAbi, signer);
    const portal = new ethers.Contract(PORTAL_ADDRESS, portalAbi, signer);
    const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, signer);

    // === 4) HARDCODED TEST DATA ===
    // You can push these into .env if you prefer
    const depositUsdcAmountStr = "0.01";         // user wants to deposit 0.01 USDC
    const nftIdAscii = "nftMainnetTest";         // ASCII or hex
    const paymentIdAscii = "paymentMainnetTest7"; // unique PaymentID
    const vaultPuzzleHashAscii = "xch1synxvefpfjmhkejxuzp4z98rnumgpavz24lel5swxmmupyaj9zxqrur33g";
    const dacCount = 1; // example integer

    // Helper to ensure we have 32-byte hex for the arguments
    const convertIfNeeded = (str) => {
        if (str.startsWith("0x") && str.length === 66) {
            console.log(`[convertIfNeeded] => '${str}' is already 32-byte hex => no change`);
            return str;
        }
        // Otherwise, hash it to get 32 bytes
        const hashed = ethersId(str);
        console.warn(`[convertIfNeeded] => hashed '${str}' => ${hashed}`);
        return hashed;
    };

    const nftIdHex = convertIfNeeded(nftIdAscii);
    const paymentIdHex = convertIfNeeded(paymentIdAscii);
    const puzzleHashHex = convertIfNeeded(vaultPuzzleHashAscii);

    console.log("NFT ID (bytes32):", nftIdHex);
    console.log("Payment ID (bytes32):", paymentIdHex);
    console.log("Puzzle Hash (bytes32):", puzzleHashHex);

    // === 5) FETCH WARP TOLL & USDC DECIMALS ===
    const toll = await portal.messageToll();
    console.log(`Warp message toll in wei: ${toll.toString()}`);
    console.log(`Warp message toll in ETH: ${formatEther(toll)} ETH`);

    const decimals = await usdc.decimals();
    const depositAmount = parseUnits(depositUsdcAmountStr, decimals);

    // === 6) CHECK BALANCE & ALLOWANCE ===
    const balance = await usdc.balanceOf(myAddress);
    console.log(`Current USDC balance: ${formatUnits(balance, decimals)}`);
    if (balance < depositAmount) {
        console.warn("Insufficient USDC balance to proceed with deposit.");
        return;
    }

    const allowance = await usdc.allowance(myAddress, ESCROW_VAULT_ADDRESS);
    console.log(`Current USDC allowance for EscrowVault: ${formatUnits(allowance, decimals)}`);
    if (allowance < depositAmount) {
        console.log(`Approving ${depositUsdcAmountStr} USDC to EscrowVault...`);
        const approveTx = await usdc.approve(ESCROW_VAULT_ADDRESS, depositAmount);
        console.log("Approve transaction hash:", approveTx.hash);
        await approveTx.wait();
        console.log("USDC approve confirmed:", approveTx.hash);
    } else {
        console.log("Sufficient allowance exists; skipping approval.");
    }

    // === 7) CALL depositPayment(...) ===
    // Must send exactly `toll` in ETH for Warp
    console.log(
        `Calling depositPayment with depositAmount=${formatUnits(depositAmount, decimals)} USDC, toll=${formatEther(toll)} ETH...`
    );

    const tx = await escrowVault.depositPayment(
        nftIdHex,
        paymentIdHex,
        puzzleHashHex,
        depositAmount,
        dacCount,
        {
            value: toll,
            // gasLimit: 500000 // optional override
        }
    );

    console.log("DepositPayment transaction sent:", tx.hash);
    const receipt = await tx.wait();
    console.info("✅ depositPayment confirmed! TX hash:", receipt.transactionHash);

    console.log(`Test complete: ${depositUsdcAmountStr} USDC deposited, warp message triggered.`);
}

// Standard pattern to handle async errors
main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("Error in deposit script:", err);
        process.exit(1);
    });
