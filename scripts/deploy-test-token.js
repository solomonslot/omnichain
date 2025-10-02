/* eslint-disable no-console */
/**
 * Deploys the TestToken (6 decimals) ERC20 for local/testing usage.
 *
 * Usage examples:
 *   - With CLI args:
 *       npx hardhat run scripts/deploy-test-token.js --network localhost --name "Test USD" --symbol TUSD --supply 1000000
 *   - With env vars (falls back when an arg is not provided):
 *       NAME="Test USD" SYMBOL="TUSD" SUPPLY="1000000" npx hardhat run scripts/deploy-test-token.js --network localhost
 *
 * Notes:
 * - SUPPLY is human-readable token amount (e.g., "1000000" => 1,000,000 tokens),
 *   converted using 6 decimals to base units.
 * - Alternatively, set SUPPLY_UNITS to provide the initial supply directly in base units.
 */
require("dotenv").config();

const hre = require("hardhat");

function getArg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  const upper = name.toUpperCase();
  if (process.env[upper] && String(process.env[upper]).trim().length > 0) {
    return String(process.env[upper]).trim();
  }
  return fallback;
}

function ensureNonEmpty(value, label) {
  const v = String(value || "").trim();
  if (!v) {
    throw new Error(`Missing required ${label}. Provide --${label.toLowerCase()} or set ${label.toUpperCase()} in env.`);
  }
  return v;
}

async function main() {
  const name = ensureNonEmpty(getArg("name", process.env.NAME), "name");
  const symbol = ensureNonEmpty(getArg("symbol", process.env.SYMBOL), "symbol");

  const supplyHuman = getArg("supply", process.env.SUPPLY || "");
  const supplyUnitsEnv = getArg("supply_units", process.env.SUPPLY_UNITS || "");

  let initialSupplyUnits;
  if (supplyUnitsEnv) {
    // Base units provided directly
    if (!/^\d+$/.test(supplyUnitsEnv)) {
      throw new Error("SUPPLY_UNITS must be a non-negative integer string in base units (decimals = 6).");
    }
    initialSupplyUnits = BigInt(supplyUnitsEnv);
  } else {
    const supplyStr = ensureNonEmpty(supplyHuman, "supply");
    try {
      initialSupplyUnits = hre.ethers.parseUnits(String(supplyStr), 6);
    } catch (e) {
      throw new Error(`Failed to parse --supply "${supplyStr}" with 6 decimals: ${e.message}`);
    }
  }

  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();

  console.log("Network:", net.name || "(unknown)", "chainId=", String(net.chainId));
  console.log("Deployer:", deployer.address);
  console.log("Token params:", { name, symbol, initialSupplyUnits: initialSupplyUnits.toString() });

  const Factory = await hre.ethers.getContractFactory("TestToken");
  const token = await Factory.deploy(name, symbol, initialSupplyUnits);
  await token.waitForDeployment();

  const address = token.target;
  console.log("Deployed TestToken at:", address);

  // Sanity checks
  const decimals = await token.decimals();
  const balance = await token.balanceOf(deployer.address);

  console.log("Decimals:", decimals);
  console.log("Deployer initial balance (base units):", balance.toString());

  if (Number(decimals) !== 6) {
    console.warn("Warning: Expected 6 decimals. Check the contract if this is unexpected.");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("deploy-test-token failed:", err);
  process.exit(1);
});
