// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test-only copy of the canonical x402 Permit2 proxy sources, pinned to the
// `shanghai` EVM version so it can run on the local ganache chain:
//   - contracts/evm/src/x402ExactPermit2Proxy.sol
//   - contracts/evm/src/x402BasePermit2Proxy.sol
//   - contracts/evm/src/interfaces/ISignatureTransfer.sol
// with the OpenZeppelin ReentrancyGuard / IERC20Permit dependencies inlined.
//
// The runtime deployed at 0x402085c248EeA27D92E8b30b2C58ed07f9E20001 on BOT
// Chain testnet is Cancun-compiled and contains a single MCOPY opcode, which
// ganache 7.9.2 cannot execute (TLOAD/TSTORE/MCOPY are rejected as invalid
// opcodes). This build keeps the same settle logic, witness constants and
// storage layout, so the settle calldata and Permit2 witness flow are still
// exercised locally against the real Permit2 runtime.
// Never deploy this on a public network.

interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

abstract contract ReentrancyGuard {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        if (_status == ENTERED) revert ReentrancyGuardReentrantCall();
        _status = ENTERED;
    }

    function _nonReentrantAfter() private {
        _status = NOT_ENTERED;
    }
}

abstract contract x402BasePermit2Proxy is ReentrancyGuard {
    ISignatureTransfer public immutable PERMIT2;

    event Settled();

    event SettledWithPermit();

    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);

    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);

    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    error InvalidPermit2Address();

    error InvalidDestination();

    error PaymentTooEarly();

    error InvalidOwner();

    error InvalidAmount();

    error Permit2612AmountMismatch();

    struct EIP2612Permit {
        uint256 value;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    constructor(address _permit2) {
        if (_permit2 == address(0)) revert InvalidPermit2Address();
        PERMIT2 = ISignatureTransfer(_permit2);
    }

    function _settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        uint256 settlementAmount,
        address owner,
        address to,
        uint256 validAfter,
        bytes32 witnessHash,
        string memory witnessTypeString,
        bytes calldata signature
    ) internal {
        if (settlementAmount == 0) revert InvalidAmount();
        if (owner == address(0)) revert InvalidOwner();
        if (to == address(0)) revert InvalidDestination();
        if (block.timestamp < validAfter) revert PaymentTooEarly();

        ISignatureTransfer.SignatureTransferDetails memory transferDetails =
            ISignatureTransfer.SignatureTransferDetails({to: to, requestedAmount: settlementAmount});

        PERMIT2.permitWitnessTransferFrom(permit, transferDetails, owner, witnessHash, witnessTypeString, signature);
    }

    function _executePermit(
        address token,
        address owner,
        EIP2612Permit calldata permit2612,
        uint256 permittedAmount
    ) internal {
        if (permit2612.value != permittedAmount) {
            revert Permit2612AmountMismatch();
        }

        try IERC20Permit(token).permit(
            owner, address(PERMIT2), permit2612.value, permit2612.deadline, permit2612.v, permit2612.r, permit2612.s
        ) {
            // EIP-2612 permit succeeded
        } catch Error(string memory reason) {
            emit EIP2612PermitFailedWithReason(token, owner, reason);
        } catch Panic(uint256 errorCode) {
            emit EIP2612PermitFailedWithPanic(token, owner, errorCode);
        } catch (bytes memory data) {
            emit EIP2612PermitFailedWithData(token, owner, data);
        }
    }
}

contract x402ExactPermit2Proxy is x402BasePermit2Proxy {
    string public constant WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";

    bytes32 public constant WITNESS_TYPEHASH = keccak256("Witness(address to,uint256 validAfter)");

    struct Witness {
        address to;
        uint256 validAfter;
    }

    constructor(address _permit2) x402BasePermit2Proxy(_permit2) {}

    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 witnessHash = keccak256(abi.encode(WITNESS_TYPEHASH, witness.to, witness.validAfter));
        _settle(
            permit,
            permit.permitted.amount,
            owner,
            witness.to,
            witness.validAfter,
            witnessHash,
            WITNESS_TYPE_STRING,
            signature
        );
        emit Settled();
    }

    function settleWithPermit(
        EIP2612Permit calldata permit2612,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external nonReentrant {
        _executePermit(permit.permitted.token, owner, permit2612, permit.permitted.amount);
        bytes32 witnessHash = keccak256(abi.encode(WITNESS_TYPEHASH, witness.to, witness.validAfter));
        _settle(
            permit,
            permit.permitted.amount,
            owner,
            witness.to,
            witness.validAfter,
            witnessHash,
            WITNESS_TYPE_STRING,
            signature
        );
        emit SettledWithPermit();
    }
}
