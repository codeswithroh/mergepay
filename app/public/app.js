import { createWalletClient, custom, parseUnits, getAddress } from "https://esm.sh/viem@2.56.8";
import { $, ZERO, abi, cfg, chain, pub, deployed, tag, usd, esc, toast, gh, ago, short, loadBounties, statusPill, fillTitles, fillClaims, skel } from "/common.js";

const origin = location.origin;
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
const bounties = (fresh = false) => {
  if (fresh || !bountiesP) {
    bountiesP = loadBounties(200n);
    bountiesP.catch(() => (bountiesP = null)); // don't cache a failure
  }
  return bountiesP;
};
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
// Identity: the GitHub account you signed in with (OAuth, verified by the worker), plus an optional
// connected wallet. The dashboard only ever shows the signed-in user's own account.

let me = null; // { id, login, avatar } from /api/me
const login = () => me?.login ?? null;

async function loadMe() {
  store.set("mp:login", null); // drop the old unverified "view as" value
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" }).then((x) => x.json());
    me = r.user;
    if (!r.enabled) $("signin-btn").outerHTML = `<p class="status err">GitHub sign-in isn't configured on this deployment yet.</p>`;
  } catch {
    me = null;
  }
}

function setWhoami() {
  const b = $("whoami");
  b.hidden = !me;
  if (me) b.innerHTML = `<img src="${esc(me.avatar)}" alt="" />@${esc(me.login)} · sign out`;
}
$("whoami").addEventListener("click", () => {
  location.href = "/auth/logout";
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
  updateLinkSteps();
  renderSponsorships();
  return w;
}
$("connect").addEventListener("click", () => connect().catch((e) => toast(e.shortMessage || e.message)));

// =================================================================================================
// Overview

async function renderOverview() {
  const l = login();
  $("boot").hidden = true;
  $("signin").hidden = Boolean(l);
  $("account").hidden = !l;
  renderRepos();
  renderSponsorships();
  if (!l) return;

  const user = { id: me.id, login: me.login, avatar_url: me.avatar };
  $("acct-avatar").src = user.avatar_url;
  $("acct-login").textContent = `@${user.login}`;

  const uid = BigInt(user.id);
  let all, linked, pending;
  for (let attempt = 1; ; attempt++) {
    try {
      [all, [linked, pending]] = await Promise.all([
        bounties(attempt > 1),
        deployed ? Promise.all([read("walletOf", [uid]), read("pending", [uid])]) : Promise.resolve([ZERO, 0n]),
      ]);
      break;
    } catch (e) {
      console.error("overview: reading Arc failed", e);
      const msg = `Couldn't reach Arc (${esc(e.shortMessage || e.message)}).`;
      if (attempt >= 4) {
        $("acct-blurb").innerHTML = `<span class="status err">${msg} <button class="linkish" onclick="location.reload()">Reload</button></span>`;
        return;
      }
      $("acct-blurb").innerHTML = skel.loader(`${msg} Retrying…`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  const mine = all.filter((b) => b.awardedTo === uid);
  const awardedTotal = mine.filter((b) => b.status !== "returned").reduce((s, b) => s + b.payout, 0n);
  const hasWallet = linked !== ZERO;

  $("acct-blurb").innerHTML = hasWallet
    ? `Signed in as GitHub user #${user.id}. Payouts go to <a class="mono" href="${cfg.explorer}/address/${linked}" target="_blank" rel="noopener">${short(linked)}</a>, the wallet GitHub proved you control. Merge a PR that closes a funded issue and the USDC arrives in the same minute.`
    : `Signed in as GitHub user #${user.id}. You haven't linked a payout wallet yet. Awards still count and wait safely in the contract. <a href="#wallet">Link a wallet →</a>`;
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

  const funded = new Set((await bounties().catch(() => [])).map((b) => b.repo));
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

  $("act-spark").classList.remove("skel-spark");
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

const arcDown = (e) => `<p class="pool-empty">Couldn't reach Arc right now (${esc(e.shortMessage || e.message)}). <button class="linkish" onclick="location.reload()">Reload</button></p>`;

async function renderRepos() {
  const el = $("repos");
  let all;
  try {
    all = await bounties();
  } catch (e) {
    el.innerHTML = arcDown(e);
    return;
  }
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
  el.innerHTML = skel.loader(`Reading what ${short(account)} funded`) + skel.rows(2);
  if (!deployed) {
    el.innerHTML = `<p class="loading-line">Contract deploying soon.</p>`;
    return;
  }
  const all = await bounties().catch(() => []);
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
  let all;
  try {
    all = await bounties();
  } catch (e) {
    root.innerHTML = `<div class="win">${arcDown(e)}</div>`;
    return;
  }
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
            <div data-prs="${esc(repo)}"><div class="sub-row">${skel.line("70%")}</div><div class="sub-row">${skel.line("55%")}</div></div>
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

const fence = "```";

/** Prompt a coding agent (Claude Code, Codex, Cursor…) can follow to install the award workflow. */
function awardPrompt() {
  const repo = fundRepo?.full_name ?? "<owner/repo>";
  const branch = fundRepo?.default_branch ?? "the default branch";
  return `Set up MergePay on the GitHub repository ${repo}. MergePay pays USDC bounties on Arc when a pull request that closes a funded issue is merged. It needs one workflow file in the repo.

Do exactly this:
1. In ${repo}, create the file .github/workflows/mergepay.yml with exactly this content. Don't change anything in it:

${fence}yaml
${awardYml().trimEnd()}
${fence}

2. Commit it to ${branch} with the message "Add MergePay workflow". If you can't push to ${branch}, open a pull request with that file instead.
3. Don't modify any other file.
4. Verify it landed, e.g. \`gh api repos/${repo}/contents/.github/workflows/mergepay.yml --jq .path\`.
5. Reply with the commit or PR link.

Context, in case you're asked: it runs on pull_request_target but never checks out PR code; \`id-token: write\` lets GitHub sign the merge proof that the MergePay contract verifies on-chain. Contributors take a bounty by commenting /claim on the issue.`;
}

/** Prompt a coding agent can follow to link the user's GitHub account to their payout wallet. */
function linkPrompt() {
  const repo = $("link-repo").value.trim() || (me ? `${me.login}/${me.login}` : "<a repo you own>");
  const w = account ?? "<YOUR_ARC_WALLET_ADDRESS>";
  return `Link my GitHub account to my MergePay payout wallet on Arc. GitHub proves it's me by signing a token inside a workflow run in a repository I own.

Do exactly this:
1. In ${repo} (a repository I own, not an org's), create .github/workflows/mergepay-link.yml with exactly this content:

${fence}yaml
${linkYml(account).trimEnd()}
${fence}

2. Commit it to the default branch with the message "Add MergePay wallet link". If ${repo} doesn't exist, create it as a public repo first.
3. Run it: \`gh workflow run mergepay-link.yml --repo ${repo} -f wallet=${w}\`
4. Wait for it: \`gh run watch --repo ${repo} $(gh run list --repo ${repo} --workflow mergepay-link.yml --limit 1 --json databaseId --jq '.[0].databaseId')\`
5. Success means the run log shows "ok":true and a txHash. Reply with the tx hash, or the error from the log if it failed.

Don't modify any other files.`;
}

function renderSnippets() {
  const a = awardYml();
  $("award-yml").textContent = a;
  $("award-prompt").textContent = awardPrompt();
  $("wf-ref").textContent = cfg.workflowRef;
  $("add-award").href = fundRepo
    ? newFileUrl(fundRepo.full_name, fundRepo.default_branch, ".github/workflows/mergepay.yml", a)
    : `https://github.com/${cfg.workflowRepo}/blob/main/examples/mergepay.yml`;

  const l = linkYml(account);
  $("link-yml").textContent = l;
  const repo = $("link-repo").value.trim();
  $("add-link").href = /^[\w.-]+\/[\w.-]+$/.test(repo) ? newFileUrl(repo, "main", ".github/workflows/mergepay-link.yml", l) : "https://github.com/new";
}

document.querySelectorAll("[data-copy]").forEach((b) =>
  b.addEventListener("click", async () => {
    await navigator.clipboard.writeText($(b.dataset.copy).textContent);
    toast("Copied");
  })
);
document.querySelectorAll("[data-copy-agent]").forEach((b) =>
  b.addEventListener("click", async () => {
    if (b.dataset.copyAgent === "award" && !fundRepo) return toast("Pick the repository in step 1 first");
    await navigator.clipboard.writeText(b.dataset.copyAgent === "award" ? awardPrompt() : linkPrompt());
    toast("Prompt copied. Paste it into Claude Code or Codex");
  })
);
$("link-repo").addEventListener("input", renderSnippets);

// ---- Fund: step 1 (issue) → step 2 (workflow installed?) → step 3 (escrow) -------------------------

let workflowInstalled = null; // null = unknown, true/false once checked

function setStep(n, text, done) {
  $(`s${n}-state`).textContent = text;
  $(`s${n}-state`).classList.toggle("done", Boolean(done));
  $(`step${n}`).classList.toggle("step-done", Boolean(done));
}

/** Does any workflow in the repo call our pinned award.yml? Reads raw files (no API rate limit). */
async function checkWorkflow() {
  const box = $("wf-status");
  workflowInstalled = null;
  if (!fundRepo) {
    box.innerHTML = "";
    setStep(2, "after step 1");
    return;
  }
  box.innerHTML = skel.loader(`Checking ${esc(fundRepo.full_name)} for the MergePay workflow`);
  setStep(2, "checking…");
  const needle = `${cfg.workflowRepo}/.github/workflows/award.yml@`;
  let found = null;
  try {
    const files = await fetch(`https://api.github.com/repos/${fundRepo.full_name}/contents/.github/workflows?ref=${fundRepo.default_branch}`).then((r) => (r.ok ? r.json() : []));
    for (const f of files.filter((f) => /\.ya?ml$/.test(f.name))) {
      const text = await fetch(f.download_url).then((r) => r.text());
      const m = text.match(new RegExp(`${needle.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([\\w.\\-/]+)`));
      if (m) {
        found = { file: f.path, tag: m[1], claims: text.includes("claims.yml") };
        break;
      }
    }
  } catch {}
  workflowInstalled = Boolean(found && found.tag === tag);
  if (found && found.tag === tag) {
    box.innerHTML = `<p class="status ok">Already installed in <span class="mono">${esc(found.file)}</span>. Nothing to do here.${found.claims ? "" : " (Claims aren't enabled in it yet. Re-add the workflow to get /claim.)"}</p>`;
    setStep(2, "installed ✔", true);
  } else if (found) {
    box.innerHTML = `<p class="status err">Found MergePay pinned to <span class="mono">@${esc(found.tag)}</span>, but new bounties pin <span class="mono">@${esc(tag)}</span>. Update the file below.</p>`;
    setStep(2, "needs update");
  } else {
    box.innerHTML = `<p class="status err">Not installed on <span class="mono">${esc(fundRepo.full_name)}</span> yet. Pick one of the two ways below, then <button class="linkish" id="wf-recheck">check again</button>.</p>`;
    $("wf-recheck").addEventListener("click", checkWorkflow);
    setStep(2, "to do");
  }
  $("wf-warn").hidden = workflowInstalled !== false;
  $("wf-warn").className = "status err";
  $("wf-warn").textContent = "The workflow isn't installed yet (step 2). You can escrow now, but a merge can't pay out until it is.";
}

function updateFundButton() {
  const repo = fundRepo?.full_name, issue = $("f-issue").value;
  const amt = document.querySelector('#fund-form [name="amount"]').value;
  $("fund-btn").textContent = repo && issue ? `Escrow ${amt || "…"} USDC on ${repo}#${issue}` : "Escrow USDC on Arc";
  setStep(1, repo && issue ? `${repo}#${issue} ✔` : "to do", Boolean(repo && issue));
}

async function onIssueInput() {
  // Accept a pasted issue URL: https://github.com/owner/repo/issues/12
  const raw = $("f-repo").value.trim();
  const m = raw.match(/github\.com\/([\w.-]+\/[\w.-]+)(?:\/issues\/(\d+))?/);
  const v = (m ? m[1] : raw).replace(/\/$/, "");
  if (m) $("f-repo").value = v;
  if (m?.[2]) $("f-issue").value = m[2];
  if (fundRepo?.full_name?.toLowerCase() === v.toLowerCase()) return updateFundButton();
  fundRepo = null;
  $("repo-hint").textContent = "";
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) {
    try {
      fundRepo = await gh(`repos/${v}`);
      $("repo-hint").textContent = `✓ ${fundRepo.full_name} · repository_id ${fundRepo.id}`;
    } catch (e) {
      $("repo-hint").textContent = `✗ ${e.message}`;
    }
  }
  updateFundButton();
  renderSnippets();
  checkWorkflow();
}

function renderFund() {
  renderSnippets();
  updateFundButton();
}

$("f-repo").addEventListener("change", onIssueInput);
$("f-repo").addEventListener("paste", () => setTimeout(onIssueInput, 0));
$("f-issue").addEventListener("input", updateFundButton);
document.querySelector('#fund-form [name="amount"]').addEventListener("input", updateFundButton);

$("fund-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const st = $("fund-status");
  const btn = $("fund-btn");
  if (!deployed) return status(st, "Contract not deployed yet.", "err");
  if (!fundRepo || !$("f-issue").value) {
    status(st, "Pick the repository and issue in step 1 first.", "err");
    $("f-repo").focus();
    return;
  }
  btn.disabled = true;
  try {
    const w = wallet ?? (await connect());
    if (!w) return;
    const issue = BigInt($("f-issue").value);
    const value = parseUnits(String(f.get("amount")), 18);
    const fee = parseUnits(String(f.get("fee")), 18);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + Number(f.get("days")) * 86400);
    status(st, skel.loader("Confirm in your wallet"));
    const hash = await w.writeContract({
      account,
      address: cfg.contract,
      abi,
      functionName: "fund",
      args: [BigInt(fundRepo.id), issue, fundRepo.full_name, cfg.workflowRef, expiry, fee],
      value,
    });
    status(st, skel.loader(`Submitted ${txLink(hash)}, waiting for Arc to finalize`));
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    if (r.status !== "success") throw new Error("transaction reverted");
    status(
      st,
      `${usd(value)} USDC escrowed on ${fundRepo.full_name}#${issue}, final in one block · ${txLink(hash)}. Tell contributors to comment <code>/claim</code> on the issue.`,
      "ok"
    );
    setStep(3, "funded ✔", true);
    await bounties(true);
    rendered.delete("overview");
    rendered.delete("bounties");
  } catch (e) {
    status(st, esc(e.shortMessage || e.message), "err");
  } finally {
    btn.disabled = false;
    updateFundButton();
  }
});

// =================================================================================================
// Wallet tab

// ---- One-click link --------------------------------------------------------------------------

function updateLinkSteps() {
  if (me) $("link-repo-name").textContent = `${me.login}/mergepay-link`;
  const ready = Boolean(account);
  $("ls-1").classList.toggle("done", ready);
  $("ls-1-text").textContent = ready ? `${short(account)} connected` : "Any Arc wallet. You won't pay gas.";
  $("ls-connect").textContent = ready ? "Change" : "Connect wallet";
  const link = $("ls-link");
  link.setAttribute("aria-disabled", String(!ready));
  link.href = ready ? `/auth/link?wallet=${account}` : "#wallet";
}
$("ls-connect").addEventListener("click", () => connect().catch((e) => toast(e.shortMessage || e.message)));
$("ls-link").addEventListener("click", (ev) => {
  if (!account) {
    ev.preventDefault();
    toast("Connect the wallet you want paid first");
  }
});

/** After /auth/link returns: watch the contract until GitHub's proof lands. */
async function watchLink() {
  const q = new URLSearchParams(location.search);
  const target = q.get("linking"), run = q.get("run"), err = q.get("link_error");
  if (!target && !err) return;
  history.replaceState(null, "", `/app${location.hash}`);
  const box = $("link-progress");
  if (err) {
    box.innerHTML = `<p class="status err">Linking didn't finish: ${esc(err)}. <a href="#wallet" onclick="location.reload()">Try again</a>, or use one of the other ways below.</p>`;
    return;
  }
  if (!me) return;
  $("ls-2").classList.add("busy");
  box.innerHTML = skel.loader(`GitHub is running the link workflow in ${esc(me.login)}/mergepay-link…`) +
    `<p class="sub">Usually 20–40 seconds. <a href="${esc(run)}" target="_blank" rel="noopener">Watch it on GitHub ↗</a></p>`;
  const started = Date.now();
  while (Date.now() - started < 4 * 60_000) {
    await new Promise((r) => setTimeout(r, 3000));
    let w;
    try {
      w = await read("walletOf", [BigInt(me.id)]);
    } catch {
      continue;
    }
    if (w.toLowerCase() === target.toLowerCase()) {
      $("ls-2").classList.remove("busy");
      $("ls-2").classList.add("done");
      box.innerHTML = `<p class="status ok"><b>Linked.</b> GitHub vouched that @${esc(me.login)} controls <a class="mono" href="${cfg.explorer}/address/${w}" target="_blank" rel="noopener">${short(w)}</a>, and the contract recorded it on Arc. Any USDC waiting for you was sent there just now.</p>`;
      rendered.delete("overview");
      renderWallet();
      return;
    }
  }
  $("ls-2").classList.remove("busy");
  box.innerHTML = `<p class="status err">Still waiting after 4 minutes. <a href="${esc(run)}" target="_blank" rel="noopener">Check the run on GitHub ↗</a>. If it failed, its log says why.</p>`;
}

async function renderWallet() {
  renderSnippets();
  updateLinkSteps();
  const out = $("lookup");
  out.innerHTML = skel.loader("Reading your link status on Arc") + skel.rows(2);
  const l = login();
  if (!l) {
    $("w-state").textContent = "not signed in";
    out.innerHTML = `<div class="empty-box"><b>Who are you on GitHub?</b><p><a href="/auth/login?next=%2Fapp%23wallet">Sign in with GitHub</a> to see your link status, or just use <b>Link in one click</b> on the right. It signs you in too.</p></div>`;
    return;
  }
  try {
    const u = { id: me.id, login: me.login, avatar_url: me.avatar };
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
await loadMe();
setWhoami();
route();
watchLink();
