/**
 * scripts/deploy-escrowvault.js
 *
 * Hardhat script to deploy the dynamic EscrowVault,
 * which has 4 constructor args:
 *   1) usdcAddress
 *   2) warpPortalAddress
 *   3) payoutAddress
 *   4) sourceChain (bytes3), e.g. "0x786368" for "xch"
 */

const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const { ethers } = hre;

  // e.g. load addresses from .env or fallback
  const USDC_ADDRESS = process.env.USDC_ADDRESS || "0xSomeDefaultUsdc";
  const WARP_PORTAL_ADDRESS = process.env.WARP_PORTAL_ADDRESS || "0xPortal";
  const PAYOUT_ADDRESS = process.env.PAYOUT_ADDRESS || "0xPayout";

  // A 3-byte chain ID in hex, e.g. "xch" => 0x786368
  // If not in .env, fallback to "xch"
  const SOURCE_CHAIN = process.env.SOURCE_CHAIN || "0x786368"; // 'xch'

  console.log("[deploy-escrowvault] => Deploying with:");
  console.log("USDC_ADDRESS=", USDC_ADDRESS);
  console.log("WARP_PORTAL_ADDRESS=", WARP_PORTAL_ADDRESS);
  console.log("PAYOUT_ADDRESS=", PAYOUT_ADDRESS);
  console.log("SOURCE_CHAIN=", SOURCE_CHAIN);

  // Compile
  await hre.run("compile");

  // Get the factory for EscrowVault
  const EscrowVaultFactory = await ethers.getContractFactory("EscrowVault");

  // Deploy with 4 args
  const vault = await EscrowVaultFactory.deploy(
      USDC_ADDRESS,
      WARP_PORTAL_ADDRESS,
      PAYOUT_ADDRESS,
      SOURCE_CHAIN
  );

  // Wait until mined
  await vault.waitForDeployment();

  console.log("EscrowVault deployed to:", vault.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
