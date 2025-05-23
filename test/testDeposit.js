/**
 * testDeposit.js
 *
 * Demonstrates how to:
 *  1) Connect to a network (Base, etc.) using an RPC from .env
 *  2) Use a wallet from a mnemonic in .env
 *  3) Approve USDC to the EscrowVault
 *  4) Call depositPayment(...) with bridgingPuzzle, trustedPuzzle, destinationPuzzle,
 *     plus warp toll (ETH), matching the updated 8-parameter signature.
 */

require("dotenv").config(); // Read .env
const { ethers } = require("ethers");

// For ethers v6 utilities
const { parseUnits, id: ethersId, formatUnits, formatEther } = ethers;

async function main() {
    // === 1) LOAD ENVIRONMENT VARIABLES ===
    const RPC_URL = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
    const MNEMONIC = process.env.MNEMONIC || "test test test...";

    // Deployed contract addresses from .env or fallback
    const ESCROW_VAULT_ADDRESS = process.env.ESCROW_CONTRACT || "0xYourVault";
    const PORTAL_ADDRESS = process.env.WARP_PORTAL_ADDRESS || "0xPortal";
    const USDC_ADDRESS = process.env.USDC_ADDRESS || "0xSomeUsdc";

    // === 2) SET UP PROVIDER & SIGNER ===
    console.log("[testDeposit] => Connecting via mnemonic-derived wallet");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signer = ethers.Wallet.fromPhrase(MNEMONIC).connect(provider);
    const myAddress = await signer.getAddress();
    console.log(`Using signer address: ${myAddress}`);

    // === 3) CONTRACT ABIs & INSTANCES ===
    // The updated contract has an 8-argument depositPayment:
    // depositPayment(
    //   bytes32, bytes32, bytes32, bytes32, bytes32, uint256, uint256, bytes32
    // ) external payable
    const escrowVaultAbi = [
        "function depositPayment(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,bytes32) external payable"
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

    const escrowVault = new ethers.Contract(ESCROW_VAULT_ADDRESS, escrowVaultAbi, signer);
    const portal = new ethers.Contract(PORTAL_ADDRESS, portalAbi, signer);
    const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, signer);

    // === 4) HARDCODED TEST DATA ===
    // Example deposit of 0.01 USDC
    const depositUsdcAmountStr = "0.01";

    // We'll rename "nftId" => "collectionId"
    const collectionIdAscii = "collectionMainnetTest";
    const paymentIdAscii = "paymentMainnetTest10";

    // bridging/trusted/destination puzzle strings
    const bridgingPuzzleAscii = "xch1bridgingpuzzleabc123...";
    const trustedPuzzleAscii  = "xch1trustedpuzzlexyz999...";
    const destinationPuzzleAscii = "xch1destinationPuzzleDacStripe...";

    // "quantity" replaces dacCount
    const quantity = 2;
    // Must also supply an offerId param
    const offerIdAscii = "myOfferHash_999";

    // Helper to ensure 32-byte hex => otherwise hash with keccak256
    const convertIfNeeded = (str) => {
        if (str.startsWith("0x") && str.length === 66) {
            console.log(`[convertIfNeeded] => '${str}' is already 32-byte hex => no change`);
            return str;
        }
        // Otherwise, hash it => 32 bytes
        const hashed = ethersId(str);
        console.warn(`[convertIfNeeded] => hashed '${str}' => ${hashed}`);
        return hashed;
    };

    const collectionIdHex      = convertIfNeeded(collectionIdAscii);
    const paymentIdHex         = convertIfNeeded(paymentIdAscii);
    const bridgingPuzzleHex    = convertIfNeeded(bridgingPuzzleAscii);
    const trustedPuzzleHex     = convertIfNeeded(trustedPuzzleAscii);
    const destinationPuzzleHex = convertIfNeeded(destinationPuzzleAscii);
    const offerIdHex           = convertIfNeeded(offerIdAscii);

    // === 5) FETCH WARP TOLL & USDC DECIMALS ===
    const toll = await portal.messageToll();
    console.log(`Warp message toll in wei: ${toll.toString()}`);
    console.log(`Warp message toll in ETH: ${formatEther(toll)}`);

    const decimals = await usdc.decimals();
    const depositAmount = parseUnits(depositUsdcAmountStr, decimals);

    // === 6) CHECK BALANCE & ALLOWANCE
    const balance = await usdc.balanceOf(myAddress);
    console.log(`Current USDC balance: ${formatUnits(balance, decimals)}`);
    if (balance < depositAmount) {
        console.warn("Insufficient USDC balance to proceed.");
        return;
    }

    const allowance = await usdc.allowance(myAddress, ESCROW_VAULT_ADDRESS);
    console.log(`Current USDC allowance: ${formatUnits(allowance, decimals)}`);
    if (allowance < depositAmount) {
        console.log(`Approving ${depositUsdcAmountStr} USDC...`);
        const approveTx = await usdc.approve(ESCROW_VAULT_ADDRESS, depositAmount);
        console.log("Approve tx:", approveTx.hash);
        await approveTx.wait();
        console.log("USDC approved.");
    } else {
        console.log("Sufficient allowance => no approve needed");
    }

    // === 7) CALL depositPayment(...) with EIGHT args
    // depositPayment(
    //   bytes32 collectionId,
    //   bytes32 paymentId,
    //   bytes32 bridgingPuzzle,
    //   bytes32 trustedPuzzle,
    //   bytes32 destinationPuzzle,
    //   uint256 amountUSDC,
    //   uint256 quantity,
    //   bytes32 offerId
    // ) external payable
    console.log(`Calling depositPayment with depositAmount=${formatUnits(depositAmount, decimals)} USDC, quantity=${quantity}, toll=${formatEther(toll)} ETH...`);

    const tx = await escrowVault.depositPayment(
        collectionIdHex,
        paymentIdHex,
        bridgingPuzzleHex,
        trustedPuzzleHex,
        destinationPuzzleHex,
        depositAmount,
        quantity,
        offerIdHex,
        { value: toll }
    );

    console.log("DepositPayment tx sent:", tx.hash);
    const receipt = await tx.wait();
    console.info("✅ depositPayment confirmed:", receipt.transactionHash);

    console.log(`Test complete => bridgingPuzzle, trustedPuzzle, destinationPuzzle stored, warp message triggered.`);
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("Error in deposit script:", err);
        process.exit(1);
    });
