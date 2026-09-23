// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MergePay} from "../src/MergePay.sol";

contract MergePayTest is Test {
    MergePay mp;
    string fx;

    address owner = makeAddr("owner");
    address funder = makeAddr("funder");
    address relayer = makeAddr("relayer");
    address wallet;
    address wallet2;

    uint64 constant REPO = 123456;
    uint64 constant ISSUE = 42;
    uint64 constant ALICE = 1001;
    uint256 constant FEE = 0.01e18;

    function setUp() public {
        fx = vm.readFile("test/fixtures/tokens.json");
        address at = vm.parseJsonAddress(fx, ".contract");
        wallet = vm.parseJsonAddress(fx, ".wallet");
        wallet2 = vm.parseJsonAddress(fx, ".wallet2");

        deployCodeTo("MergePay.sol:MergePay", abi.encode(owner), at);
        mp = MergePay(at);

        vm.prank(owner);
        mp.setSigningKey(vm.parseJsonString(fx, ".kid"), vm.parseJsonBytes(fx, ".modulus"));

        vm.warp(vm.parseJsonUint(fx, ".t"));
        vm.deal(funder, 1_000e18);
    }

    function _tok(string memory name) internal view returns (bytes memory input, bytes memory sig) {
        input = vm.parseJsonBytes(fx, string.concat(".tokens.", name, ".signingInput"));
        sig = vm.parseJsonBytes(fx, string.concat(".tokens.", name, ".signature"));
    }

    function _fund(uint256 amount) internal returns (bytes32) {
        vm.prank(funder);
        return mp.fund{value: amount}(
            REPO, ISSUE, "acme/widgets", vm.parseJsonString(fx, ".workflow"), uint64(block.timestamp + 30 days), FEE
        );
    }

    function _award(string memory name) internal {
        (bytes memory input, bytes memory sig) = _tok(name);
        vm.prank(relayer);
        mp.award(input, sig, ISSUE, ALICE);
    }

    function _link(string memory name, address w) internal {
        (bytes memory input, bytes memory sig) = _tok(name);
        mp.link(input, sig, w);
    }

    // --- happy paths --------------------------------------------------------------------------

    function test_awardThenLink_paysOnLink() public {
        _fund(50e18);
        _award("award");

        assertEq(relayer.balance, FEE, "relayer reimbursed");
        assertEq(mp.pending(ALICE), 50e18 - FEE, "held until linked");

        _link("link", wallet);
        assertEq(wallet.balance, 50e18 - FEE, "paid on link");
        assertEq(mp.pending(ALICE), 0);
    }

    function test_linkThenAward_paysImmediately() public {
        _link("link", wallet);
        assertEq(mp.walletOf(ALICE), wallet);

        _fund(50e18);
        (bytes memory input, bytes memory sig) = _tok("award");
        vm.prank(relayer);
        uint256 g = gasleft();
        mp.award(input, sig, ISSUE, ALICE);
        emit log_named_uint("award gas", g - gasleft());

        assertEq(wallet.balance, 50e18 - FEE);
    }

    function test_topUpAndRefund() public {
        bytes32 id = _fund(10e18);
        address other = makeAddr("other");
        vm.deal(other, 5e18);
        vm.prank(other);
        mp.fund{value: 5e18}(REPO, ISSUE, "acme/widgets", "ignored", 0, 0);
        (uint256 amount,,,,,,) = mp.bounties(id);
        assertEq(amount, 15e18);

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadBounty.selector, "not expired"));
        mp.refund(id);

        vm.warp(block.timestamp + 31 days);
        vm.prank(other);
        mp.refund(id);
        assertEq(other.balance, 5e18);
    }

    function test_listBounties() public {
        _fund(10e18);
        vm.prank(funder);
        mp.fund{value: 1e18}(REPO, 7, "acme/widgets", "wf", uint64(block.timestamp + 1 days), 0);
        (bytes32[] memory ids, MergePay.Bounty[] memory data, string[] memory names) = mp.listBounties(0, 10);
        assertEq(ids.length, 2);
        assertEq(data[0].issue, 7, "newest first");
        assertEq(data[1].amount, 10e18);
        assertEq(names[1], "acme/widgets");
        (ids,,) = mp.listBounties(1, 10);
        assertEq(ids.length, 1);
        (ids,,) = mp.listBounties(5, 10);
        assertEq(ids.length, 0);
    }

    function test_relinkWithNewerToken() public {
        _link("link", wallet);
        _link("linkNewer", wallet2);
        assertEq(mp.walletOf(ALICE), wallet2);
    }

    // --- rejections -----------------------------------------------------------------------------

    function _expectAwardRevert(string memory name, bytes memory err) internal {
        _fund(50e18);
        (bytes memory input, bytes memory sig) = _tok(name);
        vm.expectRevert(err);
        mp.award(input, sig, ISSUE, ALICE);
    }

    function test_rejects_doubleAward() public {
        _fund(50e18);
        _award("award");
        (bytes memory input, bytes memory sig) = _tok("award");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadBounty.selector, "awarded"));
        mp.award(input, sig, ISSUE, ALICE);
    }

    function test_rejects_wrongWorkflow() public {
        _expectAwardRevert("awardWrongWorkflow", abi.encodeWithSelector(MergePay.BadToken.selector, "workflow"));
    }

    function test_rejects_wrongEvent() public {
        _expectAwardRevert("awardWrongEvent", abi.encodeWithSelector(MergePay.BadToken.selector, "event"));
    }

    function test_rejects_wrongRepo() public {
        _expectAwardRevert("awardWrongRepo", abi.encodeWithSelector(MergePay.BadBounty.selector, "unknown"));
    }

    function test_rejects_rogueKey() public {
        _expectAwardRevert("awardRogueKey", abi.encodeWithSelector(MergePay.BadToken.selector, "signature"));
    }

    function test_rejects_unknownKid() public {
        _expectAwardRevert("awardUnknownKid", abi.encodeWithSelector(MergePay.BadToken.selector, "kid"));
    }

    function test_rejects_algConfusion() public {
        _expectAwardRevert("awardHS256", abi.encodeWithSelector(MergePay.BadToken.selector, "alg"));
    }

    function test_rejects_wrongIssuer() public {
        _expectAwardRevert("awardWrongIssuer", abi.encodeWithSelector(MergePay.BadToken.selector, "iss"));
    }

    function test_rejects_smuggledClaim() public {
        _expectAwardRevert("awardSmuggled", abi.encodeWithSelector(MergePay.BadToken.selector, "aud"));
    }

    function test_rejects_expired() public {
        _fund(50e18);
        vm.warp(block.timestamp + 301);
        (bytes memory input, bytes memory sig) = _tok("award");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "expired"));
        mp.award(input, sig, ISSUE, ALICE);
    }

    function test_rejects_wrongRecipientOrIssue() public {
        _fund(50e18);
        (bytes memory input, bytes memory sig) = _tok("award");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "aud"));
        mp.award(input, sig, ISSUE, 666);
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "aud"));
        mp.award(input, sig, 43, ALICE);
    }

    function test_rejects_tamperedPayload() public {
        _fund(50e18);
        (bytes memory input, bytes memory sig) = _tok("award");
        input[input.length - 5] = input[input.length - 5] == "A" ? bytes1("B") : bytes1("A");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "signature"));
        mp.award(input, sig, ISSUE, ALICE);
    }

    function test_rejects_linkFromForeignRepo() public {
        (bytes memory input, bytes memory sig) = _tok("linkForeignRepo");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "owner"));
        mp.link(input, sig, wallet);
    }

    function test_rejects_linkWrongEvent() public {
        (bytes memory input, bytes memory sig) = _tok("linkWrongEvent");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "event"));
        mp.link(input, sig, wallet);
    }

    function test_rejects_linkToOtherWallet() public {
        (bytes memory input, bytes memory sig) = _tok("link");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "aud"));
        mp.link(input, sig, wallet2);
    }

    function test_rejects_staleLinkReplay() public {
        _link("linkNewer", wallet2);
        (bytes memory input, bytes memory sig) = _tok("link");
        vm.expectRevert(abi.encodeWithSelector(MergePay.BadToken.selector, "stale"));
        mp.link(input, sig, wallet);
    }

    function test_onlyOwnerSetsKeys() public {
        vm.expectRevert(MergePay.NotOwner.selector);
        mp.setSigningKey("x", hex"01");
    }
}
