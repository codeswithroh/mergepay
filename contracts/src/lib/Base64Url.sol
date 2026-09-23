// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Unpadded base64url decoder (RFC 4648 §5), as used by JWTs.
library Base64Url {
    error InvalidBase64();

    /// 128-entry reverse lookup; 0xff marks characters outside the base64url alphabet.
    bytes private constant TABLE =
        hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        hex"ffffffffffffffffffffffffff3effff3435363738393a3b3c3dffffffffffff"
        hex"ff000102030405060708090a0b0c0d0e0f10111213141516171819ffffffff3f"
        hex"ff1a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30313233ffffffffff";

    function decode(bytes memory s) internal pure returns (bytes memory out) {
        uint256 len = s.length;
        if (len % 4 == 1) revert InvalidBase64();
        out = new bytes((len * 3) / 4);
        bytes memory table = TABLE;
        bool bad;

        assembly {
            let tbl := add(table, 1) // mload(tbl + c) low byte = table[c]
            let src := add(s, 32)
            let end := add(src, len)
            let dst := add(out, 32)
            let full := add(src, mul(div(len, 4), 4))

            // 4 chars -> 3 bytes
            for {} lt(src, full) { src := add(src, 4) } {
                let w := mload(src)
                let c0 := byte(0, w)
                let c1 := byte(1, w)
                let c2 := byte(2, w)
                let c3 := byte(3, w)
                bad := or(bad, gt(or(or(c0, c1), or(c2, c3)), 0x7f))
                let v0 := and(mload(add(tbl, c0)), 0xff)
                let v1 := and(mload(add(tbl, c1)), 0xff)
                let v2 := and(mload(add(tbl, c2)), 0xff)
                let v3 := and(mload(add(tbl, c3)), 0xff)
                bad := or(bad, eq(or(or(v0, v1), or(v2, v3)), 0xff))
                let n := or(or(shl(18, v0), shl(12, v1)), or(shl(6, v2), v3))
                mstore8(dst, shr(16, n))
                mstore8(add(dst, 1), and(shr(8, n), 0xff))
                mstore8(add(dst, 2), and(n, 0xff))
                dst := add(dst, 3)
            }

            // tail: 2 chars -> 1 byte, 3 chars -> 2 bytes
            let rem := sub(end, src)
            if rem {
                let w := mload(src)
                let c0 := byte(0, w)
                let c1 := byte(1, w)
                let c2 := byte(2, w)
                if lt(rem, 3) { c2 := 0x41 } // 'A' => 0
                bad := or(bad, gt(or(or(c0, c1), c2), 0x7f))
                let v0 := and(mload(add(tbl, c0)), 0xff)
                let v1 := and(mload(add(tbl, c1)), 0xff)
                let v2 := and(mload(add(tbl, c2)), 0xff)
                bad := or(bad, eq(or(or(v0, v1), v2), 0xff))
                let n := or(or(shl(18, v0), shl(12, v1)), shl(6, v2))
                mstore8(dst, shr(16, n))
                if eq(rem, 3) { mstore8(add(dst, 1), and(shr(8, n), 0xff)) }
            }
        }
        if (bad) revert InvalidBase64();
    }
}
