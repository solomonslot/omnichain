require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.22",
  networks: {
    baseMainnet: {
      // Use your own Base mainnet RPC URL here or set it in your .env file as BASE_MAINNET_RPC_URL
      url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
      chainId: 8453, // Base Mainnet chain ID (update if needed)
      accounts: {
        // You can hardcode your mnemonic here or load it from your .env file
        mnemonic: process.env.MNEMONIC || "test test test test test test...",
        path: "m/44'/60'/0'/0",
        initialIndex: 0,
        count: 1,
      },
    },
  },
};
