// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Single-merchant settlement treasury. Payout identifiers must be globally unique per deployment.
contract Settlement is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    IERC20 public immutable token;
    mapping(bytes32 => bool) public paid;
    event Paid(bytes32 indexed payoutId, address indexed recipient, uint256 amount, address indexed token);
    constructor(address token_, address admin, address executor) {
        require(block.chainid == 43113 || block.chainid == 31337 || block.chainid == 968 || block.chainid == 677, "unsupported chain");
        require(token_.code.length > 0 && admin != address(0) && executor != address(0), "invalid configuration");
        require(block.chainid != 43113 || token_ == 0x5425890298aed601595a70AB815c96711a31Bc65, "Fuji test USDC only");
        require(block.chainid != 968 || token_ == 0x75edC9335175Fc0552D51D48439F229c10420fe3, "BOT test USDT only");
        require(block.chainid != 677 || token_ == 0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C, "BOT USDT only");
        require(IERC20Metadata(token_).decimals() == 6, "6 decimals required");
        token = IERC20(token_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, executor);
        // Deployment does not activate payouts. Owner enables after funding/ledger acceptance.
        if (block.chainid == 677 || block.chainid == 968) _pause();
    }
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
    function pay(bytes32 payoutId, address recipient, uint256 amount) external onlyRole(EXECUTOR_ROLE) whenNotPaused nonReentrant {
        require(payoutId != bytes32(0) && !paid[payoutId], "invalid or paid ID");
        require(recipient != address(0) && recipient != address(this) && amount > 0, "invalid payout");
        paid[payoutId] = true;
        token.safeTransfer(recipient, amount);
        emit Paid(payoutId, recipient, amount, address(token));
    }
}
