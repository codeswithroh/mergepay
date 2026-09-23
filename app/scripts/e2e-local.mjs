// End-to-end against anvil (--chain-id 5042) + `wrangler dev`: deploy, fund, then push GitHub-shaped
// OIDC tokens (signed by a local key registered as a GitHub kid) through the relayer.
// Usage: anvil --chain-id 5042 & npx wrangler dev --var CONTRACT:<addr> ... ; node scripts/e2e-local.mjs
import { generateKeyPairSync, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "http://127.0.0.1:8545";
const RELAYER = process.env.RELAYER ?? "http://127.0.0.1:8787";
const WF = "codeswithroh/mergepay/.github/workflows/award.yml@refs/tags/v1";
const chain = defineChain({ id: 5042, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const funder = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const pub = createPublicClient({ chain, transport: http() });
const w = (account) => createWalletClient({ chain, transport: http(), account });

const art = JSON.parse(readFileSync(new URL("../../contracts/out/MergePay.sol/MergePay.json", import.meta.url)));
const { abi } = art;

let address = process.env.CONTRACT;
if (!address) {
  const hash = await w(owner).deployContract({ abi, bytecode: art.bytecode.object, args: [owner.address] });
  address = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  console.log(`deployed ${address}\nnow start: npx wrangler dev --var CONTRACT:${address} --var RPC_URL:${RPC}\nthen rerun with CONTRACT=${address}`);
  process.exit(0);
}

const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = `local-${Date.now()}`;
const modulus = "0x" + Buffer.from(key.publicKey.export({ format: "jwk" }).n, "base64url").toString("hex");
await pub.waitForTransactionReceipt({ hash: await w(owner).writeContract({ address, abi, functionName: "setSigningKey", args: [kid, modulus] }) });

const issue = BigInt(process.env.ISSUE ?? Math.floor(Math.random() * 1e6));
const repoId = BigInt(process.env.REPO_ID ?? 123456);
const repoName = process.env.REPO ?? "acme/widgets";
const userId = process.env.USER_ID ?? "1001";
const login = process.env.LOGIN ?? "alice";
const now = Number((await pub.getBlock()).timestamp);
await pub.waitForTransactionReceipt({
  hash: await w(funder).writeContract({
    address, abi, functionName: "fund",
    args: [repoId, issue, repoName, WF, BigInt(now + 86400), parseUnits("0.03", 18)],
    value: parseUnits("25", 18),
  }),
});
console.log(`funded ${repoName}#${issue} with 25 USDC`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims) {
  const input = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64({
    iss: "https://token.actions.githubusercontent.com", nbf: now - 5, iat: now, exp: now + 300,
    repository_id: String(repoId), repository: repoName, repository_owner_id: "9001",
    actor_id: userId, actor: login, job_workflow_ref: WF, ...claims,
  })}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(key.privateKey).toString("base64url")}`;
}
const post = (path, body) =>
  fetch(`${RELAYER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const wallet = privateKeyToAccount("0x" + "ab".repeat(32)).address;
const lc = address.toLowerCase();

console.log("forged award (wrong workflow):", await post("/api/relay/award", {
  token: jwt({ aud: `mergepay:${lc}:${issue}:${userId}`, event_name: "pull_request_target", job_workflow_ref: "evil/x/.github/workflows/a.yml@main" }),
  issue: String(issue), userId,
}));

let t0 = Date.now();
console.log("award:", await post("/api/relay/award", {
  token: jwt({ aud: `mergepay:${lc}:${issue}:${userId}`, event_name: "pull_request_target" }),
  issue: String(issue), userId,
}), `${Date.now() - t0}ms`);

t0 = Date.now();
console.log("link:", await post("/api/relay/link", {
  token: jwt({ aud: `mergepay-link:${lc}:${wallet.toLowerCase()}`, event_name: "workflow_dispatch", repository_owner_id: userId, iat: now + Math.floor(Math.random() * 1000) }),
  wallet,
}), `${Date.now() - t0}ms`);

console.log(`alice wallet balance: ${formatUnits(await pub.getBalance({ address: wallet }), 18)} USDC`);
