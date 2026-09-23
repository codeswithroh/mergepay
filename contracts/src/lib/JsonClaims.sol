// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal claim reader for compact JSON objects (JWT headers/payloads).
/// @dev Looks for the literal `"key":"` (or `"key":` for numbers). Inside a JSON string value
///      every quote is escaped as `\"`, so the unescaped pattern `"key":"` cannot occur inside a
///      value — it can only match a real top-level key. Values containing a backslash are rejected
///      outright, so we never have to interpret escape sequences.
library JsonClaims {
    error ClaimMissing(string key);
    error ClaimEscaped(string key);
    error ClaimNotNumber(string key);

    function getString(bytes memory json, string memory key) internal pure returns (bytes memory value) {
        uint256 start = _find(json, abi.encodePacked('"', key, '":"'));
        if (start == type(uint256).max) revert ClaimMissing(key);

        uint256 n = json.length;
        uint256 end = n;
        bool escaped;
        assembly {
            let base := add(json, 32)
            for { let i := start } lt(i, n) { i := add(i, 1) } {
                let c := byte(0, mload(add(base, i)))
                if eq(c, 0x22) {
                    end := i
                    break
                }
                if eq(c, 0x5c) {
                    escaped := 1
                    break
                }
            }
        }
        if (escaped) revert ClaimEscaped(key);
        if (end == n) revert ClaimMissing(key);

        uint256 vlen = end - start;
        value = new bytes(vlen);
        assembly {
            mcopy(add(value, 32), add(add(json, 32), start), vlen)
        }
    }

    function getUint(bytes memory json, string memory key) internal pure returns (uint256 v) {
        uint256 i = _find(json, abi.encodePacked('"', key, '":'));
        if (i == type(uint256).max) revert ClaimMissing(key);
        uint256 n = json.length;
        uint256 digits;
        while (i < n) {
            uint8 c = uint8(json[i]);
            if (c < 48 || c > 57) break;
            v = v * 10 + (c - 48);
            ++i;
            ++digits;
        }
        if (digits == 0) revert ClaimNotNumber(key);
    }

    /// @notice Parses a claim that GitHub encodes as a decimal string, e.g. `"actor_id":"583231"`.
    function getDecimalString(bytes memory json, string memory key) internal pure returns (uint256 v) {
        bytes memory s = getString(json, key);
        if (s.length == 0 || s.length > 77) revert ClaimNotNumber(key);
        for (uint256 i; i < s.length; ++i) {
            uint8 c = uint8(s[i]);
            if (c < 48 || c > 57) revert ClaimNotNumber(key);
            v = v * 10 + (c - 48);
        }
    }

    function eq(bytes memory json, string memory key, bytes memory expected) internal pure returns (bool) {
        return keccak256(getString(json, key)) == keccak256(expected);
    }

    /// @return index just past the match, or type(uint256).max if not found.
    function _find(bytes memory data, bytes memory pat) private pure returns (uint256) {
        uint256 n = data.length;
        uint256 m = pat.length;
        if (m > n) return type(uint256).max;
        bytes32 patHash = keccak256(pat);
        uint256 found = type(uint256).max;
        assembly {
            let p := add(data, 32)
            let last := add(p, sub(n, m))
            for {} iszero(gt(p, last)) { p := add(p, 1) } {
                if eq(byte(0, mload(p)), 0x22) {
                    if eq(keccak256(p, m), patHash) {
                        found := add(sub(p, add(data, 32)), m)
                        break
                    }
                }
            }
        }
        return found;
    }
}
