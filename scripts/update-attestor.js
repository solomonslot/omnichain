/* eslint-disable no-console */
/**
 * update-attestor.js
 *
 * Utility script to update the attestor of a deployed NftRedemption contract.
 *
 * It:
 *  - Connects to an RPC from .env or CLI
 *  - Uses an owner signer from MNEMONIC (index 0) or PRIVATE_KEY
 *  - Verifies ownership on-chain
 *  - Updates the attestor via setAttestor(newAddress)
 *
 * Usage examples:
 *   - Using env only:
 *       REDEMPTION_CONTRACT=0xYourRedemption \
 *       NEW_ATTESTOR=0xNewAttestor \
 *       npx hardhat run scripts/update-attestor.js --network baseMainnet
 *
 *   - With CLI overrides:
 *       npx hardhat run scripts/update-attestor.js --network baseMainnet \
 *         --contract 0xYourRedemption \
 *         --attestor 0xNewAttestor \
 *         --rpc https://mainnet.base.org \
 *         --path "m/44'/60'/0'/0/0"
 *
 * Env variables:
 *   - BASE_MAINNET_RPC_URL or RPC_URL: RPC endpoint (default https://mainnet.base.org)
 *   - MNEMONIC or PRIVATE_KEY: for owner signer (owner must equal on-chain owner)
 *   - REDEMPTION_CONTRACT: deployed NftRedemption address
 *   - NEW_ATTESTOR or REDEMPTION_ATTESTOR: new attestor address
 *
 * Notes:
 *   - Owner must hold enough native gas token to submit the transaction.
 *   - If current attestor already equals the new one, the script exits gracefully.
 */

"use strict";

require("dotenv").config();
const { ethers } = require("ethers");

// Minimal ABI for ownership and attestor management
const redemptionAbi = [
  "function owner() view returns (address)",
  "function attestor() view returns (address)",
  "function setAttestor(address newAttestor) external",
];

function parseArgs(argv) {
  const out = {};
  const arr = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > -1) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      out[k] = v;
    } else {
      const k = a.slice(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

function getEnvOrArg(args, envKeys, argKeys, fallback = "") {
  for (const k of argKeys) {
    if (args[k] != null && String(args[k]).trim() !== "") {
      return String(args[k]).trim();
    }
  }
  for (const k of envKeys) {
    if (process.env[k] != null && String(process.env[k]).trim() !== "") {
      return String(process.env[k]).trim();
    }
  }
  return fallback;
}

function requireAddress(label, value) {
  const v = String(value || "").trim();
  if (!ethers.isAddress(v)) {
    throw new Error(`${label} missing/invalid. Got: ${v || "(empty)"}`);
  }
  return ethers.getAddress(v);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve settings from CLI or env
  const RPC_URL = getEnvOrArg(
    args,
    ["BASE_MAINNET_RPC_URL", "RPC_URL"],
    ["rpc"],
    "https://mainnet.base.org"
  );
  const CONTRACT_ADDR = getEnvOrArg(
    args,
    ["REDEMPTION_CONTRACT"],
    ["contract"]
  );
  const NEW_ATTESTOR_RAW = getEnvOrArg(
    args,
    ["NEW_ATTESTOR", "REDEMPTION_ATTESTOR"],
    ["attestor"]
  );
  const NEW_ATTESTOR_PK_RAW = getEnvOrArg(
    args,
    ["NEW_ATTESTOR_PRIVATE_KEY", "NEW_ATTESTOR_PK", "ATTESTOR_PRIVATE_KEY"],
    ["attestor_pk", "attestor-pk"]
  );
  const DERIVATION_PATH = getEnvOrArg(args, [], ["path"], "m/44'/60'/0'/0/0");
  const DRY_RUN = /^true$/i.test(
    String(getEnvOrArg(args, [], ["dry", "dryrun"], "false"))
  );
  const VERIFY_ONLY = /^true$/i.test(
    String(getEnvOrArg(args, [], ["verify", "verify-only", "check"], "false"))
  );
  const EXPECTED_CHAIN_ID = Number(
    getEnvOrArg(
      args,
      ["CHAIN_ID", "EXPECTED_CHAIN_ID"],
      ["chain-id", "chainid"],
      "8453"
    )
  );

  // Provider
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);
  if (EXPECTED_CHAIN_ID && actualChainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `ChainId mismatch. Connected chainId=${actualChainId}, expected=${EXPECTED_CHAIN_ID}. Use --chain-id or correct RPC_URL.`
    );
  }

  // Determine new attestor address (prefer PK if provided)
  let newAttestor;
  if (NEW_ATTESTOR_PK_RAW) {
    const wa = new ethers.Wallet(NEW_ATTESTOR_PK_RAW);
    newAttestor = ethers.getAddress(wa.address);
    if (
      NEW_ATTESTOR_RAW &&
      ethers.getAddress(NEW_ATTESTOR_RAW) !== newAttestor
    ) {
      throw new Error(
        `Provided --attestor (${ethers.getAddress(
          NEW_ATTESTOR_RAW
        )}) does not match address derived from --attestor-pk (${newAttestor}).`
      );
    }
  } else {
    if (!NEW_ATTESTOR_RAW)
      throw new Error(
        "NEW_ATTESTOR/REDEMPTION_ATTESTOR/--attestor is required (or provide --attestor-pk)"
      );
    newAttestor = requireAddress("NEW_ATTESTOR/--attestor", NEW_ATTESTOR_RAW);
  }

  // Optional owner signer (not required for verify-only)
  const MNEMONIC = (process.env.MNEMONIC || "").trim();
  const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
  let signer;
  let signerAddr = "(verify-only)";
  if (!VERIFY_ONLY) {
    if (!MNEMONIC && !PRIVATE_KEY) {
      throw new Error(
        "Provide MNEMONIC or PRIVATE_KEY for the owner signer (or use --verify for read-only checks)"
      );
    }
    if (MNEMONIC) {
      signer = ethers.Wallet.fromPhrase(MNEMONIC, DERIVATION_PATH).connect(
        provider
      );
    } else {
      signer = new ethers.Wallet(PRIVATE_KEY, provider);
    }
    signerAddr = await signer.getAddress();
  }

  const redemptionAddress = requireAddress(
    "REDEMPTION_CONTRACT/--contract",
    CONTRACT_ADDR
  );

  console.log("== Update NftRedemption Attestor ==");
  console.log(
    "Network:",
    network.name || "(unknown)",
    "chainId=",
    network.chainId.toString(),
    "expected=",
    String(EXPECTED_CHAIN_ID)
  );
  console.log("Redemption contract:", redemptionAddress);
  console.log("Signer (intended owner):", signerAddr);
  console.log("Requested new attestor:", newAttestor);
  console.log(
    "Mode:",
    VERIFY_ONLY ? "verify-only" : DRY_RUN ? "dry-run" : "execute"
  );
  console.log("");

  // Read current owner and attestor
  const redemptionRead = new ethers.Contract(
    redemptionAddress,
    redemptionAbi,
    provider
  );
  const currentOwner = await redemptionRead.owner();
  const currentAttestor = await redemptionRead.attestor();

  console.log("On-chain owner:", currentOwner);
  console.log("On-chain attestor:", currentAttestor);

  if (VERIFY_ONLY) {
    console.log(
      ethers.getAddress(currentAttestor) === ethers.getAddress(newAttestor)
        ? "Attestor already set to requested address."
        : "Attestor differs and would be updated."
    );
    return;
  }

  if (ethers.getAddress(signerAddr) !== ethers.getAddress(currentOwner)) {
    throw new Error(
      `Signer is not the contract owner. Expected ${currentOwner}, got ${signerAddr}. ` +
        `Use the correct owner signer (mnemonic index 0 by default) or update DERIVATION_PATH/PRIVATE_KEY.`
    );
  }

  if (ethers.getAddress(currentAttestor) === ethers.getAddress(newAttestor)) {
    console.log("New attestor equals current attestor; nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.log("[dry-run] Would call setAttestor(", newAttestor, ")");
    return;
  }

  // Submit tx
  const redemptionOwner = new ethers.Contract(
    redemptionAddress,
    redemptionAbi,
    signer
  );
  console.log("Calling setAttestor(...), please wait...");
  const tx = await redemptionOwner.setAttestor(newAttestor);
  console.log("setAttestor tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("✅ setAttestor confirmed in block:", rcpt.blockNumber);

  // Re-read and assert
  const updatedAttestor = await redemptionRead.attestor();
  console.log("Updated attestor:", updatedAttestor);
  if (ethers.getAddress(updatedAttestor) !== ethers.getAddress(newAttestor)) {
    throw new Error(
      `Post-condition failed: on-chain attestor ${updatedAttestor} != requested ${newAttestor}`
    );
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("update-attestor failed:", err);
  process.exit(1);
});
