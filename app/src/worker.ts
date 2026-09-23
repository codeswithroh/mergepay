// MergePay relayer + static site.
//
// The relayer is deliberately dumb: it cannot forge anything. It takes a GitHub OIDC token that a
// workflow minted, splits it into (signingInput, signature), simulates the call, and pays the gas.
// For awards it is reimbursed from the bounty's relayer fee. Anyone can run one.

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { abi } from "./abi";

interface Env {
  ASSETS: Fetcher;
  CONTRACT: string;
  DEPLOY_BLOCK: string;
  RPC_URL: string;
  EXPLORER: string;
  WORKFLOW_REPO: string;
  WORKFLOW_REF: string;
  RELAYER_KEY: string;
}

const arc = (rpc: string) =>
  defineChain({
    id: 5042,
    name: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: "Arcscan", url: "https://explorer.arc.io" } },
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

function splitJwt(token: unknown): { signingInput: Hex; signature: Hex } {
  if (typeof token !== "string") throw new Error("token missing");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("token is not a JWT");
  const signingInput = toHex(new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const signature = toHex(Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  return { signingInput, signature };
}

function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const d = revert.data;
      if (d?.errorName) return d.args?.length ? `${d.errorName}(${d.args.join(", ")})` : d.errorName;
      return revert.reason ?? revert.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

async function relay(env: Env, fn: "award" | "link", args: readonly unknown[]) {
  const chain = arc(env.RPC_URL);
  const account = privateKeyToAccount(env.RELAYER_KEY as Hex);
  const pub = createPublicClient({ chain, transport: http() });
  const wallet = createWalletClient({ chain, transport: http(), account });
  const address = getAddress(env.CONTRACT);

  // Simulate first so a bad token costs the relayer nothing.
  const { request } = await pub.simulateContract({ address, abi, functionName: fn, args: args as never, account });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, pollingInterval: 250 });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${txHash}`);
  return { txHash, logs: parseEventLogs({ abi, logs: receipt.logs }) };
}

async function handleAward(env: Env, body: any) {
  const { signingInput, signature } = splitJwt(body.token);
  const issue = BigInt(body.issue);
  const userId = BigInt(body.userId);
  const { txHash, logs } = await relay(env, "award", [signingInput, signature, issue, userId]);
  const awarded = logs.find((l) => l.eventName === "Awarded");
  const paid = logs.find((l) => l.eventName === "Paid");
  return {
    ok: true,
    txHash,
    payout: awarded ? formatUnits((awarded.args as any).payout, 18) : "0",
    delivered: Boolean(paid),
  };
}

async function handleLink(env: Env, body: any) {
  const { signingInput, signature } = splitJwt(body.token);
  if (!isAddress(body.wallet)) throw new Error("wallet must be an address");
  const { txHash, logs } = await relay(env, "link", [signingInput, signature, getAddress(body.wallet)]);
  const paid = logs.find((l) => l.eventName === "Paid");
  return { ok: true, txHash, delivered: paid ? formatUnits((paid.args as any).amount, 18) : "0" };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/config") {
      return json({
        contract: env.CONTRACT,
        deployBlock: env.DEPLOY_BLOCK,
        chainId: 5042,
        rpc: env.RPC_URL,
        explorer: env.EXPLORER,
        workflowRepo: env.WORKFLOW_REPO,
        workflowRef: env.WORKFLOW_REF,
        relayer: env.RELAYER_KEY ? privateKeyToAccount(env.RELAYER_KEY as Hex).address : null,
      });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" },
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/relay/")) {
      if (!env.RELAYER_KEY) return json({ ok: false, error: "relayer not configured" }, 503);
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "invalid json" }, 400);
      }
      try {
        if (url.pathname === "/api/relay/award") return json(await handleAward(env, body));
        if (url.pathname === "/api/relay/link") return json(await handleLink(env, body));
      } catch (err) {
        return json({ ok: false, error: revertReason(err) }, 422);
      }
    }

    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
