// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract IdentityRegistryV1 is ERC721URIStorage, Ownable {
    using Strings for address;

    uint256 private _nextAgentId = 1;
    uint256 private _registerFee;
    uint256 private _metadataUpdateFee;

    mapping(uint256 => address) private _agentWalletOf;
    mapping(uint256 => bool) private _activeOf;
    mapping(uint256 => mapping(address => bool)) private _operatorApproval;

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI);
    event AgentWalletUpdated(uint256 indexed agentId, address indexed oldWallet, address indexed newWallet);
    event AgentURIUpdated(uint256 indexed agentId, string oldURI, string newURI);
    event AgentOperatorUpdated(uint256 indexed agentId, address indexed operator, bool allowed);
    event AgentStatusUpdated(uint256 indexed agentId, bool active);
    event RegisterFeeUpdated(uint256 oldFee, uint256 newFee);
    event MetadataUpdateFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeesWithdrawn(address indexed recipient, uint256 amount);

    error NotAgentAdmin();
    error InvalidWallet();
    error FeeTooLow(string feeName, uint256 expected, uint256 received);

    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner_,
        uint256 registerFee_,
        uint256 metadataUpdateFee_
    ) ERC721(name_, symbol_) Ownable(initialOwner_) {
        _registerFee = registerFee_;
        _metadataUpdateFee = metadataUpdateFee_;
    }

    modifier onlyAgentAdmin(uint256 agentId) {
        address owner = ownerOf(agentId);
        if (msg.sender != owner && !_operatorApproval[agentId][msg.sender]) {
            revert NotAgentAdmin();
        }
        _;
    }

    function registerFee() external view returns (uint256) {
        return _registerFee;
    }

    function metadataUpdateFee() external view returns (uint256) {
        return _metadataUpdateFee;
    }

    function setRegisterFee(uint256 newFee) external onlyOwner {
        uint256 oldFee = _registerFee;
        _registerFee = newFee;
        emit RegisterFeeUpdated(oldFee, newFee);
    }

    function setMetadataUpdateFee(uint256 newFee) external onlyOwner {
        uint256 oldFee = _metadataUpdateFee;
        _metadataUpdateFee = newFee;
        emit MetadataUpdateFeeUpdated(oldFee, newFee);
    }

    function register(string memory agentURI) external payable returns (uint256 agentId) {
        _requireFee("registerFee", _registerFee, msg.value);

        agentId = _nextAgentId;
        _nextAgentId += 1;

        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        _agentWalletOf[agentId] = msg.sender;
        _activeOf[agentId] = true;

        emit AgentRegistered(agentId, msg.sender, agentURI);
        emit AgentWalletUpdated(agentId, address(0), msg.sender);
        emit AgentURIUpdated(agentId, "", agentURI);
        emit AgentStatusUpdated(agentId, true);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        _requireOwned(agentId);
        return _agentWalletOf[agentId];
    }

    function isActive(uint256 agentId) external view returns (bool) {
        _requireOwned(agentId);
        return _activeOf[agentId];
    }

    function isOperatorFor(uint256 agentId, address operator) external view returns (bool) {
        _requireOwned(agentId);
        return _operatorApproval[agentId][operator];
    }

    function setAgentWallet(uint256 agentId, address newWallet) external payable onlyAgentAdmin(agentId) {
        if (newWallet == address(0)) revert InvalidWallet();
        _requireFee("metadataUpdateFee", _metadataUpdateFee, msg.value);

        address oldWallet = _agentWalletOf[agentId];
        _agentWalletOf[agentId] = newWallet;
        emit AgentWalletUpdated(agentId, oldWallet, newWallet);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external payable onlyAgentAdmin(agentId) {
        _requireOwned(agentId);
        _requireFee("metadataUpdateFee", _metadataUpdateFee, msg.value);

        string memory oldURI = tokenURI(agentId);
        _setTokenURI(agentId, newURI);
        emit AgentURIUpdated(agentId, oldURI, newURI);
    }

    function setOperator(uint256 agentId, address operator, bool allowed) external {
        if (ownerOf(agentId) != msg.sender) revert NotAgentAdmin();
        _operatorApproval[agentId][operator] = allowed;
        emit AgentOperatorUpdated(agentId, operator, allowed);
    }

    function activateAgent(uint256 agentId) external onlyAgentAdmin(agentId) {
        _setActive(agentId, true);
    }

    function deactivateAgent(uint256 agentId) external onlyAgentAdmin(agentId) {
        _setActive(agentId, false);
    }

    function withdrawFees(address payable recipient) external onlyOwner {
        address target = recipient == address(0) ? payable(owner()) : recipient;
        uint256 balance = address(this).balance;
        (bool ok, ) = target.call{value: balance}("");
        require(ok, "withdraw_failed");
        emit FeesWithdrawn(target, balance);
    }

    function getMetadataByName(uint256 agentId, string memory key) external view returns (string memory) {
        _requireOwned(agentId);
        bytes32 hashedKey = keccak256(bytes(key));

        if (hashedKey == keccak256("agentRegistry")) {
            return address(this).toHexString();
        }
        if (hashedKey == keccak256("agentWallet")) {
            return _agentWalletOf[agentId].toHexString();
        }
        if (hashedKey == keccak256("owner")) {
            return ownerOf(agentId).toHexString();
        }
        if (hashedKey == keccak256("active")) {
            return _activeOf[agentId] ? "true" : "false";
        }
        if (hashedKey == keccak256("agentURI") || hashedKey == keccak256("tokenURI")) {
            return tokenURI(agentId);
        }
        return "";
    }

    function _setActive(uint256 agentId, bool active) private {
        _requireOwned(agentId);
        _activeOf[agentId] = active;
        emit AgentStatusUpdated(agentId, active);
    }

    function _requireFee(string memory feeName, uint256 expected, uint256 received) private pure {
        if (received < expected) {
            revert FeeTooLow(feeName, expected, received);
        }
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address previousOwner = super._update(to, tokenId, auth);
        if (previousOwner != address(0) && previousOwner != to) {
            _clearRuntimeWallet(tokenId);
        }
        return previousOwner;
    }

    function _clearRuntimeWallet(uint256 tokenId) private {
        address oldWallet = _agentWalletOf[tokenId];
        if (oldWallet != address(0)) {
            _agentWalletOf[tokenId] = address(0);
            emit AgentWalletUpdated(tokenId, oldWallet, address(0));
        }
    }
}
