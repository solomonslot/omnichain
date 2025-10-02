// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TestToken
 * @notice Simple ERC20 token with 6 decimals for local testing.
 *         Useful for funding and testing the NftRedemption contract flows.
 *
 * Decimals: 6 (USDC-like)
 * Minting: Owner can mint additional tokens to any address.
 * Burning: Holders can burn their own tokens.
 *
 * Constructor mints the provided initialSupply (in base units, i.e., 6 decimals)
 * to the deployer (owner).
 */
contract TestToken is ERC20Burnable, Ownable {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply
    ) ERC20(name_, symbol_) {
        _mint(msg.sender, initialSupply);
    }

    /// @notice Return 6 decimals (USDC-like).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Owner-only mint function. Amount is in base units (decimals = 6).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
