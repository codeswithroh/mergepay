// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {MergePay} from "../src/MergePay.sol";

struct Key {
    string kid;
    bytes modulus;
}

abstract contract KeysScript is Script {
    function loadKeys() internal view returns (string[] memory kids, bytes[] memory moduli) {
        Key[] memory keys = abi.decode(vm.parseJson(vm.readFile("script/jwks.json"), ".keys"), (Key[]));
        kids = new string[](keys.length);
        moduli = new bytes[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            kids[i] = keys[i].kid;
            moduli[i] = keys[i].modulus;
        }
    }
}

/// node scripts/fetch-jwks.mjs
/// OWNER=0x... forge script script/Deploy.s.sol --tc Deploy --rpc-url arc --broadcast --private-key ...
/// GitHub's current keys go into the constructor and are trusted immediately.
contract Deploy is KeysScript {
    function run() external returns (MergePay mp) {
        (string[] memory kids, bytes[] memory moduli) = loadKeys();
        vm.startBroadcast();
        address owner = vm.envOr("OWNER", msg.sender);
        mp = new MergePay(owner, kids, moduli);
        vm.stopBroadcast();
        console.log("MergePay deployed at", address(mp));
        console.log("owner", owner);
    }
}

/// Announce any GitHub key the contract doesn't trust yet. After KEY_DELAY, anyone can call
/// activateSigningKey(kid) for each.
/// MERGEPAY=0x... forge script script/Deploy.s.sol --tc SyncKeys --rpc-url arc --broadcast --private-key ...
contract SyncKeys is KeysScript {
    function run() external {
        MergePay mp = MergePay(vm.envAddress("MERGEPAY"));
        (string[] memory kids, bytes[] memory moduli) = loadKeys();
        vm.startBroadcast();
        for (uint256 i; i < kids.length; ++i) {
            if (keccak256(mp.signingKeys(keccak256(bytes(kids[i])))) != keccak256(moduli[i])) {
                mp.proposeSigningKey(kids[i], moduli[i]);
                console.log("proposed", kids[i]);
            }
        }
        vm.stopBroadcast();
    }
}
