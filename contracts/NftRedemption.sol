// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title NftRedemption
 * @notice Off-chain oracle (attestor) verifies Chia BLS ownership + pricing and signs an EIP-712 claim.
 *         Contract verifies the attestation, enforces one-time redemption per NFT, and transfers the
 *         attested totalReward (in rewardToken base units) to the signed evmAddress.
 *
 * Typed data additions vs. v1:
 *   - pricingHash: binds per-NFT amounts chosen off-chain to the signed set
 *   - totalReward: total payout (uint256) in rewardToken base units
 */
contract NftRedemption is EIP712, Ownable, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------
    // RedemptionClaim:
    //   bytes32 poolId
    //   address evmAddress
    //   bytes   blsPubkey
    //   bytes32 nftSetHash
    //   bytes32 pricingHash
    //   uint256 nftCount
    //   uint256 totalReward
    //   uint64  issuedAt
    //   bytes32 nonce
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "RedemptionClaim(bytes32 poolId,address evmAddress,bytes blsPubkey,bytes32 nftSetHash,bytes32 pricingHash,uint256 nftCount,uint256 totalReward,uint64 issuedAt,bytes32 nonce)"
    );

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    /// @notice ERC20 token used for payouts (e.g., USDC on Base).
    IERC20 public rewardToken;

    /// @notice Address of the oracle/attestor whose EIP-712 signatures are accepted.
    address public attestor;

    /// @notice Optional max age for claims in seconds (0 disables time check).
    uint256 public maxClaimAge;

    /// @notice Prevents claim replay (nonce uniqueness).
    mapping(bytes32 => bool) public usedNonce;

    /// @notice Tracks if a given NFT id has been redeemed.
    mapping(bytes32 => bool) public nftRedeemed;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event AttestorUpdated(address indexed oldAttestor, address indexed newAttestor);
    event RewardTokenUpdated(address indexed oldToken, address indexed newToken);
    event MaxClaimAgeUpdated(uint256 oldValue, uint256 newValue);

    event RewardClaimed(
        bytes32 indexed poolId,
        address indexed caller,
        address indexed payout,
        uint256 nftCount,
        uint256 totalReward
    );

    event NftRedeemed(bytes32 indexed poolId, bytes32 indexed nftId, address indexed payout);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @param token_         ERC20 reward token address.
     * @param attestor_      Oracle signer address for EIP-712 attestations.
     * @param maxClaimAge_   Max age in seconds for claim validity (0 => disabled).
     *
     * EIP-712 domain: name="Solslot-Redemption", version="1".
     * Chain id and verifying contract are bound automatically.
     */
    constructor(
        address token_,
        address attestor_,
        uint256 maxClaimAge_
    ) EIP712("Solslot-Redemption", "1") {
        require(token_ != address(0), "token=0");
        require(attestor_ != address(0), "attestor=0");
        rewardToken = IERC20(token_);
        attestor = attestor_;
        maxClaimAge = maxClaimAge_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setAttestor(address newAttestor) external onlyOwner {
        require(newAttestor != address(0), "attestor=0");
        emit AttestorUpdated(attestor, newAttestor);
        attestor = newAttestor;
    }

    function setRewardToken(address newToken) external onlyOwner {
        require(newToken != address(0), "token=0");
        emit RewardTokenUpdated(address(rewardToken), newToken);
        rewardToken = IERC20(newToken);
    }

    function setMaxClaimAge(uint256 newValue) external onlyOwner {
        emit MaxClaimAgeUpdated(maxClaimAge, newValue);
        maxClaimAge = newValue;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Owner can recover any ERC20 tokens from this contract.
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // View helpers
    // ---------------------------------------------------------------------

    /// @notice Computes the nftSetHash using the same scheme as the client/server:
    ///         join lowercase hex (64 chars) of each bytes32 id with '\n' and keccak256 it.
    ///         The input array must already be sorted ascending (checked).
    function computeNftSetHashForSortedIds(bytes32[] calldata nftIds) external pure returns (bytes32) {
        _requireStrictlySorted(nftIds);
        return _hashNftListLowerHexWithNewlines(nftIds);
    }

    // ---------------------------------------------------------------------
    // Claims
    // ---------------------------------------------------------------------

    /**
     * @notice Claim rewards for a set of NFTs proven by an oracle attestation.
     *
     * Requirements:
     * - The oracle attestation must be a valid EIP-712 signature from `attestor`.
     * - The provided `nftIds` MUST be sorted ascending and match the signed `nftSetHash`.
     * - Each NFT can be redeemed only once.
     * - If `maxClaimAge > 0`, claim must be within the allowed age from `issuedAt`.
     *
     * Payout:
     * - Tokens are sent to `evmAddress` from the signed payload (front-running safe).
     *
     * @param poolId       Sale/pool identifier.
     * @param evmAddress   Address to receive the payout.
     * @param blsPubkey    48-byte compressed BLS pubkey from Chia (opaque here).
     * @param nftSetHash   Hash of sorted, lowercased NFT id strings joined by '\n'.
     * @param pricingHash  Hash binding each NFT id to its off-chain computed amount.
     * @param nftCount     Number of NFTs in the claim (must equal nftIds.length).
     * @param totalReward  Total payout in rewardToken base units (signed by attestor).
     * @param issuedAt     Unix time (seconds) when claim was issued.
     * @param nonce        Unique claim nonce (prevents replay).
     * @param nftIds       Sorted array of NFT ids as bytes32 (must match the off-chain set).
     * @param attestation  EIP-712 signature by `attestor` over the claim fields.
     */
    function claimReward(
        bytes32 poolId,
        address evmAddress,
        bytes calldata blsPubkey,
        bytes32 nftSetHash,
        bytes32 pricingHash,
        uint256 nftCount,
        uint256 totalReward,
        uint64 issuedAt,
        bytes32 nonce,
        bytes32[] calldata nftIds,
        bytes calldata attestation
    ) external whenNotPaused nonReentrant {
        require(evmAddress != address(0), "evmAddress=0");
        require(nftIds.length == nftCount, "nftCount mismatch");
        require(!usedNonce[nonce], "nonce used");
        require(blsPubkey.length == 48, "blsPubkey !=48 bytes");

        if (maxClaimAge > 0) {
            require(issuedAt <= block.timestamp, "issuedAt in future");
            require(block.timestamp - issuedAt <= maxClaimAge, "claim too old");
        }

        // Verify oracle signature (attestation) over the EIP-712 typed claim.
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                poolId,
                evmAddress,
                keccak256(blsPubkey), // dynamic bytes per EIP-712
                nftSetHash,
                pricingHash,
                nftCount,
                totalReward,
                issuedAt,
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, attestation);
        require(signer == attestor, "invalid attestation");

        // Ensure NFT list integrity: sorted and hash matches the signed one.
        _requireStrictlySorted(nftIds);
        bytes32 calcHash = _hashNftListLowerHexWithNewlines(nftIds);
        require(calcHash == nftSetHash, "nftSetHash mismatch");

        // Lock the nonce only after all validation has succeeded
        usedNonce[nonce] = true;

        // Redeem each NFT only once.
        for (uint256 i = 0; i < nftIds.length; i++) {
            bytes32 id = nftIds[i];
            require(!nftRedeemed[id], "NFT already redeemed");
            nftRedeemed[id] = true;
            emit NftRedeemed(poolId, id, evmAddress);
        }

        // Transfer the totalReward to the signed evmAddress.
        require(totalReward > 0, "no payout");
        rewardToken.safeTransfer(evmAddress, totalReward);

        emit RewardClaimed(poolId, msg.sender, evmAddress, nftIds.length, totalReward);
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    /// @dev Reverts if the array is not strictly non-decreasing (ascending) order.
    function _requireStrictlySorted(bytes32[] calldata arr) internal pure {
        if (arr.length <= 1) return;
        bytes32 prev = arr[0];
        for (uint256 i = 1; i < arr.length; i++) {
            bytes32 cur = arr[i];
            require(cur > prev, "nftIds not strictly ascending");
            prev = cur;
        }
    }

    /// @dev Convert a bytes32 to a 64-char lowercase hex string (no 0x prefix).
    function _toLowerHex(bytes32 data) internal pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(uint256(data) >> (248 - i * 8));
            out[2 * i] = _hexCharLower(b >> 4);
            out[2 * i + 1] = _hexCharLower(b & 0x0f);
        }
    }

    /// @dev Returns hex char for nibble (0..15) as lowercase.
    function _hexCharLower(uint8 nibble) internal pure returns (bytes1) {
        return bytes1(nibble + (nibble < 10 ? 0x30 : 0x57));
    }

    /// @dev Hash nftIds by converting each to lowercase hex, joining with '\n', and keccak256.
    ///      Input MUST be sorted to match off-chain canonicalization.
    function _hashNftListLowerHexWithNewlines(bytes32[] calldata nftIds) internal pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i = 0; i < nftIds.length; i++) {
            if (i > 0) {
                packed = abi.encodePacked(packed, "\n");
            }
            packed = abi.encodePacked(packed, _toLowerHex(nftIds[i]));
        }
        return keccak256(packed);
    }
}
