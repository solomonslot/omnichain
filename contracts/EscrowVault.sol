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
    function sendMessage(
        bytes3 _destinationChain,
        bytes32 _destination,
        bytes32[] calldata _contents
    ) external payable;
}

/**
 * @title EscrowVault
 * @notice A non-upgradeable contract for holding USDC in escrow and bridging to Chia via warp.green.
 *         - Collects a toll in ETH for the warp message.
 *         - Locks USDC on this chain, bridging out to a user-chosen puzzle on Chia.
 *         - On return message from the *per-deposit* trusted puzzle, releases USDC to `payoutAddress`.
 *
 * @dev
 * - Inherits Ownable, Pausable, ReentrancyGuard from OpenZeppelin.
 * - Hard-codes a single USDC token address as `usdcAddress`.
 * - Three dynamic puzzle hashes per deposit:
 *   1) bridgingPuzzle    => used as `_destination` in warp portal's sendMessage
 *   2) trustedPuzzle     => the remote puzzle that can finalize (calls receiveMessage)
 *   3) destinationPuzzle => a separate puzzle for DAC usage or stripe logic (exposed in the bridging message)
 * - A single `sourceChain` is used, e.g. 0x786368 for "xch".
 */
contract EscrowVault is Ownable, Pausable, ReentrancyGuard {
    // -------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------

    /// @notice The USDC token contract for escrow.
    address public usdcAddress;

    /// @notice The Warp Portal to which we pay toll and call sendMessage.
    address public warpPortal;

    /// @notice A single address on this chain to which all USDC is paid out on finalization.
    address public payoutAddress;

    /// @notice A single chain ID for bridging. e.g. "xch" => 0x786368.
    bytes3 public sourceChain;

    /// @notice Prevent replay attacks in receiveMessage (stores used nonces).
    mapping(bytes32 => bool) private usedNonces;

    // -------------------------------------------------------------------
    // Deposit Structure
    // -------------------------------------------------------------------

    /**
     * @dev Each deposit is keyed by `paymentId`.
     */
    struct Deposit {
        address user;              // The EVM address that made the deposit
        bytes32 nftId;            // Arbitrary ID from your script
        bytes32 paymentId;        // Unique payment ID from your script

        // *** 3 puzzle hashes for different uses ***
        bytes32 bridgingPuzzle;   // Used for warp bridging => sendMessage(... bridgingPuzzle ...)
        bytes32 trustedPuzzle;    // The puzzle that can finalize the deposit => calls receiveMessage
        bytes32 destinationPuzzle;// Another puzzle e.g. for DAC or Stripe usage

        uint256 amountUSDC;       // The escrowed USDC
        uint256 dacCount;         // Extra integer from your script
        bool completed;           // True once we finalize
    }

    /// @notice Mapping from paymentId => deposit record
    mapping(bytes32 => Deposit) public deposits;

    /// @notice Tracks total deposit count (for stats).
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
     * @param _usdc        The address of the USDC token (e.g. official USDC on Base).
     * @param _warpPortal  The warp portal contract address (authorized to call receiveMessage).
     * @param _payoutAddr  The fixed address to which final USDC is always released.
     * @param _sourceChain The 3-byte chain ID for bridging, e.g. "xch" => 0x786368.
     */
    constructor(
        address _usdc,
        address _warpPortal,
        address _payoutAddr,
        bytes3 _sourceChain
    ) {
        require(_usdc != address(0), "USDC=0");
        require(_warpPortal != address(0), "warpPortal=0");
        require(_payoutAddr != address(0), "payout=0");

        usdcAddress = _usdc;
        warpPortal = _warpPortal;
        payoutAddress = _payoutAddr;
        sourceChain = _sourceChain;
    }

    // -------------------------------------------------------------------
    // Public / External Functions
    // -------------------------------------------------------------------

    /**
     * @notice depositPayment => bridging & escrow.
     *  The user supplies 3 puzzle hashes on Chia:
     *    bridgingPuzzle    => The puzzle that receives the warp message.
     *    trustedPuzzle     => The puzzle that can finalize by returning the message.
     *    destinationPuzzle => Another puzzle for DAC/Stripe usage (e.g. separate from bridging).
     *
     * @param nftId            Arbitrary ID from your script.
     * @param paymentId        A unique payment ID from your script.
     * @param bridgingPuzzle   The remote puzzle that receives the warp message. Must not be 0.
     * @param trustedPuzzle    The remote puzzle that can finalize in receiveMessage. Must not be 0.
     * @param destinationPuzzle Another puzzle e.g. for DAC usage, must not be 0 in your logic if needed.
     * @param amountUSDC       The deposit amount in USDC (must have prior approval).
     * @param dacCount         Extra integer from your script (like # of DAC).
     */
    function depositPayment(
        bytes32 nftId,
        bytes32 paymentId,
        bytes32 bridgingPuzzle,
        bytes32 trustedPuzzle,
        bytes32 destinationPuzzle,
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
        require(bridgingPuzzle != 0, "!dest bridging=0");
        require(trustedPuzzle != 0, "!trusted=0");
        // If you want to require destinationPuzzle != 0, do it here:
        // require(destinationPuzzle != 0, "!destination=0");
        require(amountUSDC > 0, "amount=0");
        require(deposits[paymentId].paymentId == 0, "paymentId used");

        // 3) Pull USDC => escrow
        bool success = IERC20(usdcAddress).transferFrom(msg.sender, address(this), amountUSDC);
        require(success, "transferFrom failed");

        // 4) Record deposit
        depositCount += 1;
        deposits[paymentId] = Deposit({
            user: msg.sender,
            nftId: nftId,
            paymentId: paymentId,
            bridgingPuzzle: bridgingPuzzle,
            trustedPuzzle: trustedPuzzle,
            destinationPuzzle: destinationPuzzle,
            amountUSDC: amountUSDC,
            dacCount: dacCount,
            completed: false
        });

        emit PaymentDeposited(paymentId, msg.sender, amountUSDC, msg.value);

        // 5) Build cross-chain message
        //    We can put the destinationPuzzle in the array so the remote chain sees it.
        //    e.g. 4 items: paymentId, amount, dacCount, destinationPuzzle
        bytes32[] memory contents = new bytes32[](4);
        contents[0] = paymentId;
        contents[1] = bytes32(amountUSDC);
        contents[2] = bytes32(dacCount);
        contents[3] = destinationPuzzle;

        // 6) sendMessage => bridgingPuzzle is the warp destination
        IPortal(warpPortal).sendMessage{ value: toll }(
            sourceChain,
            bridgingPuzzle,
            contents
        );
    }

    /**
     * @notice Called by warp portal after verifying a cross-chain message from `trustedPuzzle`.
     * @param _nonce        A unique ID for this message (prevent replay).
     * @param _source_chain The chain ID (we expect `sourceChain`).
     * @param _source       The puzzle on the remote chain that minted/finalized.
     * @param _contents     Typically [paymentId, amount, dacCount, destinationPuzzle].
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
        // 1) Validate caller => warpPortal only
        require(msg.sender == warpPortal, "Not warpPortal");
        require(_source_chain == sourceChain, "Wrong source chain");

        // 2) Replay protection
        bytes32 key = keccak256(abi.encodePacked(_source_chain, _nonce));
        require(!usedNonces[key], "Replay detected");
        usedNonces[key] = true;

        // 3) Must have at least [paymentId, amount], typically 4
        require(_contents.length >= 2, "Invalid contents");
        bytes32 paymentId = _contents[0];
        uint256 remoteAmount = uint256(_contents[1]);

        Deposit storage dep = deposits[paymentId];
        require(dep.paymentId != 0, "Unknown paymentId");
        require(!dep.completed, "Already completed");

        // The puzzle that can finalize is the deposit's `trustedPuzzle`.
        require(_source == dep.trustedPuzzle, "Untrusted puzzle");
        require(remoteAmount <= dep.amountUSDC, "Over deposit amount");

        // 4) finalize deposit
        dep.completed = true;

        // 5) Transfer USDC => fixed payout address
        bool success = IERC20(usdcAddress).transfer(payoutAddress, remoteAmount);
        require(success, "transfer to payout failed");

        emit PayoutCompleted(paymentId, remoteAmount, payoutAddress);
    }

    // -------------------------------------------------------------------
    // Admin / Emergency
    // -------------------------------------------------------------------

    /**
     * @notice Admin can forcibly release USDC if bridging fails or for other reasons.
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
     * @notice Owner can set a new sourceChain if needed. e.g. "xch" => 0x786368
     */
    function setSourceChain(bytes3 _sourceChain) external onlyOwner {
        sourceChain = _sourceChain;
    }

    /**
     * @notice Pause the contract, blocking new deposits or cross-chain receives.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract to allow deposits and receives again.
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
