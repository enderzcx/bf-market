// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./ITraceAnchorGuard.sol";

/**
 * @title JobEscrowV4
 * @notice ERC-8183 escrow with open executor support.
 *         When executor is address(0) at lockFunds, any agent can claimJob first-come-first-served.
 */
contract JobEscrowV4 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobState {
        None,
        Funded,
        Accepted,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address requester;
        address executor;
        address validator;
        uint256 amount;
        uint256 executorStakeAmount;
        JobState state;
        bytes32 resultHash;
        uint64 deadlineAt;
        uint64 fundedAt;
        uint64 acceptedAt;
        uint64 submittedAt;
        uint64 resolvedAt;
        uint64 stakeFundedAt;
    }

    IERC20 public immutable settlementToken;
    address public owner;
    address public traceAnchorGuard;

    // Timelock for trace anchor guard changes (48 hours)
    uint256 public constant GUARD_CHANGE_DELAY = 48 hours;
    address public pendingTraceAnchorGuard;
    uint256 public guardChangeReadyAt;

    mapping(string => Job) private jobs;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TraceAnchorGuardSet(address indexed guard);
    event TraceAnchorGuardChangeProposed(address indexed currentGuard, address indexed proposedGuard, uint256 readyAt);
    event TraceAnchorGuardChangeCancelled(address indexed proposedGuard);
    event JobFundsLocked(
        string indexed jobId,
        address indexed requester,
        address indexed executor,
        address validator,
        uint256 amount,
        uint64 deadlineAt,
        uint256 executorStakeAmount
    );
    event JobExecutorClaimed(string indexed jobId, address indexed executor);
    event JobStakeLocked(string indexed jobId, address indexed executor, uint256 amount);
    event JobAccepted(string indexed jobId, address indexed executor, uint256 executorStakeAmount);
    event JobSubmitted(string indexed jobId, bytes32 indexed resultHash);
    event JobValidated(
        string indexed jobId,
        bool indexed approved,
        address recipient,
        uint256 escrowAmount,
        uint256 executorStakeAmount
    );
    event JobExpired(
        string indexed jobId,
        address indexed recipient,
        uint256 escrowAmount,
        uint256 executorStakeAmount
    );
    event JobSlashed(string indexed jobId, address indexed recipient, uint256 executorStakeAmount, string reason);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner_only");
        _;
    }

    constructor(address settlementToken_, address initialOwner) {
        require(settlementToken_ != address(0), "token_required");
        require(initialOwner != address(0), "owner_required");
        settlementToken = IERC20(settlementToken_);
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner_required");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Propose a new trace anchor guard. Takes effect after 48h delay.
    function proposeTraceAnchorGuard(address guard) external onlyOwner {
        pendingTraceAnchorGuard = guard;
        guardChangeReadyAt = block.timestamp + GUARD_CHANGE_DELAY;
        emit TraceAnchorGuardChangeProposed(traceAnchorGuard, guard, guardChangeReadyAt);
    }

    /// @notice Execute a pending guard change after the timelock expires.
    function executeTraceAnchorGuardChange() external onlyOwner {
        require(guardChangeReadyAt > 0, "no_pending_change");
        require(block.timestamp >= guardChangeReadyAt, "timelock_not_expired");
        address newGuard = pendingTraceAnchorGuard;
        traceAnchorGuard = newGuard;
        pendingTraceAnchorGuard = address(0);
        guardChangeReadyAt = 0;
        emit TraceAnchorGuardSet(newGuard);
    }

    /// @notice Cancel a pending guard change.
    function cancelTraceAnchorGuardChange() external onlyOwner {
        require(guardChangeReadyAt > 0, "no_pending_change");
        address cancelled = pendingTraceAnchorGuard;
        pendingTraceAnchorGuard = address(0);
        guardChangeReadyAt = 0;
        emit TraceAnchorGuardChangeCancelled(cancelled);
    }

    /// @notice Set guard immediately. Only works before the first guard is set.
    /// @dev After initial setup, use proposeTraceAnchorGuard + timelock path.
    function setTraceAnchorGuard(address guard) external onlyOwner {
        // Finding 21 fix: only allow direct set when no guard exists yet
        require(traceAnchorGuard == address(0), "Guard already set, use timelock path");
        traceAnchorGuard = guard;
        emit TraceAnchorGuardSet(guard);
    }

    /// @notice Lock escrow funds. executor may be address(0) for open jobs.
    function lockFunds(
        string calldata jobId,
        address requester,
        address executor,
        address validator,
        uint256 amount,
        uint64 deadlineAt,
        uint256 executorStakeAmount
    ) external nonReentrant {
        require(bytes(jobId).length > 0, "job_required");
        require(requester != address(0), "requester_required");
        // executor may be address(0) — open job, anyone can claim
        require(validator != address(0), "validator_required");
        require(msg.sender == requester, "requester_only");
        require(amount > 0, "amount_required");
        require(deadlineAt > block.timestamp, "deadline_required");

        Job storage job = jobs[jobId];
        require(job.state == JobState.None, "job_exists");

        settlementToken.safeTransferFrom(msg.sender, address(this), amount);

        job.requester = requester;
        job.executor = executor;
        job.validator = validator;
        job.amount = amount;
        job.executorStakeAmount = executorStakeAmount;
        job.state = JobState.Funded;
        job.deadlineAt = deadlineAt;
        job.fundedAt = uint64(block.timestamp);

        emit JobFundsLocked(jobId, requester, executor, validator, amount, deadlineAt, executorStakeAmount);
    }

    /// @notice Claim an open job (executor == address(0)). First come first served.
    function claimJob(string calldata jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.state == JobState.Funded, "job_not_funded");
        require(job.executor == address(0), "executor_already_set");
        require(msg.sender != address(0), "invalid_claimer");
        require(!_deadlineReached(job), "job_expired");

        job.executor = msg.sender;
        emit JobExecutorClaimed(jobId, msg.sender);
    }

    function acceptJob(string calldata jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.state == JobState.Funded, "job_not_funded");
        require(job.executor != address(0), "executor_not_set");
        require(msg.sender == job.executor, "executor_only");
        require(!_deadlineReached(job), "job_expired");

        if (job.executorStakeAmount > 0) {
            settlementToken.safeTransferFrom(msg.sender, address(this), job.executorStakeAmount);
            job.stakeFundedAt = uint64(block.timestamp);
            emit JobStakeLocked(jobId, msg.sender, job.executorStakeAmount);
        }

        job.state = JobState.Accepted;
        job.acceptedAt = uint64(block.timestamp);
        emit JobAccepted(jobId, job.executor, job.executorStakeAmount);
    }

    function submitResult(string calldata jobId, bytes32 resultHash) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.state == JobState.Accepted, "job_not_accepted");
        require(msg.sender == job.executor, "executor_only");
        require(!_deadlineReached(job), "job_expired");
        require(resultHash != bytes32(0), "result_hash_required");

        if (traceAnchorGuard != address(0)) {
            ITraceAnchorGuard(traceAnchorGuard).assertAnchorExists(jobId);
        }

        job.state = JobState.Submitted;
        job.resultHash = resultHash;
        job.submittedAt = uint64(block.timestamp);
        emit JobSubmitted(jobId, resultHash);
    }

    function validate(string calldata jobId, bool approved) external nonReentrant {
        Job storage job = jobs[jobId];
        require(job.state == JobState.Submitted, "job_not_submitted");
        require(msg.sender == job.validator, "validator_only");
        require(!_deadlineReached(job), "job_expired");

        address recipient = approved ? job.executor : job.requester;
        uint256 payout = job.amount + job.executorStakeAmount;

        job.state = approved ? JobState.Completed : JobState.Rejected;
        job.resolvedAt = uint64(block.timestamp);

        settlementToken.safeTransfer(recipient, payout);
        if (!approved && job.executorStakeAmount > 0) {
            emit JobSlashed(jobId, recipient, job.executorStakeAmount, "validator_rejected");
        }
        emit JobValidated(jobId, approved, recipient, job.amount, job.executorStakeAmount);
    }

    function expireJob(string calldata jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        require(
            job.state == JobState.Funded || job.state == JobState.Accepted || job.state == JobState.Submitted,
            "job_not_active"
        );
        require(_deadlineReached(job), "deadline_not_reached");

        uint256 slashedStake = job.state == JobState.Funded ? 0 : job.executorStakeAmount;
        uint256 payout = job.amount + slashedStake;

        job.state = JobState.Expired;
        job.resolvedAt = uint64(block.timestamp);

        settlementToken.safeTransfer(job.requester, payout);
        if (slashedStake > 0) {
            emit JobSlashed(jobId, job.requester, slashedStake, "deadline_expired");
        }
        emit JobExpired(jobId, job.requester, job.amount, slashedStake);
    }

    function getJob(
        string calldata jobId
    )
        external
        view
        returns (
            address requester,
            address executor,
            address validator,
            uint256 amount,
            uint256 executorStakeAmount,
            uint8 state,
            bytes32 resultHash,
            uint64 deadlineAt,
            uint64 fundedAt,
            uint64 acceptedAt,
            uint64 submittedAt,
            uint64 resolvedAt,
            uint64 stakeFundedAt
        )
    {
        Job storage job = jobs[jobId];
        return (
            job.requester,
            job.executor,
            job.validator,
            job.amount,
            job.executorStakeAmount,
            uint8(job.state),
            job.resultHash,
            job.deadlineAt,
            job.fundedAt,
            job.acceptedAt,
            job.submittedAt,
            job.resolvedAt,
            job.stakeFundedAt
        );
    }

    function _deadlineReached(Job storage job) private view returns (bool) {
        return job.deadlineAt > 0 && block.timestamp > job.deadlineAt;
    }
}
