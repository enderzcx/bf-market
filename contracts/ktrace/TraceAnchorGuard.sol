// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ITraceAnchorGuard.sol";

interface IJobLifecycleAnchorLookup {
    function hasAnchor(string calldata jobId) external view returns (bool);
}

contract TraceAnchorGuard is ITraceAnchorGuard {
    address public immutable registry;

    constructor(address registry_) {
        require(registry_ != address(0), "registry_required");
        registry = registry_;
    }

    function assertAnchorExists(string calldata jobId) external view override {
        require(IJobLifecycleAnchorLookup(registry).hasAnchor(jobId), "trace_anchor_required");
    }
}
