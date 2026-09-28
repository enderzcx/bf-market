// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract JobLifecycleAnchorV2 {
    address public owner;
    uint256 private _nextAnchorId = 1;

    struct JobAnchor {
        uint256 anchorId;
        string anchorType;
        string jobId;
        string traceId;
        string providerId;
        string capability;
        string status;
        string paymentRequestId;
        string paymentTxHash;
        string validationId;
        string referenceId;
        bytes32 payloadHash;
        string detailsURI;
        address publisher;
        uint64 createdAt;
    }

    mapping(uint256 => JobAnchor) private _anchorOf;
    mapping(bytes32 => bool) private _hasAnchorByJobIdHash;
    mapping(bytes32 => uint256) private _latestAnchorIdByJobIdHash;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event JobLifecycleAnchored(
        uint256 indexed anchorId,
        bytes32 indexed anchorTypeHash,
        bytes32 indexed jobIdHash,
        string anchorType,
        string jobId,
        string traceId,
        string providerId,
        string capability,
        string status,
        string paymentRequestId,
        string paymentTxHash,
        string validationId,
        string referenceId,
        bytes32 payloadHash,
        string detailsURI,
        address publisher
    );

    error NotOwner();
    error InvalidOwner();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidOwner();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidOwner();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function publishJobLifecycleAnchor(
        string calldata anchorType,
        string calldata jobId,
        string calldata traceId,
        string calldata providerId,
        string calldata capability,
        string calldata status,
        string calldata paymentRequestId,
        string calldata paymentTxHash,
        string calldata validationId,
        string calldata referenceId,
        bytes32 payloadHash,
        string calldata detailsURI
    ) external onlyOwner returns (uint256 anchorId) {
        anchorId = _nextAnchorId;
        _nextAnchorId += 1;

        _anchorOf[anchorId] = JobAnchor({
            anchorId: anchorId,
            anchorType: anchorType,
            jobId: jobId,
            traceId: traceId,
            providerId: providerId,
            capability: capability,
            status: status,
            paymentRequestId: paymentRequestId,
            paymentTxHash: paymentTxHash,
            validationId: validationId,
            referenceId: referenceId,
            payloadHash: payloadHash,
            detailsURI: detailsURI,
            publisher: msg.sender,
            createdAt: uint64(block.timestamp)
        });

        bytes32 jobIdHash = keccak256(bytes(jobId));
        _hasAnchorByJobIdHash[jobIdHash] = true;
        _latestAnchorIdByJobIdHash[jobIdHash] = anchorId;

        emit JobLifecycleAnchored(
            anchorId,
            keccak256(bytes(anchorType)),
            jobIdHash,
            anchorType,
            jobId,
            traceId,
            providerId,
            capability,
            status,
            paymentRequestId,
            paymentTxHash,
            validationId,
            referenceId,
            payloadHash,
            detailsURI,
            msg.sender
        );
    }

    function hasAnchor(string calldata jobId) external view returns (bool) {
        return _hasAnchorByJobIdHash[keccak256(bytes(jobId))];
    }

    function latestAnchorId(string calldata jobId) external view returns (uint256) {
        return _latestAnchorIdByJobIdHash[keccak256(bytes(jobId))];
    }

    function getJobAnchor(uint256 anchorId)
        external
        view
        returns (
            string memory anchorType,
            string memory jobId,
            string memory traceId,
            string memory providerId,
            string memory capability,
            string memory status,
            string memory paymentRequestId,
            string memory paymentTxHash,
            string memory validationId,
            string memory referenceId,
            bytes32 payloadHash,
            string memory detailsURI,
            address publisher,
            uint64 createdAt
        )
    {
        JobAnchor storage anchor = _anchorOf[anchorId];
        return (
            anchor.anchorType,
            anchor.jobId,
            anchor.traceId,
            anchor.providerId,
            anchor.capability,
            anchor.status,
            anchor.paymentRequestId,
            anchor.paymentTxHash,
            anchor.validationId,
            anchor.referenceId,
            anchor.payloadHash,
            anchor.detailsURI,
            anchor.publisher,
            anchor.createdAt
        );
    }
}
