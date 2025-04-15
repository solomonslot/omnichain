const hre = require("hardhat");
require("dotenv").config(); // read .env

async function main() {
  const { ethers } = hre;

  // e.g. load addresses from .env or fallback
  const USDC_ADDRESS = process.env.USDC_ADDRESS || "0xSomeDefaultUsdc";
  const WARP_PORTAL_ADDRESS = process.env.WARP_PORTAL_ADDRESS || "0xPortal";
  const PAYOUT_ADDRESS = process.env.PAYOUT_ADDRESS || "0xPayout";

  await hre.run("compile");

  // Get the factory for our non-upgradeable EscrowVault
  const EscrowVaultFactory = await ethers.getContractFactory("EscrowVault");

  // Deploy via constructor with 3 arguments
  const vault = await EscrowVaultFactory.deploy(
      USDC_ADDRESS,
      WARP_PORTAL_ADDRESS,
      PAYOUT_ADDRESS
  );

  // Wait until mined
  await vault.waitForDeployment();
  console.log("EscrowVault deployed to:", vault.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
