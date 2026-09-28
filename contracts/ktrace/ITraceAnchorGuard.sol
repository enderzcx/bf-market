// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITraceAnchorGuard {
    function assertAnchorExists(string calldata jobId) external view;
}
