// Snapshot GitHub Actions' OIDC signing keys into script/jwks.json for Deploy.s.sol / SyncKeys.s.sol.
import { writeFileSync } from "node:fs";

const res = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks");
const { keys } = await res.json();
const out = keys
  .filter((k) => k.kty === "RSA" && k.e === "AQAB")
  .map((k) => ({ kid: k.kid, modulus: "0x" + Buffer.from(k.n, "base64url").toString("hex") }));
writeFileSync(new URL("../script/jwks.json", import.meta.url), JSON.stringify({ keys: out }, null, 2));
console.log(`wrote ${out.length} keys:`, out.map((k) => k.kid).join(", "));
