// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice RSASSA-PKCS1-v1_5 / SHA-256 verification (JWT "RS256") using the MODEXP precompile.
library RsaSha256 {
    /// DER DigestInfo prefix for SHA-256 (RFC 8017 §9.2 note 1).
    bytes19 private constant DIGEST_INFO = 0x3031300d060960864801650304020105000420;
    uint256 private constant E = 65537;

    function verify(bytes32 digest, bytes memory sig, bytes memory modulus) internal view returns (bool) {
        uint256 len = modulus.length;
        if (len < 256 || sig.length != len) return false;

        (bool ok, bytes memory em) = address(0x05).staticcall(
            abi.encodePacked(len, uint256(32), len, sig, E, modulus)
        );
        if (!ok || em.length != len) return false;

        // EM = 0x00 || 0x01 || PS (0xff..., >= 8 bytes) || 0x00 || DigestInfo || H
        uint256 psLen = len - 3 - 19 - 32;
        bytes memory expected = new bytes(len);
        expected[1] = 0x01;
        for (uint256 i = 2; i < 2 + psLen; ++i) {
            expected[i] = 0xff;
        }
        uint256 off = 3 + psLen;
        assembly {
            let p := add(add(expected, 32), off)
            // bytes19 is left-aligned; write it, then overwrite the tail with the digest
            mstore(p, DIGEST_INFO)
            mstore(add(p, 19), digest)
        }
        return keccak256(em) == keccak256(expected);
    }
}
