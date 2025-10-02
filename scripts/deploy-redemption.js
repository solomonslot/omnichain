/* eslint-disable no-console */
/**
 * NftRedemption deployment script (amount-attested version)
 *
 * Constructor: NftRedemption(token, attestor, maxClaimAge)
 *
 * Usage (env only):
 *   REDEMPTION_TOKEN=0x... \
 *   REDEMPTION_ATTESTOR=0x... \
 *   REDEMPTION_MAX_CLAIM_AGE=0 \
 *   npx hardhat run scripts/deploy-redemption.js --network baseMainnet
 *
 * CLI overrides:
 *   npx hardhat run scripts/deploy-redemption.js \
 *     --network baseMainnet \
 *     --token 0x... \
 *     --attestor 0x... \
 *     --maxage 0
 *
 * Notes:
 * - maxClaimAge is in seconds (0 disables time check).
 * - After deployment, fund the contract with the reward token to cover payouts.
 */

require("dotenv").config();

const { ethers, network, run } = require("hardhat");

function parseArgs(argv) {
  const out = {};
  const arr = Array.from(argv || []);
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > -1) {
      const k = a.slice(2, eq).trim();
      const v = a.slice(eq + 1).trim();
      out[k] = v;
    } else {
      const k = a.slice(2).trim();
      const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

function requireAddress(name, value) {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} missing/invalid. Got: ${value || "(empty)"}`);
  }
  return ethers.getAddress(value);
}

function toBigIntStrict(name, value) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string") {
      const s = value.trim();
      if (s.length === 0) throw new Error("empty");
      return s.startsWith("0x") ? BigInt(s) : BigInt(s);
    }
  } catch {}
  throw new Error(`${name} must be integer-like. Got: ${value}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Config: prefer CLI args, fallback to env
  const tokenAddrRaw = args.token || process.env.REDEMPTION_TOKEN;
  const attestorAddrRaw = args.attestor || process.env.REDEMPTION_ATTESTOR;
  const maxAgeRaw = args.maxage || process.env.REDEMPTION_MAX_CLAIM_AGE || "0";

  // Validate and normalize
  const token = requireAddress("REDEMPTION_TOKEN/--token", tokenAddrRaw);
  const attestor = requireAddress(
    "REDEMPTION_ATTESTOR/--attestor",
    attestorAddrRaw
  );
  const maxClaimAgeBI = toBigIntStrict("maxClaimAge", maxAgeRaw);

  const [deployer] = await ethers.getSigners();
  const chain = await ethers.provider.getNetwork();

  console.log("== NftRedemption deployment ==");
  console.log("Deployer:", deployer.address);
  console.log("Network:", network.name, `chainId=${chain.chainId.toString()}`);
  console.log("Token:", token);
  console.log("Attestor:", attestor);
  console.log("Max claim age (seconds):", maxClaimAgeBI.toString());
  console.log("");

  const Redemption = await ethers.getContractFactory("NftRedemption");
  const deployment = await Redemption.deploy(token, attestor, maxClaimAgeBI);

  const depTx = deployment.deploymentTransaction();
  console.log(
    "Deploying NftRedemption... tx:",
    depTx && depTx.hash ? depTx.hash : "(unknown)"
  );
  await deployment.waitForDeployment();

  const addr = await deployment.getAddress();
  console.log("NftRedemption deployed at:", addr);
  console.log("");

  // Optional: attempt verification if API key is configured
  const canVerify =
    !!process.env.ETHERSCAN_API_KEY || !!process.env.BASESCAN_API_KEY;
  if (canVerify) {
    try {
      console.log("Attempting contract verification...");
      await run("verify:verify", {
        address: addr,
        constructorArguments: [token, attestor, maxClaimAgeBI],
      });
      console.log("Verification submitted.");
    } catch (err) {
      console.log("Verification attempt failed:", err.message || err);
    }
  } else {
    console.log("Explorer API key not set; skipping auto-verify.");
  }

  console.log("");
  console.log("Manual verify (if needed):");
  console.log(
    `npx hardhat verify --network ${
      network.name
    } ${addr} ${token} ${attestor} ${maxClaimAgeBI.toString()}`
  );
  console.log("");
  console.log(
    "Reminder: fund the contract with sufficient reward tokens for expected claims."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Deployment failed:", err);
    process.exit(1);
  });
