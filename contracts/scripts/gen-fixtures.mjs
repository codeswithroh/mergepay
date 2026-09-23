// Generates GitHub-Actions-shaped OIDC JWTs signed by a throwaway RSA key, for forge tests.
// Usage: node scripts/gen-fixtures.mjs
import { generateKeyPairSync, createSign } from "node:crypto";
import { writeFileSync } from "node:fs";

const CONTRACT = "0x4d65726765506179000000000000000000000001"; // "MergePay" + 1, used via deployCodeTo
const WALLET = "0x000000000000000000000000000000000000a11c";
const WALLET2 = "0x000000000000000000000000000000000000b0b0";
const T = 1_790_000_000; // tests vm.warp here
const KID = "test-kid-1";
const WORKFLOW = "mergepay-xyz/mergepay/.github/workflows/award.yml@refs/tags/v1";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
const modulus = Buffer.from(key.publicKey.export({ format: "jwk" }).n, "base64url");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function base(extra) {
  // Field set and order mirror a real token.actions.githubusercontent.com token.
  return {
    jti: "9f2c1d7e-2b4a-4e1b-9c55-1c1f5d6e7a88",
    sub: "repo:acme/widgets:pull_request",
    aud: "",
    ref: "refs/heads/main",
    sha: "4f2d0c6a1b9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c",
    repository: "acme/widgets",
    repository_owner: "acme",
    repository_owner_id: "9001",
    run_id: "11223344556",
    run_number: "17",
    run_attempt: "1",
    repository_visibility: "public",
    repository_id: "123456",
    actor_id: "1001",
    actor: "alice",
    workflow: "MergePay",
    head_ref: "fix-42",
    base_ref: "main",
    event_name: "pull_request_target",
    ref_protected: "true",
    ref_type: "branch",
    workflow_ref: "acme/widgets/.github/workflows/mergepay.yml@refs/heads/main",
    workflow_sha: "4f2d0c6a1b9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c",
    job_workflow_ref: WORKFLOW,
    job_workflow_sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
    runner_environment: "github-hosted",
    iss: "https://token.actions.githubusercontent.com",
    nbf: T - 5,
    exp: T + 300,
    iat: T,
    ...extra,
  };
}

function sign(claims, { signer = key, header = {} } = {}) {
  const h = { alg: "RS256", kid: KID, typ: "JWT", x5t: "ykNaY4qM_ta4k2TgZOCEYLkcYlA", ...header };
  const input = `${b64(h)}.${b64(claims)}`;
  const sig = createSign("RSA-SHA256").update(input).sign(signer.privateKey);
  return { signingInput: "0x" + Buffer.from(input).toString("hex"), signature: "0x" + sig.toString("hex") };
}

const award = (issue, user, extra = {}) => base({ aud: `mergepay:${CONTRACT}:${issue}:${user}`, ...extra });
const link = (wallet, extra = {}) =>
  base({
    aud: `mergepay-link:${CONTRACT}:${wallet}`,
    event_name: "workflow_dispatch",
    repository: "alice/mergepay-link",
    repository_owner: "alice",
    repository_owner_id: "1001",
    repository_id: "777",
    job_workflow_ref: "alice/mergepay-link/.github/workflows/link.yml@refs/heads/main",
    ...extra,
  });

const tokens = {
  award: sign(award(42, 1001)),
  awardWrongWorkflow: sign(award(42, 1001, { job_workflow_ref: "acme/widgets/.github/workflows/evil.yml@refs/heads/main" })),
  awardWrongEvent: sign(award(42, 1001, { event_name: "push" })),
  awardWrongRepo: sign(award(42, 1001, { repository_id: "999999" })),
  awardRogueKey: sign(award(42, 1001), { signer: rogue }),
  awardUnknownKid: sign(award(42, 1001), { header: { kid: "nope" } }),
  awardHS256: sign(award(42, 1001), { header: { alg: "HS256" } }),
  awardWrongIssuer: sign(award(42, 1001, { iss: "https://evil.example" })),
  // A value that tries to smuggle a second "aud" claim; must not be matched.
  awardSmuggled: sign(award(42, 1001, { aud: "x", head_ref: `a","aud":"mergepay:${CONTRACT}:42:1001` })),
  link: sign(link(WALLET)),
  linkNewer: sign(link(WALLET2, { iat: T + 10 })),
  linkForeignRepo: sign(link(WALLET, { repository_owner_id: "666", repository_owner: "mallory" })),
  linkWrongEvent: sign(link(WALLET, { event_name: "issue_comment" })),
};

writeFileSync(
  new URL("../test/fixtures/tokens.json", import.meta.url),
  JSON.stringify(
    {
      contract: CONTRACT,
      wallet: WALLET,
      wallet2: WALLET2,
      t: T,
      kid: KID,
      workflow: WORKFLOW,
      modulus: "0x" + modulus.toString("hex"),
      tokens,
    },
    null,
    2
  )
);
console.log("wrote test/fixtures/tokens.json");
