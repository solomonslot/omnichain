// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @dev Minimal ERC-20 interface for USDC (transferFrom + transfer).
 */
interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/**
 * @dev Interface for the Warp Portal contract (to get the toll + send cross-chain messages).
 */
interface IPortal {
    function messageToll() external view returns (uint256);
    function sendMessage(bytes3 _destinationChain, bytes32 _destination, bytes32[] calldata _contents) external payable;
}

/**
 * @title EscrowVault
 * @notice A non‑upgradeable contract for holding USDC in escrow during cross‑chain transfers via warp.green.
 *         - Collects a toll in ETH for relaying the message cross‑chain.
 *         - Locks USDC on this chain, and instructs the remote chain to mint/unlock.
 *         - When a verified return message arrives, always releases USDC to `payoutAddress`.
 *
 * @dev
 * - Inherits Ownable, Pausable, ReentrancyGuard from OpenZeppelin.
 * - Hard‑codes USDC as the token to be escrowed (stored in `usdcAddress`).
 * - The cross‑chain “recipient” is ignored: tokens go to `payoutAddress`.
 */
contract EscrowVault is Ownable, Pausable, ReentrancyGuard {
    // -------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------

    /// @notice The USDC token contract to be escrowed.
    address public usdcAddress;

    /// @notice The Warp Portal address (authorized to call receiveMessage).
    address public warpPortal;

    /// @notice A fixed address to which all released USDC is sent upon cross-chain message.
    address public payoutAddress;

    /// @notice Used if you want to restrict cross-chain messages to a known chain ID, e.g. "xch".
    bytes3 public sourceChain;

    /// @notice The trusted puzzle hash on the remote chain that we expect to send valid messages.
    bytes32 public trustedSource;

    /// @notice The puzzle hash on the remote chain that receives messages from this side.
    bytes32 public unlockerPuzzleHash;

    /// @notice Prevents replay attacks for cross-chain messages (stores used nonces).
    mapping(bytes32 => bool) private usedNonces;

    // -------------------------------------------------------------------
    // Deposit Structure
    // -------------------------------------------------------------------

    /**
     * @dev Each deposit is keyed by `paymentId`. That is how we find it after the cross-chain message returns.
     */
    struct Deposit {
        address user;           // The EVM address of the user who deposited
        bytes32 nftId;          // An arbitrary ID (as in your script), not actually an NFT here
        bytes32 paymentId;      // Unique payment ID from your script
        bytes32 chiaPuzzleHash; // The puzzle hash on the remote chain (for bridging out)
        uint256 amountUSDC;     // How many USDC tokens were escrowed
        uint256 dacCount;       // Some extra integer your script includes
        bool completed;         // True once we finalize the release
    }

    /// @notice Mapping from paymentId => Deposit data
    mapping(bytes32 => Deposit) public deposits;

    /// @notice Tracks total deposit count (optional, not strictly used except for stats).
    uint256 public depositCount;

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    event PaymentDeposited(
        bytes32 indexed paymentId,
        address indexed user,
        uint256 amountUSDC,
        uint256 tollPaid
    );

    event PayoutCompleted(
        bytes32 indexed paymentId,
        uint256 amountUSDC,
        address indexed recipient
    );

    event PayoutSetByAdmin(
        bytes32 indexed paymentId,
        address indexed recipient
    );

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    /**
     * @notice Sets up references to the USDC contract, warp portal, and the fixed payout address.
     * @param _usdc The address of the USDC token (e.g., official USDC on Base).
     * @param _warpPortal The warp portal contract address (authorized to call `receiveMessage`).
     * @param _payoutAddress The address to which all USDC is ultimately released on this chain.
     */
    constructor(address _usdc, address _warpPortal, address _payoutAddress) {
        require(_usdc != address(0), "USDC=0");
        require(_warpPortal != address(0), "warpPortal=0");
        require(_payoutAddress != address(0), "payout=0");

        usdcAddress = _usdc;
        warpPortal = _warpPortal;
        payoutAddress = _payoutAddress;
    }

    // -------------------------------------------------------------------
    // Public Functions
    // -------------------------------------------------------------------

    /**
     * @notice Deposits USDC into escrow and triggers a cross‑chain message.
     * @dev Matches the 5‑param signature your `testDeposit.js` script calls.
     *      User must have approved this contract to spend `amountUSDC` beforehand.
     *
     * @param nftId         Arbitrary bytes32 ID from your script (not actually used for NFTs here).
     * @param paymentId     A unique payment ID from your script.
     * @param chiaPuzzleHash The remote puzzle hash on e.g. Chia (if bridging out).
     * @param amountUSDC    How much USDC to deposit.
     * @param dacCount      An extra integer your script includes (e.g. # of DAC).
     */
    function depositPayment(
        bytes32 nftId,
        bytes32 paymentId,
        bytes32 chiaPuzzleHash,
        uint256 amountUSDC,
        uint256 dacCount
    )
        external
        payable
        whenNotPaused
        nonReentrant
    {
        // 1) Validate warp toll
        uint256 toll = IPortal(warpPortal).messageToll();
        require(msg.value == toll, "Incorrect warp toll");

        // 2) Validate deposit
        require(paymentId != 0, "paymentId=0");
        require(amountUSDC > 0, "amount=0");
        // Ensure we haven't used this paymentId before:
        require(deposits[paymentId].paymentId == 0, "paymentId already exists");

        // 3) Pull USDC from user => escrow
        bool success = IERC20(usdcAddress).transferFrom(msg.sender, address(this), amountUSDC);
        require(success, "transferFrom failed");

        // 4) Record the deposit
        depositCount += 1;
        deposits[paymentId] = Deposit({
            user: msg.sender,
            nftId: nftId,
            paymentId: paymentId,
            chiaPuzzleHash: chiaPuzzleHash,
            amountUSDC: amountUSDC,
            dacCount: dacCount,
            completed: false
        });

        emit PaymentDeposited(paymentId, msg.sender, amountUSDC, msg.value);

        // 5) Build and send cross-chain message
        //    Example: 3 items. Adjust as needed if the remote chain puzzle expects more.
        bytes32[] memory contents = new bytes32[](3);
        contents[0] = paymentId;
        contents[1] = bytes32(amountUSDC);
        contents[2] = bytes32(dacCount);   // or chiaPuzzleHash if you prefer

        IPortal(warpPortal).sendMessage{ value: toll }(sourceChain, unlockerPuzzleHash, contents);
    }

    /**
     * @notice Called by Warp Portal after verifying a cross-chain message from `trustedSource`.
     * @param _nonce A unique ID for this message (used to prevent replay).
     * @param _source_chain The 3-byte chain ID (e.g. "xch").
     * @param _source The puzzle hash or address on the remote chain that sent the message.
     * @param _contents The payload: at least `[paymentId, amount, dacOrPuzzle]`.
     *
     * @dev Always pays out to `payoutAddress`, ignoring any dynamic recipient in `_contents`.
     */
    function receiveMessage(
        bytes32 _nonce,
        bytes3 _source_chain,
        bytes32 _source,
        bytes32[] calldata _contents
    )
        external
        whenNotPaused
        nonReentrant
    {
        // 1) Validate caller
        require(msg.sender == warpPortal, "Not warpPortal");
        require(_source_chain == sourceChain, "Wrong source chain");
        require(_source == trustedSource, "Untrusted source puzzle");

        // 2) Replay protection
        bytes32 key = keccak256(abi.encodePacked(_source_chain, _nonce));
        require(!usedNonces[key], "Replay detected");
        usedNonces[key] = true;

        // 3) Parse contents (assuming at least 2 items: [paymentId, amount])
        require(_contents.length >= 2, "Invalid contents");
        bytes32 paymentId = _contents[0];
        uint256 remoteAmount = uint256(_contents[1]);

        Deposit storage dep = deposits[paymentId];
        require(dep.paymentId != 0, "Unknown paymentId");
        require(!dep.completed, "Already completed");
        require(remoteAmount <= dep.amountUSDC, "Over deposit amount");

        // 4) Mark the deposit as completed
        dep.completed = true;

        // 5) Transfer USDC from escrow to your fixed `payoutAddress`
        bool success = IERC20(usdcAddress).transfer(payoutAddress, remoteAmount);
        require(success, "transfer to payout failed");

        emit PayoutCompleted(paymentId, remoteAmount, payoutAddress);
    }

    // -------------------------------------------------------------------
    // Admin / Emergency Functions
    // -------------------------------------------------------------------

    /**
     * @notice Owner can forcibly release USDC if bridging fails or for other reasons.
     * @param paymentId The deposit record to finalize.
     * @param recipient The address to receive the USDC.
     */
    function setPayout(bytes32 paymentId, address recipient)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        require(paymentId != 0, "paymentId=0");
        require(recipient != address(0), "recipient=0");

        Deposit storage dep = deposits[paymentId];
        require(dep.paymentId != 0, "Unknown paymentId");
        require(!dep.completed, "Already completed");

        dep.completed = true;

        bool success = IERC20(usdcAddress).transfer(recipient, dep.amountUSDC);
        require(success, "transfer failed");

        emit PayoutSetByAdmin(paymentId, recipient);
        emit PayoutCompleted(paymentId, dep.amountUSDC, recipient);
    }

    /**
     * @notice Pause the contract to block deposits and cross-chain receives.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract to allow deposits and cross-chain receives again.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------------
    // Optional: Owner can set bridging parameters
    // -------------------------------------------------------------------

    /**
     * @notice Owner sets bridging parameters for warp portal usage.
     * @param _sourceChain        3-byte ID of the remote chain (e.g., "xch").
     * @param _trustedSource      Puzzle hash or address on the remote chain that we trust.
     * @param _unlockerPuzzleHash Destination puzzle hash on the remote chain for bridging out.
     */
    function configureBridging(
        bytes3 _sourceChain,
        bytes32 _trustedSource,
        bytes32 _unlockerPuzzleHash
    )
        external
        onlyOwner
    {
        sourceChain = _sourceChain;
        trustedSource = _trustedSource;
        unlockerPuzzleHash = _unlockerPuzzleHash;
    }
}
