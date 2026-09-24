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
  fallback,
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
  FEED: KVNamespace;
  CONTRACT: string;
  DEPLOY_BLOCK: string;
  RPC_URL: string;
  RPC_FALLBACK?: string;
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

/** Arc's public RPC rate-limits shared Cloudflare egress IPs, so fall back to a second provider. */
const transport = (env: Env) =>
  fallback([env.RPC_URL, env.RPC_FALLBACK].filter(Boolean).map((u) => http(u, { retryCount: 2, retryDelay: 300 })));

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
  const pub = createPublicClient({ chain, transport: transport(env) });
  const wallet = createWalletClient({ chain, transport: transport(env), account });
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

// ---------------------------------------------------------------------------------------------
// Activity feed: a tiny KV-backed indexer. Arc produces ~2 blocks/s and its RPC caps eth_getLogs
// at a few thousand blocks, so a cron walks forward from a cursor and keeps the latest events.

type FeedItem = {
  kind: "funded" | "awarded" | "paid" | "linked" | "refunded" | "returned";
  ts: number;
  tx: string;
  repo?: string;
  issue?: number;
  amount?: string;
  user?: string;
};
type FeedState = { cursor: string; items: FeedItem[]; logins: Record<string, string>; updated: number };

const CHUNK = 5000n;
const MAX_CHUNKS = 25;
const KEEP = 40;
const ZERO = "0x0000000000000000000000000000000000000000";

async function indexFeed(env: Env): Promise<FeedState> {
  const prev = (await env.FEED.get<FeedState>(`state:${env.CONTRACT}`, "json")) ?? {
    cursor: env.DEPLOY_BLOCK || "0",
    items: [],
    logins: {},
    updated: 0,
  };
  if (!env.CONTRACT || env.CONTRACT === ZERO) return prev;

  const pub = createPublicClient({ chain: arc(env.RPC_URL), transport: transport(env) });
  const address = getAddress(env.CONTRACT);
  const latest = await pub.getBlockNumber();
  let from = BigInt(prev.cursor);
  const logs: ReturnType<typeof parseEventLogs<typeof abi>> = [];
  for (let i = 0; i < MAX_CHUNKS && from <= latest; i++) {
    const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
    // Arc's RPC rejects topic-filtered eth_getLogs ("range too large"), so filter by address only
    // and decode locally.
    logs.push(...parseEventLogs({ abi, logs: await pub.getLogs({ address, fromBlock: from, toBlock: to }) }));
    from = to + 1n;
  }

  const blockTs = new Map<bigint, number>();
  const tsOf = async (n: bigint) => {
    if (!blockTs.has(n)) blockTs.set(n, Number((await pub.getBlock({ blockNumber: n })).timestamp));
    return blockTs.get(n)!;
  };
  const logins = { ...prev.logins };
  const fresh: FeedItem[] = [];
  for (const log of logs) {
    const a = log.args as any;
    const base = { ts: await tsOf(log.blockNumber), tx: log.transactionHash };
    switch (log.eventName) {
      case "Funded":
        fresh.push({ ...base, kind: "funded", repo: a.repoName, issue: Number(a.issue), amount: formatUnits(a.amount, 18) });
        break;
      case "Awarded": {
        const [b, repo] = await Promise.all([
          pub.readContract({ address, abi, functionName: "bounties", args: [a.bountyId] }),
          pub.readContract({ address, abi, functionName: "repoNameOf", args: [a.bountyId] }),
        ]);
        fresh.push({ ...base, kind: "awarded", repo, issue: Number(b[4]), amount: formatUnits(a.payout, 18), user: String(a.userId) });
        break;
      }
      case "Paid":
        fresh.push({ ...base, kind: "paid", amount: formatUnits(a.amount, 18), user: String(a.userId) });
        break;
      case "Linked":
        logins[String(a.userId)] = a.login;
        fresh.push({ ...base, kind: "linked", user: String(a.userId) });
        break;
      case "Returned":
        fresh.push({ ...base, kind: "returned", amount: formatUnits(a.amount, 18), user: String(a.userId) });
        break;
      case "Refunded":
        fresh.push({ ...base, kind: "refunded", amount: formatUnits(a.amount, 18) });
        break;
    }
  }

  const next: FeedState = {
    cursor: from.toString(),
    items: [...fresh.reverse(), ...prev.items].slice(0, KEEP),
    logins,
    updated: Date.now(),
  };
  await env.FEED.put(`state:${env.CONTRACT}`, JSON.stringify(next));
  return next;
}

export default {
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(indexFeed(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Bounties for one repository, used by the claim workflows: GET /api/bounties?repo=<repository_id>
    if (url.pathname === "/api/bounties") {
      const repo = url.searchParams.get("repo");
      if (!repo || !/^\d+$/.test(repo)) return json({ error: "repo must be a numeric repository_id" }, 400);
      if (!env.CONTRACT || env.CONTRACT === ZERO) return json({ bounties: [] });
      const pub = createPublicClient({ chain: arc(env.RPC_URL), transport: transport(env) });
      const [, data] = await pub.readContract({ address: getAddress(env.CONTRACT), abi, functionName: "listBounties", args: [0n, 1000n] });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const bounties = data
        .filter((b) => b.repoId === BigInt(repo))
        .map((b) => ({
          issue: Number(b.issue),
          amount: formatUnits(b.amount, 18),
          status: b.awardedTo !== 0n ? "awarded" : b.expiry <= now ? "expired" : "open",
          expiry: Number(b.expiry),
        }));
      return json({ bounties });
    }

    if (url.pathname === "/api/feed") {
      let state = await env.FEED.get<FeedState>(`state:${env.CONTRACT}`, "json");
      // No cron in `wrangler dev`, and a cold KV on first deploy: index inline when stale.
      if (!state || Date.now() - state.updated > 90_000) {
        try {
          state = await indexFeed(env);
        } catch (e) {
          console.error("feed index failed", e);
          if (!state) return json({ items: [], error: String(e) });
        }
      }
      const items = state!.items.map((i) => ({ ...i, login: i.user ? state!.logins[i.user] : undefined }));
      return json({ items, updated: state!.updated });
    }

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
