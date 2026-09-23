// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {MergePay} from "../src/MergePay.sol";

/// forge script script/Deploy.s.sol --rpc-url arc --broadcast --account <keystore>
/// Run `node scripts/fetch-jwks.mjs` first.
contract Deploy is Script {
    struct Key {
        string kid;
        bytes modulus;
    }

    function run() external returns (MergePay mp) {
        Key[] memory keys = abi.decode(vm.parseJson(vm.readFile("script/jwks.json"), ".keys"), (Key[]));
        vm.startBroadcast();
        mp = new MergePay(msg.sender);
        for (uint256 i; i < keys.length; ++i) {
            mp.setSigningKey(keys[i].kid, keys[i].modulus);
        }
        vm.stopBroadcast();
        console.log("MergePay deployed at", address(mp));
    }
}

/// MERGEPAY=0x... forge script script/Deploy.s.sol:SyncKeys --rpc-url arc --broadcast --account <keystore>
contract SyncKeys is Script {
    function run() external {
        MergePay mp = MergePay(vm.envAddress("MERGEPAY"));
        Deploy.Key[] memory keys =
            abi.decode(vm.parseJson(vm.readFile("script/jwks.json"), ".keys"), (Deploy.Key[]));
        vm.startBroadcast();
        for (uint256 i; i < keys.length; ++i) {
            if (keccak256(mp.signingKeys(keccak256(bytes(keys[i].kid)))) != keccak256(keys[i].modulus)) {
                mp.setSigningKey(keys[i].kid, keys[i].modulus);
            }
        }
        vm.stopBroadcast();
    }
}
