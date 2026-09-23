// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base64Url} from "./lib/Base64Url.sol";
import {JsonClaims} from "./lib/JsonClaims.sol";
import {RsaSha256} from "./lib/RsaSha256.sol";

/// @title MergePay
/// @notice USDC bounties on GitHub issues, paid on merge. No backend, no bot key:
///         GitHub Actions' OIDC token (an RS256 JWT signed by GitHub) is the oracle, and this
///         contract verifies GitHub's signature on-chain.
///
///         On Arc, USDC is the native gas token, so bounties are held and paid as native value
///         (18 decimals). Contributors never need a second token, and the relayer that submits the
///         proof is reimbursed from the bounty itself.
///
/// Flow:
///   1. fund()  — anyone escrows USDC against (repository_id, issue), pinning the exact reusable
///                workflow (`job_workflow_ref`) that is allowed to award it.
///   2. link()  — a contributor proves "GitHub user #id controls wallet 0x…" by running a
///                workflow_dispatch job in a repo they own. Can happen before or after payout.
///   3. award() — when a PR closing the issue is merged, the pinned workflow mints an OIDC token
///                whose audience names the issue and PR author; anyone can submit it here.
contract MergePay {
    using JsonClaims for bytes;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    bytes private constant ISSUER = "https://token.actions.githubusercontent.com";
    bytes private constant ALG = "RS256";
    bytes private constant EVENT_MERGE = "pull_request_target";
    bytes private constant EVENT_LINK = "workflow_dispatch";

    /// Upper bound on the per-bounty relayer reimbursement (1 USDC, native 18 decimals).
    uint256 public constant MAX_RELAYER_FEE = 1e18;
    /// Tolerated clock skew for `nbf` (Arc timestamps are non-decreasing, sub-second blocks).
    uint256 private constant SKEW = 60;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    struct Bounty {
        uint256 amount; // escrowed native USDC (18 decimals)
        uint256 relayerFee; // paid to msg.sender of award(), capped at amount
        bytes32 workflowRefHash; // keccak256(job_workflow_ref) allowed to award
        uint64 repoId; // GitHub repository_id (stable across renames)
        uint64 issue;
        uint64 expiry; // after this, unawarded funds are refundable
        uint64 awardedTo; // GitHub user id; 0 = open
    }

    address public owner;

    /// keccak256(kid) => RSA modulus of a GitHub Actions OIDC signing key (e = 65537).
    mapping(bytes32 => bytes) public signingKeys;

    mapping(bytes32 => Bounty) public bounties;
    mapping(bytes32 => string) public repoNameOf;
    /// Every bounty ever opened, in creation order — lets a static frontend list bounties with a
    /// single view call instead of scanning logs.
    bytes32[] public bountyIds;
    mapping(bytes32 => mapping(address => uint256)) public contributions;

    /// GitHub user id => payout wallet.
    mapping(uint256 => address) public walletOf;
    /// GitHub user id => `iat` of the newest link token accepted (blocks replay of stale links).
    mapping(uint256 => uint256) public linkedAt;
    /// GitHub user id => USDC awarded but not yet delivered (no wallet linked, or delivery failed).
    mapping(uint256 => uint256) public pending;

    // ---------------------------------------------------------------------------------------------
    // Events / errors
    // ---------------------------------------------------------------------------------------------

    event SigningKeySet(string kid, bytes modulus);
    event OwnerChanged(address indexed owner);
    event Funded(
        bytes32 indexed bountyId,
        uint64 indexed repoId,
        uint64 issue,
        string repoName,
        address indexed funder,
        uint256 amount,
        uint256 total
    );
    event Refunded(bytes32 indexed bountyId, address indexed funder, uint256 amount);
    event Awarded(bytes32 indexed bountyId, uint64 indexed userId, uint256 payout, address relayer, uint256 fee);
    event Linked(uint64 indexed userId, string login, address wallet);
    event Paid(uint64 indexed userId, address indexed wallet, uint256 amount);

    error NotOwner();
    error BadToken(string reason);
    error BadBounty(string reason);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    // ---------------------------------------------------------------------------------------------
    // Admin: GitHub's JWKS. GitHub rotates keys rarely; the registry only lets the owner say
    // "this kid has this modulus", which anyone can check against
    // https://token.actions.githubusercontent.com/.well-known/jwks
    // ---------------------------------------------------------------------------------------------

    function setSigningKey(string calldata kid, bytes calldata modulus) external onlyOwner {
        signingKeys[keccak256(bytes(kid))] = modulus;
        emit SigningKeySet(kid, modulus);
    }

    function transferOwnership(address next) external onlyOwner {
        owner = next;
        emit OwnerChanged(next);
    }

    // ---------------------------------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------------------------------

    function bountyId(uint64 repoId, uint64 issue) public pure returns (bytes32) {
        return keccak256(abi.encode(repoId, issue));
    }

    /// @notice Escrow native USDC for an issue. The first funder sets the terms; later calls top up.
    /// @param workflowRef exact `job_workflow_ref` allowed to award, e.g.
    ///        `acme/mergepay/.github/workflows/award.yml` pinned to a tag or commit sha
    function fund(
        uint64 repoId,
        uint64 issue,
        string calldata repoName,
        string calldata workflowRef,
        uint64 expiry,
        uint256 relayerFee
    ) external payable returns (bytes32 id) {
        if (msg.value == 0) revert BadBounty("zero value");
        id = bountyId(repoId, issue);
        Bounty storage b = bounties[id];

        if (b.repoId == 0) {
            if (repoId == 0) revert BadBounty("repo");
            if (expiry <= block.timestamp) revert BadBounty("expiry");
            if (relayerFee > MAX_RELAYER_FEE) revert BadBounty("fee");
            b.repoId = repoId;
            b.issue = issue;
            b.expiry = expiry;
            b.relayerFee = relayerFee;
            b.workflowRefHash = keccak256(bytes(workflowRef));
            repoNameOf[id] = repoName;
            bountyIds.push(id);
        } else if (b.awardedTo != 0) {
            revert BadBounty("awarded");
        }

        b.amount += msg.value;
        contributions[id][msg.sender] += msg.value;
        emit Funded(id, repoId, issue, repoName, msg.sender, msg.value, b.amount);
    }

    function bountyCount() external view returns (uint256) {
        return bountyIds.length;
    }

    /// @notice Page through bounties, newest first.
    function listBounties(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory ids, Bounty[] memory data, string[] memory repoNames)
    {
        uint256 total = bountyIds.length;
        uint256 n = offset >= total ? 0 : total - offset;
        if (n > limit) n = limit;
        ids = new bytes32[](n);
        data = new Bounty[](n);
        repoNames = new string[](n);
        for (uint256 i; i < n; ++i) {
            bytes32 id = bountyIds[total - 1 - offset - i];
            ids[i] = id;
            data[i] = bounties[id];
            repoNames[i] = repoNameOf[id];
        }
    }

    /// @notice Reclaim your contribution once an unawarded bounty has expired.
    function refund(bytes32 id) external {
        Bounty storage b = bounties[id];
        if (b.awardedTo != 0) revert BadBounty("awarded");
        if (block.timestamp < b.expiry) revert BadBounty("not expired");
        uint256 amount = contributions[id][msg.sender];
        if (amount == 0) revert BadBounty("nothing");
        contributions[id][msg.sender] = 0;
        b.amount -= amount;
        _send(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Award on merge
    // ---------------------------------------------------------------------------------------------

    /// @notice Expected OIDC audience for an award token.
    function awardAudience(uint64 issue, uint64 userId) public view returns (string memory) {
        return string.concat("mergepay:", _hex(address(this)), ":", _dec(issue), ":", _dec(userId));
    }

    /// @param signingInput the first two JWT segments, `base64url(header).base64url(payload)`
    /// @param signature    the decoded third segment (raw RSA signature bytes)
    function award(bytes calldata signingInput, bytes calldata signature, uint64 issue, uint64 userId) external {
        if (userId == 0) revert BadToken("user");
        bytes memory claims = _verifyJwt(signingInput, signature);

        if (!claims.eq("event_name", EVENT_MERGE)) revert BadToken("event");
        if (!claims.eq("aud", bytes(awardAudience(issue, userId)))) revert BadToken("aud");

        uint256 repoId = claims.getDecimalString("repository_id");
        if (repoId > type(uint64).max) revert BadToken("repo");
        bytes32 id = bountyId(uint64(repoId), issue);
        Bounty storage b = bounties[id];
        if (b.repoId == 0) revert BadBounty("unknown");
        if (b.awardedTo != 0) revert BadBounty("awarded");
        if (b.amount == 0) revert BadBounty("empty");
        if (keccak256(claims.getString("job_workflow_ref")) != b.workflowRefHash) revert BadToken("workflow");

        b.awardedTo = userId;
        uint256 total = b.amount;
        uint256 fee = b.relayerFee < total ? b.relayerFee : total;
        uint256 payout = total - fee;

        emit Awarded(id, userId, payout, msg.sender, fee);
        pending[userId] += payout;
        if (fee != 0) _send(msg.sender, fee);
        _deliver(userId);
    }

    // ---------------------------------------------------------------------------------------------
    // Identity link: GitHub user id -> wallet
    // ---------------------------------------------------------------------------------------------

    function linkAudience(address wallet) public view returns (string memory) {
        return string.concat("mergepay-link:", _hex(address(this)), ":", _hex(wallet));
    }

    /// @notice Bind a GitHub account to a wallet using an OIDC token from a workflow_dispatch run in
    ///         a repository the account owns. Owner == actor stops a third party's repo from
    ///         minting link tokens that name someone else as actor.
    function link(bytes calldata signingInput, bytes calldata signature, address wallet) external {
        if (wallet == address(0)) revert BadToken("wallet");
        bytes memory claims = _verifyJwt(signingInput, signature);

        if (!claims.eq("event_name", EVENT_LINK)) revert BadToken("event");
        if (!claims.eq("aud", bytes(linkAudience(wallet)))) revert BadToken("aud");
        uint256 userId = claims.getDecimalString("actor_id");
        if (userId == 0 || userId > type(uint64).max) revert BadToken("actor");
        if (claims.getDecimalString("repository_owner_id") != userId) revert BadToken("owner");

        uint256 iat = claims.getUint("iat");
        if (iat <= linkedAt[userId]) revert BadToken("stale");
        linkedAt[userId] = iat;
        walletOf[userId] = wallet;

        emit Linked(uint64(userId), string(claims.getString("actor")), wallet);
        _deliver(userId);
    }

    /// @notice Push any pending balance to the linked wallet (e.g. after a failed delivery).
    function deliver(uint64 userId) external {
        _deliver(userId);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _verifyJwt(bytes calldata signingInput, bytes calldata signature)
        internal
        view
        returns (bytes memory claims)
    {
        uint256 dot = type(uint256).max;
        for (uint256 i; i < signingInput.length; ++i) {
            if (signingInput[i] == ".") {
                dot = i;
                break;
            }
        }
        if (dot == type(uint256).max) revert BadToken("format");

        bytes memory header = Base64Url.decode(signingInput[:dot]);
        if (!header.eq("alg", ALG)) revert BadToken("alg");
        bytes memory modulus = signingKeys[keccak256(header.getString("kid"))];
        if (modulus.length == 0) revert BadToken("kid");
        if (!RsaSha256.verify(sha256(signingInput), signature, modulus)) revert BadToken("signature");

        claims = Base64Url.decode(signingInput[dot + 1:]);
        if (!claims.eq("iss", ISSUER)) revert BadToken("iss");
        if (claims.getUint("exp") < block.timestamp) revert BadToken("expired");
        if (claims.getUint("nbf") > block.timestamp + SKEW) revert BadToken("nbf");
    }

    function _deliver(uint256 userId) internal {
        address wallet = walletOf[userId];
        uint256 amount = pending[userId];
        if (wallet == address(0) || amount == 0) return;
        pending[userId] = 0;
        // Arc native transfers can revert (e.g. blocklisted recipient); keep funds claimable.
        (bool ok,) = wallet.call{value: amount}("");
        if (!ok) {
            pending[userId] = amount;
            return;
        }
        emit Paid(uint64(userId), wallet, amount);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _hex(address a) internal pure returns (string memory) {
        bytes memory s = new bytes(42);
        s[0] = "0";
        s[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 41; i > 1; --i) {
            s[i] = bytes16("0123456789abcdef")[v & 0xf];
            v >>= 4;
        }
        return string(s);
    }

    function _dec(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory s = new bytes(len);
        for (; v != 0; v /= 10) s[--len] = bytes1(uint8(48 + v % 10));
        return string(s);
    }
}
