/* eslint-disable no-console */
/**
 * Derive multiple EVM accounts (addresses + private keys) from a single BIP-39 mnemonic.
 *
 * Env:
 * - MNEMONIC          (required) 12/24-word phrase from your .env (reused from EscrowVault)
 * - DERIVE_COUNT      (optional) how many accounts to derive, default: 5
 * - DERIVE_OFFSET     (optional) starting index, default: 0
 * - DERIVE_PATH       (optional) base derivation path, default: "m/44'/60'/0'/0"
 *
 * Example:
 *   MNEMONIC="word1 word2 ... word12" \
 *   DERIVE_COUNT=3 \
 *   node scripts/derive-from-mnemonic.js
 *
 * Output format per line:
 *   <index> <address> <privateKey>
 *
 * Recommended role mapping (by index):
 *   0 = Deployer
 *   1 = Attestor (oracle signer)
 *   2 = Claimant (tx sender)
 */

"use strict";

require("dotenv").config();

const { HDNodeWallet } = require("ethers");

const MNEMONIC = (process.env.MNEMONIC || "").trim();
const COUNT = Number(process.env.DERIVE_COUNT || 5);
const OFFSET = Number(process.env.DERIVE_OFFSET || 0);
const BASE_PATH = (process.env.DERIVE_PATH || "m/44'/60'/0'/0").trim();

if (!MNEMONIC) {
  console.error("Error: MNEMONIC missing from environment.");
  process.exit(1);
}
if (!Number.isFinite(COUNT) || COUNT <= 0) {
  console.error("Error: DERIVE_COUNT must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(OFFSET) || OFFSET < 0) {
  console.error("Error: DERIVE_OFFSET must be a non-negative integer.");
  process.exit(1);
}
if (!/^m\/44'\/60'\/\d+'\/\d+$/.test(BASE_PATH)) {
  console.warn(
    `Warning: DERIVE_PATH="${BASE_PATH}" is non-standard. The common path is m/44'/60'/0'/0`
  );
}

try {
  // Validate mnemonic; wallets will be derived per-index below
  HDNodeWallet.fromPhrase(MNEMONIC);
} catch (e) {
  console.error("Error: Failed to parse MNEMONIC:", e.message || e);
  process.exit(1);
}

// Print a brief header for clarity
console.log(`# basePath=${BASE_PATH} offset=${OFFSET} count=${COUNT}`);
console.log(`# roles (suggested): 0=Deployer, 1=Attestor, 2=Claimant`);

for (let i = 0; i < COUNT; i++) {
  const idx = OFFSET + i;
  const path = `${BASE_PATH}/${idx}`;
  const child = HDNodeWallet.fromPhrase(MNEMONIC, undefined, path);
  // Output: index address privateKey
  console.log(idx, child.address, child.privateKey);
}
