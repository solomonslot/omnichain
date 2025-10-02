/* eslint-disable no-console */
/**
 * Self-contained dummy claim script for NftRedemption:
 * - No MintGarden or backend required.
 * - Creates a tiny claim (default: 10 base units => 0.00001 with 6 decimals).
 * - Signs the EIP-712 claim with the attestor key and submits from claimant.
 *
 * Env:
 * - BASE_MAINNET_RPC_URL: RPC URL (default https://mainnet.base.org)
 * - REDEMPTION_CONTRACT:  NftRedemption address (required)
 * - ATTESTOR_PRIVATE_KEY: Attestor PK (required, index 1 from derive)
 * - CLAIMANT_PRIVATE_KEY: Claimant PK (required, index 2 from derive)
 * - PAYOUT_ADDRESS:       Optional override; defaults to claimant address
 * - REWARD_TOKEN_DECIMALS:Decimals (default 6, USDC-like)
 * - TOTAL_REWARD_UNITS:   Payout base units (default "10" => 0.00001 for 6 decimals)
 * - POOL_ID:              0x bytes32 hex OR
 * - POOL_ID_TEXT:         free text hashed to bytes32 (default "DUMMY_POOL")
 * - BLS_PUBKEY_HEX48:     48-byte hex (0x + 96 hex; default is a dummy)
 * - NFT_DUMMY_COUNT:      Number of dummy NFTs (default "1")
 * - DUMMY_NFT_SEED:       Seed string for dummy IDs (default "dummy-nft")
 *
 * Usage:
 *   node scripts/test-redeem-claim-dummy.js
 */

require("dotenv").config();

const {
  JsonRpcProvider,
  Wallet,
  Contract,
  getAddress,
  keccak256,
  toUtf8Bytes,
  hexlify,
  randomBytes,
} = require("ethers");

// -------------------- Env --------------------
const RPC_URL = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const REDEMPTION_CONTRACT = process.env.REDEMPTION_CONTRACT || "";
const MNEMONIC = (process.env.MNEMONIC || "").trim();
const PAYOUT_ADDRESS_ENV = process.env.PAYOUT_ADDRESS || "";
const TOKEN_DECIMALS = Number(process.env.REWARD_TOKEN_DECIMALS || "6");
const TOTAL_REWARD_UNITS_ENV = process.env.TOTAL_REWARD_UNITS || "10"; // 10 units => 0.00001 at 6 decimals
const POOL_ID_HEX = process.env.POOL_ID || "";
const POOL_ID_TEXT = process.env.POOL_ID_TEXT || "DUMMY_POOL";
const BLS_PUBKEY_HEX48_RAW = (process.env.BLS_PUBKEY_HEX48 || "").trim();
const BLS_PUBKEY_HEX48 = BLS_PUBKEY_HEX48_RAW
  ? BLS_PUBKEY_HEX48_RAW.startsWith("0x") ||
    BLS_PUBKEY_HEX48_RAW.startsWith("0X")
    ? "0x" + BLS_PUBKEY_HEX48_RAW.slice(2).toLowerCase()
    : "0x" + BLS_PUBKEY_HEX48_RAW.toLowerCase()
  : "0x" + "11".repeat(48); // 48 bytes => 96 hex chars

const NFT_DUMMY_COUNT = Math.max(1, Number(process.env.NFT_DUMMY_COUNT || "1"));
const DUMMY_NFT_SEED = process.env.DUMMY_NFT_SEED || "dummy-nft";

// ----------------- ABI (subset) --------------
const redemptionAbi = [
  "function nftRedeemed(bytes32) view returns (bool)",
  "function claimReward(bytes32,address,bytes,bytes32,bytes32,uint256,uint256,uint64,bytes32,bytes32[],bytes) external",
  "function attestor() view returns (address)",
  "function owner() view returns (address)",
  "function setAttestor(address) external",
];

// ----------------- Helpers -------------------
function isBytes32Hex(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}
function ensureBytes32Hex(input) {
  if (isBytes32Hex(input)) return "0x" + input.slice(2).toLowerCase();
  const s = String(input || "").trim();
  return keccak256(toUtf8Bytes(s));
}
function idStringToBytes32(id) {
  const lower = String(id || "")
    .trim()
    .toLowerCase();
  return keccak256(toUtf8Bytes(lower));
}
function hashNftListLowerHexWithNewlines(bytes32List) {
  const joined = bytes32List
    .map((h) => String(h).slice(2).toLowerCase())
    .join("\n");
  return keccak256(toUtf8Bytes(joined));
}
function buildPricingHash(id32List, perUnits) {
  const lines = id32List.map(
    (id32, i) => `${id32.slice(2).toLowerCase()}:${perUnits[i].toString()}`
  );
  return keccak256(toUtf8Bytes(lines.join("\n")));
}
function ensure48ByteHex(hex) {
  const clean = String(hex || "").trim();
  const body =
    clean.startsWith("0x") || clean.startsWith("0X") ? clean.slice(2) : clean;
  if (!/^[0-9a-fA-F]{96}$/.test(body)) {
    throw new Error(
      `BLS_PUBKEY_HEX48 must be 48 bytes (0x + 96 hex chars). Got length=${body.length} (without 0x).`
    );
  }
  return "0x" + body.toLowerCase();
}

async function main() {
  if (!REDEMPTION_CONTRACT) throw new Error("REDEMPTION_CONTRACT is required");
  if (!MNEMONIC) throw new Error("MNEMONIC is required");

  const totalReward = BigInt(TOTAL_REWARD_UNITS_ENV);
  if (totalReward <= 0n) throw new Error("TOTAL_REWARD_UNITS must be > 0");

  const provider = new JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  const attestorPath = "m/44'/60'/0'/0/1";
  const claimantPath = "m/44'/60'/0'/0/2";
  const ownerPath = "m/44'/60'/0'/0/0";
  const attestor = Wallet.fromPhrase(MNEMONIC, attestorPath).connect(provider);
  const claimant = Wallet.fromPhrase(MNEMONIC, claimantPath).connect(provider);
  const owner = Wallet.fromPhrase(MNEMONIC, ownerPath).connect(provider);

  // Ensure on-chain attestor matches mnemonic-derived index-1; auto-update if owner (index-0) controls the contract
  const redemptionRead = new Contract(
    REDEMPTION_CONTRACT,
    redemptionAbi,
    provider
  );
  const onchainAttestor = (await redemptionRead.attestor()).toLowerCase();
  const onchainOwner = (await redemptionRead.owner()).toLowerCase();
  const derivedAttestor = attestor.address.toLowerCase();
  const derivedOwner = owner.address.toLowerCase();
  if (onchainAttestor !== derivedAttestor) {
    if (onchainOwner === derivedOwner) {
      console.log(
        "Attestor mismatch on-chain; updating via owner to:",
        attestor.address
      );
      const redemptionOwner = new Contract(
        REDEMPTION_CONTRACT,
        redemptionAbi,
        owner
      );
      const txSet = await redemptionOwner.setAttestor(attestor.address);
      console.log("setAttestor tx:", txSet.hash);
      await txSet.wait();
      console.log("setAttestor confirmed.");
    } else {
      throw new Error(
        `On-chain attestor ${onchainAttestor} != derived attestor ${derivedAttestor}, and owner ${onchainOwner} != derived owner ${derivedOwner}. Update attestor on-chain or use the correct mnemonic.`
      );
    }
  }
  const payoutAddress = PAYOUT_ADDRESS_ENV
    ? getAddress(PAYOUT_ADDRESS_ENV)
    : await claimant.getAddress();

  // Domain (must match contract EIP-712)
  const domain = {
    name: "Solslot-Redemption",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: REDEMPTION_CONTRACT,
  };
  const types = {
    RedemptionClaim: [
      { name: "poolId", type: "bytes32" },
      { name: "evmAddress", type: "address" },
      { name: "blsPubkey", type: "bytes" },
      { name: "nftSetHash", type: "bytes32" },
      { name: "pricingHash", type: "bytes32" },
      { name: "nftCount", type: "uint256" },
      { name: "totalReward", type: "uint256" },
      { name: "issuedAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  // Dummy NFT ids (just strings hashed to bytes32)
  const dummyIds = [];
  for (let i = 0; i < NFT_DUMMY_COUNT; i++) {
    dummyIds.push(`${DUMMY_NFT_SEED}-${i}`);
  }
  let nftIdsBytes32 = dummyIds.map(idStringToBytes32);
  // Sort strictly ascending (string compare is fine for hex)
  nftIdsBytes32.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const nftSetHash = hashNftListLowerHexWithNewlines(nftIdsBytes32);

  // Per-NFT amounts: split tiny total across all; put remainder on last
  const perUnits = [];
  if (NFT_DUMMY_COUNT === 1) {
    perUnits.push(totalReward);
  } else {
    const base = totalReward / BigInt(NFT_DUMMY_COUNT);
    let running = 0n;
    for (let i = 0; i < NFT_DUMMY_COUNT; i++) {
      if (i === NFT_DUMMY_COUNT - 1) {
        perUnits.push(totalReward - running); // remainder
      } else {
        perUnits.push(base);
        running += base;
      }
    }
  }
  const pricingHash = buildPricingHash(nftIdsBytes32, perUnits);
  const blsPubkey = ensure48ByteHex(BLS_PUBKEY_HEX48);

  // Pool id
  const poolId = POOL_ID_HEX
    ? ensureBytes32Hex(POOL_ID_HEX)
    : ensureBytes32Hex(POOL_ID_TEXT);
  const message = {
    poolId,
    evmAddress: payoutAddress,
    blsPubkey,
    nftSetHash,
    pricingHash,
    nftCount: BigInt(nftIdsBytes32.length),
    totalReward,
    issuedAt: BigInt(Math.floor(Date.now() / 1000)),
    nonce: hexlify(randomBytes(32)),
  };

  // Sign with attestor
  const attestation = await attestor.signTypedData(domain, types, message);

  // Submit with claimant
  const redemption = new Contract(REDEMPTION_CONTRACT, redemptionAbi, claimant);

  // Preflight: warn if already redeemed (first id)
  const already = await redemption.nftRedeemed(nftIdsBytes32[0]);
  if (already) {
    console.warn("Warning: first dummy NFT already redeemed; tx may revert.");
  }

  console.log("== Dummy claim ==");
  console.log(
    "Network:",
    network.name || "(unknown)",
    "chainId=",
    String(network.chainId)
  );
  console.log("Contract:", REDEMPTION_CONTRACT);
  console.log("Payout address:", payoutAddress);
  console.log("Token decimals:", TOKEN_DECIMALS);
  console.log("Dummy NFT count:", NFT_DUMMY_COUNT);
  console.log("Total reward (base units):", totalReward.toString());
  console.log("First NFT id32:", nftIdsBytes32[0]);
  console.log("nftSetHash:", nftSetHash);
  console.log("pricingHash:", pricingHash);
  console.log("attestation:", attestation);
  console.log("Submitting claimReward...");

  const tx = await redemption.claimReward(
    message.poolId,
    message.evmAddress,
    message.blsPubkey,
    message.nftSetHash,
    message.pricingHash,
    message.nftCount,
    message.totalReward,
    message.issuedAt,
    message.nonce,
    nftIdsBytes32,
    attestation
  );
  console.log("tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("✅ confirmed:", rcpt.transactionHash);
}

main().catch((e) => {
  console.error("test-redeem-claim-dummy failed:", e);
  process.exit(1);
});
