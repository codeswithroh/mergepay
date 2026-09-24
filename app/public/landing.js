import { $, cfg, deployed, usd, esc, ago, short, loadBounties, statusPill, totals, fillTitles, fillClaims } from "/common.js";

// ---------------------------------------------------------------------------------------------
// activity feed (indexed by the worker from on-chain events)

const ICON = { funded: "$", awarded: "⎇", paid: "✔", linked: "⚭", refunded: "↩", returned: "↩" };

function feedLine(i) {
  const who = i.login ? `@${esc(i.login)}` : i.user ? `user ${esc(i.user)}` : "";
  const where = i.repo ? `${esc(i.repo)}#${i.issue}` : "";
  switch (i.kind) {
    case "funded": return [`${usd(i.amount)} USDC on ${where}`, "funded"];
    case "awarded": return [`${where} merged → ${who}`, `awarded ${usd(i.amount)} USDC`];
    case "paid": return [`${usd(i.amount)} USDC → ${who}`, "paid"];
    case "linked": return [`${who} linked a wallet`, "linked"];
    case "refunded": return [`${usd(i.amount)} USDC refunded`, "refund"];
    case "returned": return [`${usd(i.amount)} USDC unclaimed by ${who}`, "returned to funders"];
  }
  return [i.kind, ""];
}

async function loadFeed() {
  const el = $("feed");
  if (!deployed) {
    el.innerHTML = `<li class="feed-empty">Contract deploying soon. Events will stream here.</li>`;
    return;
  }
  const { items = [] } = await fetch("/api/feed").then((r) => r.json());
  if (!items.length) {
    el.innerHTML = `<li class="feed-empty">No activity yet. <a href="/app#fund">Fund the first bounty →</a></li>`;
    return;
  }
  el.innerHTML = items
    .slice(0, 7)
    .map((i) => {
      const [title, sub] = feedLine(i);
      return `<li>
        <span class="ico">${ICON[i.kind] ?? "·"}</span>
        <a class="what" href="${cfg.explorer}/tx/${i.tx}" target="_blank" rel="noopener">${title}</a>
        <time>${ago(i.ts)}</time>
        <span class="sub mono">${sub} · ${short(i.tx)}</span>
      </li>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------------------------
// stats + open bounty pool

async function loadPool() {
  const pool = $("pool");
  if (!deployed) {
    pool.innerHTML = `<p class="pool-empty">The first bounties are coming soon.</p>`;
    return;
  }
  $("contract-foot").href = `${cfg.explorer}/address/${cfg.contract}`;
  const all = await loadBounties();
  const t = totals(all);
  $("s-open").textContent = `$${usd(t.open)}`;
  $("s-paid").textContent = `$${usd(t.paid)}`;
  $("s-count").textContent = String(t.count);

  const rows = [...all.filter((b) => b.status === "open"), ...all.filter((b) => b.status !== "open")].slice(0, 6);
  if (!rows.length) {
    pool.innerHTML = `<p class="pool-empty">No bounties yet. <a href="/app#fund">Fund the first one →</a></p>`;
    return;
  }
  pool.innerHTML = rows
    .map(
      (b) => `
      <a class="pool-row" href="https://github.com/${esc(b.repo)}/issues/${b.issue}" target="_blank" rel="noopener">
        <span class="repo mono">${esc(b.repo)}#${b.issue} <em>↗</em>${b.status === "open" ? `<span data-claim="${esc(b.repo)}#${b.issue}"></span>` : ""}</span>
        <span class="desc" data-title="${esc(b.repo)}#${b.issue}">Issue #${b.issue} on ${esc(b.repo)}</span>
        <span class="right"><b>${usd(b.amount)} USDC</b>${statusPill(b)}</span>
      </a>`
    )
    .join("");
  fillTitles(pool);
  fillClaims(pool);
}

loadFeed().catch(() => ($("feed").innerHTML = `<li class="feed-empty">Feed unavailable right now.</li>`));
loadPool().catch((e) => ($("pool").innerHTML = `<p class="pool-empty">${esc(e.shortMessage || e.message)}</p>`));
setInterval(() => loadFeed().catch(() => {}), 15000);
