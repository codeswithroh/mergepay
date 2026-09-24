// Shared by the landing page and the app.
import { createPublicClient, defineChain, formatUnits, http } from "https://esm.sh/viem@2.56.8";
import { abi } from "/abi.js";
export { abi };

export const CLAIM_WINDOW = 180n * 86400n;
export const ZERO = "0x0000000000000000000000000000000000000000";
export const $ = (id) => document.getElementById(id);

export const cfg = await fetch("/api/config").then((r) => r.json());
export const chain = defineChain({
  id: cfg.chainId,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  blockExplorers: { default: { name: "Arcscan", url: cfg.explorer } },
});
export const pub = createPublicClient({ chain, transport: http(cfg.rpc) });
export const deployed = Boolean(cfg.contract) && cfg.contract !== ZERO;
export const tag = cfg.workflowRef.split("@refs/tags/")[1] ?? cfg.workflowRef.split("@")[1];

export const usd = (wei, dp = 2) => {
  const n = typeof wei === "bigint" ? Number(formatUnits(wei, 18)) : Number(wei);
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ago(ts) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove("show"), 2200);
}

export async function gh(path) {
  const key = `gh:${path}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) return JSON.parse(hit);
  } catch {}
  const r = await fetch(`https://api.github.com/${path}`, { headers: { accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(r.status === 404 ? "not found on GitHub" : `GitHub API ${r.status}`);
  const data = await r.json();
  try {
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch {}
  return data;
}

/** All bounties with a derived status, newest first. */
export async function loadBounties(limit = 100n) {
  if (!deployed) return [];
  const [ids, data, names] = await pub.readContract({
    address: cfg.contract,
    abi,
    functionName: "listBounties",
    args: [0n, limit],
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const users = [...new Set(data.filter((b) => b.awardedTo !== 0n).map((b) => b.awardedTo))];
  const pending = new Map(
    await Promise.all(users.map(async (u) => [u, await pub.readContract({ address: cfg.contract, abi, functionName: "pending", args: [u] })]))
  );
  return data.map((b, i) => {
    let status = "open";
    if (b.returned > 0n) status = "returned";
    else if (b.awardedTo !== 0n) status = pending.get(b.awardedTo) > 0n ? "held" : "paid";
    else if (b.expiry <= now) status = "expired";
    const fee = b.relayerFee < b.amount ? b.relayerFee : b.amount;
    const claimDeadline = b.awardedAt + CLAIM_WINDOW;
    return {
      id: ids[i], repo: names[i], ...b, status, payout: b.amount - fee,
      daysLeft: Number((b.expiry - now) / 86400n),
      claimDaysLeft: b.awardedTo ? Math.max(0, Number((claimDeadline - now) / 86400n)) : null,
      returnable: status === "held" && now >= claimDeadline,
    };
  });
}

export function statusPill(b) {
  switch (b.status) {
    case "paid": return `<span class="pill paid">Paid</span>`;
    case "held": return `<span class="pill held">Awarded · link wallet · ${b.claimDaysLeft}d</span>`;
    case "returned": return `<span class="pill expired">Unclaimed · returned</span>`;
    case "expired": return `<span class="pill expired">Expired · refundable</span>`;
    default: return `<span class="pill open">Open · ${b.daysLeft}d left</span>`;
  }
}

export function totals(bounties) {
  let open = 0n, paid = 0n;
  for (const b of bounties) {
    if (b.status === "open") open += b.amount;
    if (b.status === "paid" || b.status === "held") paid += b.payout;
  }
  return { open, paid, count: bounties.length };
}

/** Fill issue titles into any element carrying data-title="owner/repo#n". */
export function fillTitles(root = document) {
  root.querySelectorAll("[data-title]").forEach((el) => {
    const [repo, n] = el.dataset.title.split("#");
    gh(`repos/${repo}/issues/${n}`).then((i) => (el.textContent = i.title)).catch(() => {});
  });
}
