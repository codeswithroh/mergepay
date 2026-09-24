import { createWalletClient, custom, parseUnits, getAddress } from "https://esm.sh/viem@2.56.8";
import { $, ZERO, abi, cfg, chain, pub, deployed, tag, usd, esc, toast, gh, ago, short, loadBounties, statusPill, fillTitles, fillClaims } from "/common.js";

const origin = location.origin;
const LOGIN_KEY = "mp:login";
let account = null; // connected wallet
let wallet = null; // viem wallet client

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const status = (el, msg, kind = "") => {
  el.className = `status ${kind}`;
  el.innerHTML = msg;
};
const txLink = (hash, label) => `<a href="${cfg.explorer}/tx/${hash}" target="_blank" rel="noopener">${label ?? hash.slice(0, 10) + "…"}</a>`;
const isoAgo = (iso) => ago(Date.parse(iso) / 1000);
const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`;
const read = (functionName, args) => pub.readContract({ address: cfg.contract, abi, functionName, args });

// Cached per page load; refreshed after writes.
let bountiesP = null;
const bounties = (fresh = false) => (fresh || !bountiesP ? (bountiesP = loadBounties(200n).catch(() => [])) : bountiesP);
let feedP = null;
const feed = () => (feedP ??= fetch("/api/feed").then((r) => r.json()).then((d) => d.items ?? []).catch(() => []));

function byRepo(list) {
  const m = new Map();
  for (const b of list) {
    if (!m.has(b.repo)) m.set(b.repo, []);
    m.get(b.repo).push(b);
  }
  return m;
}

// =================================================================================================
// Tabs

const TABS = ["overview", "bounties", "fund", "wallet"];
const ALIAS = { link: "wallet", "": "overview" };
const rendered = new Set();

function route() {
  let t = location.hash.slice(1);
  t = ALIAS[t] ?? t;
  if (!TABS.includes(t)) t = "overview";
  for (const name of TABS) {
    $(`tab-${name}`).hidden = name !== t;
    document.querySelector(`[data-tab="${name}"]`).classList.toggle("on", name === t);
  }
  window.scrollTo(0, 0);
  if (!rendered.has(t)) {
    rendered.add(t);
    ({ overview: renderOverview, bounties: renderBounties, fund: renderFund, wallet: renderWallet })[t]();
  }
}
window.addEventListener("hashchange", route);

// =================================================================================================
// Identity: "view as" a GitHub user (public data only), plus an optional connected wallet

const login = () => store.get(LOGIN_KEY);

function setWhoami() {
  const l = login();
  const b = $("whoami");
  b.hidden = !l;
  if (l) b.textContent = `@${l} · switch`;
}
$("whoami").addEventListener("click", () => {
  store.set(LOGIN_KEY, null);
  rendered.clear();
  setWhoami();
  location.hash = "#overview";
  route();
});

$("signin-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const l = new FormData(ev.target).get("login").trim().replace(/^@/, "");
  const st = $("signin-status");
  status(st, "Looking you up on GitHub…");
  try {
    const u = await gh(`users/${l}`);
    store.set(LOGIN_KEY, u.login);
    status(st, "");
    rendered.clear();
    setWhoami();
    route();
  } catch (e) {
    status(st, esc(e.message), "err");
  }
});

async function connect() {
  if (!window.ethereum) {
    toast("No browser wallet found. Install MetaMask or Rabby.");
    return null;
  }
  const w = createWalletClient({ chain, transport: custom(window.ethereum) });
  const [addr] = await w.requestAddresses();
  try {
    await w.switchChain({ id: chain.id });
  } catch {
    await w.addChain({ chain });
    await w.switchChain({ id: chain.id });
  }
  account = getAddress(addr);
  wallet = w;
  $("connect").textContent = short(account);
  renderSnippets();
  renderSponsorships();
  return w;
}
$("connect").addEventListener("click", () => connect().catch((e) => toast(e.shortMessage || e.message)));

// =================================================================================================
// Overview

async function renderOverview() {
  const l = login();
  $("signin").hidden = Boolean(l);
  $("account").hidden = !l;
  renderRepos();
  renderSponsorships();
  if (!l) return;

  let user;
  try {
    user = await gh(`users/${l}`);
  } catch (e) {
    $("acct-login").textContent = `@${l} (${e.message})`;
    return;
  }
  $("acct-avatar").src = user.avatar_url;
  $("acct-login").textContent = `@${user.login}`;

  const uid = BigInt(user.id);
  const [all, [linked, pending]] = await Promise.all([
    bounties(),
    deployed ? Promise.all([read("walletOf", [uid]), read("pending", [uid])]) : Promise.resolve([ZERO, 0n]),
  ]);
  const mine = all.filter((b) => b.awardedTo === uid);
  const awardedTotal = mine.filter((b) => b.status !== "returned").reduce((s, b) => s + b.payout, 0n);
  const hasWallet = linked !== ZERO;

  $("acct-blurb").innerHTML = hasWallet
    ? `Viewing public data for GitHub user #${user.id}. Payouts go to <a class="mono" href="${cfg.explorer}/address/${linked}" target="_blank" rel="noopener">${short(linked)}</a>, the wallet GitHub proved you control. Merge a PR that closes a funded issue and the USDC arrives in the same minute.`
    : `Viewing public data for GitHub user #${user.id}. You haven't linked a payout wallet yet. Awards still count and wait safely in the contract. <a href="#wallet">Link a wallet →</a>`;
  $("a-earned").textContent = usd(awardedTotal - pending);
  $("a-pending").textContent = usd(pending);
  $("a-wallet").textContent = hasWallet ? short(linked) : "not linked";

  renderPayouts(mine, hasWallet);
  renderWip(user, all);
  renderActivity(user, mine);
}

function renderPayouts(mine, hasWallet) {
  $("pay-num").textContent = String(mine.length).padStart(2, "0");
  const held = mine.filter((b) => b.status === "held").length;
  $("pay-state").textContent = mine.length ? (held ? `${held} waiting on wallet` : "all paid") : "none yet";
  const el = $("payouts");
  if (!mine.length) {
    el.innerHTML = `<div class="empty-box"><b>No awards yet.</b><p><a href="#bounties">Pick a funded issue</a>, open a PR that says “Fixes #N”, and get it merged. It shows up here the moment GitHub's proof lands on Arc.</p></div>`;
    return;
  }
  el.innerHTML = mine
    .map((b) => {
      const paid = b.status === "paid";
      const last = paid
        ? "✔ Paid"
        : b.status === "returned"
          ? "↩ Unclaimed · returned"
          : hasWallet
            ? "… Delivering"
            : `○ Link wallet · ${b.claimDaysLeft}d left`;
      return `<div class="pipe">
        <div class="pipe-top">
          <a class="pipe-title" href="${issueUrl(b.repo, b.issue)}" target="_blank" rel="noopener" data-title="${esc(b.repo)}#${b.issue}">${esc(b.repo)}#${b.issue}</a>
          <span class="pipe-amt">${usd(b.payout)} USDC</span>
        </div>
        <div class="pipe-bar">
          <span class="on">✔ Merged</span><span class="on">✔ Awarded on Arc</span><span class="${paid ? "on" : "wait"}">${last}</span>
        </div>
      </div>`;
    })
    .join("");
  fillTitles(el);
}

const FIXES = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

async function renderWip(user, all) {
  const el = $("wip");
  const open = all.filter((b) => b.status === "open");
  const repos = [...new Set(open.map((b) => b.repo))].slice(0, 20);
  if (!repos.length) {
    $("wip-count").textContent = "no open bounties";
    el.innerHTML = `<div class="empty-box"><b>No open bounties right now.</b><p>Check back soon, or <a href="#fund">fund one yourself</a>.</p></div>`;
    return;
  }
  try {
    // Your own PRs, plus PRs a coding agent opened from a bot account and assigned to you.
    const scope = repos.map((r) => `repo:${r}`).join(" ");
    const [authored, assigned, claimedRes] = await Promise.all([
      ...[`author:${user.login}`, `assignee:${user.login}`].map((who) =>
        gh(`search/issues?q=${encodeURIComponent(`is:pr is:open ${who} ${scope}`)}&per_page=30`)
      ),
      gh(`search/issues?q=${encodeURIComponent(`is:issue is:open assignee:${user.login} ${scope}`)}&per_page=30`),
    ]);
    const claims = claimedRes.items
      .map((i) => ({ i, repo: i.repository_url.split("/repos/")[1] }))
      .map((c) => ({ ...c, b: open.find((b) => b.repo === c.repo && b.issue === BigInt(c.i.number)) }))
      .filter((c) => c.b);
    const seen = new Set();
    const prs = [...authored.items, ...assigned.items.filter((p) => p.user.type === "Bot")].filter((p) => !seen.has(p.id) && seen.add(p.id));
    const rows = prs.map((pr) => {
      const repo = pr.repository_url.split("/repos/")[1];
      const nums = [...(pr.body ?? "").matchAll(FIXES)].map((m) => BigInt(m[1]));
      const hits = open.filter((b) => b.repo === repo && nums.includes(b.issue));
      return { pr, repo, hits };
    });
    $("wip-count").textContent = `${claims.length} claim${claims.length === 1 ? "" : "s"} · ${rows.length} open PR${rows.length === 1 ? "" : "s"}`;
    if (!rows.length && !claims.length) {
      el.innerHTML = `<div class="empty-box"><b>You don't hold any claims.</b><p><a href="#bounties">Pick a funded issue</a> and comment <code>/claim</code> on it. Then open a PR that says “Fixes #N”. Only the claimant's PR gets paid, and a claim with no activity for 7 days is released.</p></div>`;
      return;
    }
    const claimRows = claims.map(
      ({ i, repo, b }) => `<div class="row-item claim-row">
        <div><a href="${i.html_url}" target="_blank" rel="noopener">${esc(i.title)}</a><span class="muted mono">${esc(repo)} · #${i.number} · claimed by you · ${
          rows.some((r) => r.repo === repo && r.hits.some((h) => h.issue === b.issue)) ? "PR open ✔" : `no PR yet, open one with “Fixes #${i.number}”`
        }</span></div>
        <span class="pill paid">🔒 Your claim · ${usd(b.amount)} USDC</span>
      </div>`
    );
    el.innerHTML = claimRows.join("") + rows
      .map(
        ({ pr, repo, hits }) => `<div class="row-item">
          <div><a href="${pr.html_url}" target="_blank" rel="noopener">${esc(pr.title)}</a><span class="muted mono">${esc(repo)} · #${pr.number} · opened ${isoAgo(pr.created_at)}${pr.user.type === "Bot" ? ` by @${esc(pr.user.login)} for you` : ""}</span></div>
          ${hits.length
            ? hits.every((h) => claims.some((c) => c.b === h))
              ? `<span class="pill paid">Closes #${hits.map((h) => h.issue).join(", #")} · ${usd(hits.reduce((s, h) => s + h.payout, 0n))} USDC</span>`
              : `<span class="pill held" title="Only the claimant's PR is paid. Comment /claim on the issue.">Not claimed · won't be paid</span>`
            : `<span class="pill open" title="Add “Fixes #N” to the PR body to claim a bounty">No bounty linked</span>`}
        </div>`
      )
      .join("");
  } catch (e) {
    $("wip-count").textContent = "github unavailable";
    el.innerHTML = `<p class="status err">${esc(e.message)}. GitHub limits unauthenticated lookups; try again in a minute.</p>`;
  }
}

async function renderActivity(user, mine) {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const monthName = now.toLocaleString("en", { month: "long", timeZone: "UTC" });
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const start = `${y}-${String(m + 1).padStart(2, "0")}-01`;
  $("act-label").textContent = `Activity (${monthName} ${y})`;
  $("act-month").textContent = monthName.toUpperCase();

  let prs = [];
  try {
    const q = `is:pr is:merged author:${user.login} merged:>=${start}`;
    prs = (await gh(`search/issues?q=${encodeURIComponent(q)}&per_page=100`)).items;
  } catch {}

  const funded = new Set((await bounties()).map((b) => b.repo));
  const perDay = new Array(days + 1).fill(0);
  for (const pr of prs) {
    const d = new Date(pr.pull_request?.merged_at ?? pr.closed_at);
    if (d.getUTCMonth() === m) perDay[d.getUTCDate()]++;
  }
  const items = (await feed()).filter((i) => i.user === String(user.id) && (i.kind === "awarded" || i.kind === "paid"));
  const paidDays = new Set(
    items.filter((i) => new Date(i.ts * 1000).getUTCMonth() === m).map((i) => new Date(i.ts * 1000).getUTCDate())
  );

  const active = perDay.filter((n) => n > 0).length;
  $("act-days").textContent = String(active);
  $("a-merged").textContent = String(prs.length);
  $("act-count").textContent = `${active}/${days} days`;
  $("act-summary").innerHTML = `${prs.length} merged PR${prs.length === 1 ? "" : "s"} this month${
    prs.some((p) => funded.has(p.repository_url.split("/repos/")[1])) ? ", some on funded repos" : ""
  }. <span class="muted">${mine.length} bount${mine.length === 1 ? "y" : "ies"} awarded to you so far.</span>`;

  // one segment per week of the month, filled if you merged something that week
  const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const weeks = Math.ceil((firstDow + days) / 7);
  const weekActive = new Array(weeks).fill(false);
  for (let d = 1; d <= days; d++) if (perDay[d]) weekActive[Math.floor((firstDow + d - 1) / 7)] = true;
  $("act-segs").innerHTML = weekActive.map((on) => `<i class="${on ? "on" : ""}"></i>`).join("");

  const max = Math.max(1, ...perDay);
  $("act-spark").innerHTML = perDay
    .slice(1)
    .map((n, i) => `<i style="height:${n ? 8 + (n / max) * 52 : 2}px" title="${monthName} ${i + 1}: ${n} merged"></i>`)
    .join("");

  const today = now.getUTCDate();
  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += `<span class="blank"></span>`;
  for (let d = 1; d <= days; d++) {
    const cls = [perDay[d] ? "on" : "", d === today ? "today" : "", d > today ? "future" : ""].join(" ");
    cells += `<span class="${cls}" title="${monthName} ${d}: ${perDay[d]} merged${paidDays.has(d) ? " · paid on Arc" : ""}">${paidDays.has(d) ? "$" : ""}</span>`;
  }
  $("act-cal").innerHTML = cells;

  $("prs-head").textContent = `Merged pull requests (${prs.length})`;
  $("prs").innerHTML = prs.length
    ? prs
        .slice(0, 12)
        .map((pr) => {
          const repo = pr.repository_url.split("/repos/")[1];
          return `<div class="plist-row">
            <div><a href="${pr.html_url}" target="_blank" rel="noopener">${esc(pr.title)}</a><span class="muted mono">${esc(repo)}</span></div>
            <div class="right">${funded.has(repo) ? `<span class="pill paid">Funded repo</span>` : ""}<span class="pill open">Merged</span><time>${isoAgo(pr.pull_request?.merged_at ?? pr.closed_at)}</time></div>
          </div>`;
        })
        .join("")
    : `<p class="plist-empty">No merged PRs yet this month.</p>`;

  $("paid-head").textContent = `Payouts on Arc (${items.length})`;
  $("paid-list").innerHTML = items.length
    ? items
        .map(
          (i) => `<div class="plist-row">
          <div>${i.kind === "paid" ? `${usd(i.amount)} USDC delivered to your wallet` : `${usd(i.amount)} USDC awarded for ${esc(i.repo)}#${i.issue}`}<span class="muted mono">${short(i.tx)}</span></div>
          <div class="right">${txLink(i.tx, "View tx ↗")}<time>${ago(i.ts)}</time></div>
        </div>`
        )
        .join("")
    : `<p class="plist-empty">No payouts yet.</p>`;
}

async function renderRepos() {
  const el = $("repos");
  const all = await bounties();
  const groups = byRepo(all);
  const openCount = all.filter((b) => b.status === "open").length;
  $("repos-count").textContent = `${groups.size} repos · ${openCount} bounties open`;
  if (!groups.size) {
    el.innerHTML = `<p class="pool-empty">${deployed ? "No funded repos yet." : "Contract deploying soon."} <a href="#fund">Fund the first issue →</a></p>`;
    return;
  }
  el.innerHTML = [...groups]
    .map(([repo, list]) => {
      const open = list.filter((b) => b.status === "open");
      const sum = open.reduce((s, b) => s + b.amount, 0n);
      return `<a class="pool-row" href="#bounties">
        <span class="repo mono">${esc(repo)}</span>
        <span class="desc" data-desc="${esc(repo)}">…</span>
        <span class="right"><b>${usd(sum)} USDC</b><small class="mono">${open.length} open · <span data-pushed="${esc(repo)}"></span></small></span>
      </a>`;
    })
    .join("");
  fillRepoMeta(el);
}

function fillRepoMeta(root) {
  root.querySelectorAll("[data-desc]").forEach((n) =>
    gh(`repos/${n.dataset.desc}`).then((r) => (n.textContent = r.description ?? "")).catch(() => (n.textContent = ""))
  );
  root.querySelectorAll("[data-pushed]").forEach((n) =>
    gh(`repos/${n.dataset.pushed}`).then((r) => (n.textContent = `pushed ${isoAgo(r.pushed_at)}`)).catch(() => {})
  );
}

async function renderSponsorships() {
  const el = $("spon");
  if (!account) return;
  if (!deployed) {
    el.innerHTML = `<p class="loading-line">Contract deploying soon.</p>`;
    return;
  }
  const all = await bounties();
  const mine = (await Promise.all(all.map(async (b) => ({ b, c: await read("contributions", [b.id, account]) })))).filter((x) => x.c > 0n);
  $("spon-num").textContent = String(mine.length).padStart(2, "0");
  $("spon-count").textContent = `${mine.length} funded from ${short(account)}`;
  if (!mine.length) {
    el.innerHTML = `<div class="empty-box"><b>Nothing funded from this wallet yet.</b><p><a href="#fund">Fund an issue →</a></p></div>`;
    return;
  }
  el.innerHTML = mine
    .map(
      ({ b, c }) => `<div class="row-item">
        <div><a href="${issueUrl(b.repo, b.issue)}" target="_blank" rel="noopener" data-title="${esc(b.repo)}#${b.issue}">${esc(b.repo)}#${b.issue}</a><span class="muted mono">you put in ${usd(c)} USDC of ${usd(b.amount)}</span></div>
        <div class="right">${statusPill(b)}${
          b.status === "expired" || b.status === "returned"
            ? `<button class="btn btn-sm" data-refund="${b.id}">Take back ${usd(b.status === "returned" ? (c * b.returned) / b.amount : c)}</button>`
            : b.returnable
              ? `<button class="btn btn-sm" data-return="${b.id}" title="The recipient never linked a wallet in 180 days">Return unclaimed</button>`
              : ""
        }</div>
      </div>`
    )
    .join("");
  fillTitles(el);
  el.querySelectorAll("[data-refund], [data-return]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const [functionName, id] = btn.dataset.refund ? ["refund", btn.dataset.refund] : ["returnUnclaimed", btn.dataset.return];
        const hash = await wallet.writeContract({ account, address: cfg.contract, abi, functionName, args: [id] });
        await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
        toast(functionName === "refund" ? "USDC sent back to you" : "Returned. You can now take back your share");
        await bounties(true);
        renderSponsorships();
      } catch (e) {
        toast(e.shortMessage || e.message);
        btn.disabled = false;
      }
    })
  );
}

// =================================================================================================
// Bounties tab: one card per funded repo — funded issues beside open pull requests

async function renderBounties() {
  const root = $("repo-cards");
  const all = await bounties();
  const groups = byRepo(all);
  const openAll = all.filter((b) => b.status === "open");
  $("b-repos").textContent = `${groups.size} repo${groups.size === 1 ? "" : "s"}`;
  $("b-totals").textContent = `${openAll.length} bounties · ${usd(openAll.reduce((s, b) => s + b.amount, 0n))} USDC open`;
  if (!groups.size) {
    root.innerHTML = `<p class="pool-empty win">${deployed ? "No funded repos yet." : "Contract deploying soon."} <a href="#fund">Fund the first issue →</a></p>`;
    return;
  }
  root.innerHTML = [...groups]
    .map(([repo, list]) => {
      const sorted = [...list.filter((b) => b.status === "open"), ...list.filter((b) => b.status !== "open")];
      return `<article class="win repo-card">
        <div class="titlebar"><i></i><i></i><span>${esc(repo)}</span></div>
        <div class="repo-head">
          <a class="repo-name mono" href="https://github.com/${esc(repo)}" target="_blank" rel="noopener">${esc(repo)}</a>
          <span class="desc" data-desc="${esc(repo)}">…</span>
          <span class="muted mono" data-pushed="${esc(repo)}"></span>
        </div>
        <div class="repo-cols">
          <div class="sub-win">
            <div class="sub-head"><span>Funded issues (${list.length})</span><a href="https://github.com/${esc(repo)}/issues" target="_blank" rel="noopener">All ↗</a></div>
            ${sorted
              .map(
                (b) => `<div class="sub-row">
                <div class="sub-main">
                  <a href="${issueUrl(repo, b.issue)}" target="_blank" rel="noopener" data-title="${esc(repo)}#${b.issue}">#${b.issue}</a>
                  ${b.status === "open" ? `<span data-claim="${esc(repo)}#${b.issue}"></span>` : ""}
                </div>
                <span class="sub-right"><b>${usd(b.amount)}</b>${statusPill(b)}</span>
              </div>`
              )
              .join("")}
          </div>
          <div class="sub-win alt">
            <div class="sub-head"><span data-prs-head="${esc(repo)}">Open pull requests</span><a href="https://github.com/${esc(repo)}/pulls" target="_blank" rel="noopener">All ↗</a></div>
            <div data-prs="${esc(repo)}"><div class="sub-row muted">Loading…</div></div>
          </div>
        </div>
      </article>`;
    })
    .join("");
  fillTitles(root);
  fillClaims(root);
  fillRepoMeta(root);
  root.querySelectorAll("[data-prs]").forEach(async (n) => {
    const repo = n.dataset.prs;
    try {
      const prs = await gh(`repos/${repo}/pulls?state=open&per_page=6`);
      root.querySelector(`[data-prs-head="${CSS.escape(repo)}"]`).textContent = `Open pull requests (${prs.length}${prs.length === 6 ? "+" : ""})`;
      n.innerHTML = prs.length
        ? prs.map((p) => `<div class="sub-row"><a href="${p.html_url}" target="_blank" rel="noopener">${esc(p.title)}</a><time>${isoAgo(p.created_at)}</time></div>`).join("")
        : `<div class="sub-row muted">No open pull requests. Be the first.</div>`;
    } catch {
      n.innerHTML = `<div class="sub-row muted">Couldn't load from GitHub.</div>`;
    }
  });
}

// =================================================================================================
// Fund tab

let fundRepo = null; // { full_name, id, default_branch }

function newFileUrl(repo, branch, filename, value) {
  return `https://github.com/${repo}/new/${branch}?${new URLSearchParams({ filename, value })}`;
}

function awardYml() {
  return `name: MergePay
on:
  pull_request_target:
    types: [opened, closed]
  issue_comment:
    types: [created]      # /claim, /unclaim
  schedule:
    - cron: "17 3 * * *"  # release claims idle for 7 days
  workflow_dispatch:

jobs:
  award:
    if: github.event_name == 'pull_request_target' && github.event.action == 'closed' && github.event.pull_request.merged
    uses: ${cfg.workflowRepo}/.github/workflows/award.yml@${tag}
    permissions:
      id-token: write       # GitHub signs the merge proof
      pull-requests: write  # payout comment
      issues: write
      contents: read
    with:
      contract: "${cfg.contract}"
      relayer: ${origin}

  claims:
    if: github.event_name != 'pull_request_target' || github.event.action == 'opened'
    uses: ${cfg.workflowRepo}/.github/workflows/claims.yml@${tag}
    permissions:
      issues: write
      pull-requests: write
    with:
      relayer: ${origin}
      release_after_days: 7
`;
}

function linkYml(w) {
  return `name: MergePay link
on:
  workflow_dispatch:
    inputs:
      wallet:
        description: Arc wallet to receive bounties
        required: true
        default: "${w || "0x..."}"

jobs:
  link:
    uses: ${cfg.workflowRepo}/.github/workflows/link.yml@${tag}
    permissions:
      id-token: write
    with:
      wallet: \${{ inputs.wallet }}
      contract: "${cfg.contract}"
      relayer: ${origin}
`;
}

function renderSnippets() {
  const a = awardYml();
  $("award-yml").textContent = a;
  $("wf-ref").textContent = cfg.workflowRef;
  $("add-award").href = fundRepo
    ? newFileUrl(fundRepo.full_name, fundRepo.default_branch, ".github/workflows/mergepay.yml", a)
    : `https://github.com/${cfg.workflowRepo}/blob/main/examples/mergepay.yml`;

  const l = linkYml(account);
  $("link-yml").textContent = l;
  const repo = $("link-repo").value.trim();
  $("add-link").href = /^[\w.-]+\/[\w.-]+$/.test(repo) ? newFileUrl(repo, "main", ".github/workflows/mergepay-link.yml", l) : "https://github.com/new";
}

function renderFund() {
  renderSnippets();
}

document.querySelectorAll("[data-copy]").forEach((b) =>
  b.addEventListener("click", async () => {
    await navigator.clipboard.writeText($(b.dataset.copy).textContent);
    toast("Copied");
  })
);
$("link-repo").addEventListener("input", renderSnippets);

const repoInput = document.querySelector('#fund-form [name="repo"]');
repoInput.addEventListener("change", async () => {
  const v = repoInput.value.trim().replace(/^https:\/\/github.com\//, "").replace(/\/$/, "");
  repoInput.value = v;
  fundRepo = null;
  $("repo-hint").textContent = "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(v)) return;
  try {
    fundRepo = await gh(`repos/${v}`);
    $("repo-hint").textContent = `✓ ${fundRepo.full_name} · repository_id ${fundRepo.id}`;
  } catch (e) {
    $("repo-hint").textContent = `✗ ${e.message}`;
  }
  renderSnippets();
});

$("fund-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const st = $("fund-status");
  const btn = ev.target.querySelector("button");
  if (!deployed) return status(st, "Contract not deployed yet.", "err");
  btn.disabled = true;
  try {
    if (!fundRepo) fundRepo = await gh(`repos/${String(f.get("repo")).trim()}`);
    const w = wallet ?? (await connect());
    if (!w) return;
    const issue = BigInt(f.get("issue"));
    const value = parseUnits(String(f.get("amount")), 18);
    const fee = parseUnits(String(f.get("fee")), 18);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + Number(f.get("days")) * 86400);
    status(st, "Confirm in your wallet…");
    const hash = await w.writeContract({
      account,
      address: cfg.contract,
      abi,
      functionName: "fund",
      args: [BigInt(fundRepo.id), issue, fundRepo.full_name, cfg.workflowRef, expiry, fee],
      value,
    });
    status(st, `Submitted ${txLink(hash)}…`);
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    if (r.status !== "success") throw new Error("transaction reverted");
    status(st, `${usd(value)} USDC escrowed on ${fundRepo.full_name}#${issue}, final in one block · ${txLink(hash)}`, "ok");
    await bounties(true);
    rendered.delete("overview");
    rendered.delete("bounties");
  } catch (e) {
    status(st, esc(e.shortMessage || e.message), "err");
  } finally {
    btn.disabled = false;
  }
});

// =================================================================================================
// Wallet tab

async function renderWallet() {
  renderSnippets();
  const out = $("lookup");
  const l = login();
  if (!l) {
    $("w-state").textContent = "not signed in";
    out.innerHTML = `<div class="empty-box"><b>Who are you on GitHub?</b><p><a href="#overview">Sign in on the Overview tab</a> to see your link status. You can still add the workflow on the right.</p></div>`;
    return;
  }
  try {
    const u = await gh(`users/${l}`);
    if (!$("link-repo").value) {
      $("link-repo").value = `${u.login}/${u.login}`;
      renderSnippets();
    }
    let w = ZERO, pending = 0n, at = 0n;
    if (deployed) [w, pending, at] = await Promise.all([read("walletOf", [BigInt(u.id)]), read("pending", [BigInt(u.id)]), read("linkedAt", [BigInt(u.id)])]);
    const linked = w !== ZERO;
    $("w-state").textContent = linked ? "linked" : "not linked";
    out.innerHTML = `
      <div class="card">
        <div class="who"><img src="${esc(u.avatar_url)}" alt="" />@${esc(u.login)} <span class="muted mono">id ${u.id}</span></div>
        <div class="kv"><span>Payout wallet</span><span>${linked ? `<a href="${cfg.explorer}/address/${w}" target="_blank" rel="noopener">${short(w)}</a>` : "not linked yet"}</span></div>
        <div class="kv"><span>Linked</span><span>${linked ? ago(Number(at)) : "—"}</span></div>
        <div class="kv"><span>Waiting for you</span><span>${usd(pending)} USDC</span></div>
      </div>
      ${!linked && pending > 0n ? `<p class="status ok">You have USDC waiting. Run the link workflow and it's sent right away.</p>` : ""}
      ${linked ? `<p class="sub">To change wallets, run the workflow again with a new address. The newest proof wins, and old ones can't be replayed.</p>` : ""}`;
  } catch (e) {
    out.innerHTML = `<p class="status err">${esc(e.message)}</p>`;
  }
}

// =================================================================================================

if (deployed) {
  $("contract-link").textContent = `contract ${short(cfg.contract)} ↗`;
  $("contract-link").href = `${cfg.explorer}/address/${cfg.contract}`;
}
if (cfg.relayer) $("relayer-addr").textContent = ` · relayer ${short(cfg.relayer)}`;
setWhoami();
route();
