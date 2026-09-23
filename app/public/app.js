import { createWalletClient, custom, parseUnits, getAddress } from "https://esm.sh/viem@2.56.8";
import { $, ZERO, abi, cfg, chain, pub, deployed, tag, usd, esc, toast, gh, loadBounties, statusPill, totals, fillTitles } from "/common.js";

const origin = location.origin;
let account = null;

const status = (el, msg, kind = "") => {
  el.className = `status ${kind}`;
  el.innerHTML = msg;
};
const txLink = (hash) => `<a href="${cfg.explorer}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a>`;

function newFileUrl(repo, branch, filename, value) {
  const q = new URLSearchParams({ filename, value });
  return `https://github.com/${repo}/new/${branch}?${q}`;
}

// ---------------------------------------------------------------------------------------------
// workflow snippets

function awardYml() {
  return `name: MergePay
on:
  pull_request_target:
    types: [closed]

jobs:
  mergepay:
    if: github.event.pull_request.merged
    uses: ${cfg.workflowRepo}/.github/workflows/award.yml@${tag}
    permissions:
      id-token: write       # GitHub signs the merge proof
      pull-requests: write  # payout comment
      issues: write
      contents: read
    with:
      contract: "${cfg.contract}"
      relayer: ${origin}
`;
}

function linkYml(wallet) {
  return `name: MergePay link
on:
  workflow_dispatch:
    inputs:
      wallet:
        description: Arc wallet to receive bounties
        required: true
        default: "${wallet || "0x..."}"

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

let fundRepo = null; // { full_name, id, default_branch }

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
  $("add-link").href = /^[\w.-]+\/[\w.-]+$/.test(repo)
    ? newFileUrl(repo, "main", ".github/workflows/mergepay-link.yml", l)
    : "https://github.com/new";
}

document.querySelectorAll("[data-copy]").forEach((b) =>
  b.addEventListener("click", async () => {
    await navigator.clipboard.writeText($(b.dataset.copy).textContent);
    toast("Copied");
  })
);
$("link-repo").addEventListener("input", renderSnippets);

// ---------------------------------------------------------------------------------------------
// board

async function loadBoard() {
  const board = $("board");
  if (!deployed) {
    board.innerHTML = `<div class="empty">Contract not deployed yet.</div>`;
    return;
  }
  $("contract-link").textContent = `${cfg.contract.slice(0, 8)}…${cfg.contract.slice(-6)} ↗`;
  $("contract-link").href = `${cfg.explorer}/address/${cfg.contract}`;

  const bounties = await loadBounties();
  const t = totals(bounties);
  $("s-open").textContent = `$${usd(t.open)}`;
  $("s-paid").textContent = `$${usd(t.paid)}`;
  $("s-count").textContent = String(t.count);

  if (!bounties.length) {
    board.innerHTML = `<div class="empty">No bounties yet. <a href="#fund">Fund the first one →</a></div>`;
    return;
  }
  board.innerHTML = bounties
    .map(
      (b) => `
      <article class="win bounty" data-id="${b.id}">
        <div class="titlebar"><i></i><i></i><span>${esc(b.repo.split("/")[1] ?? b.repo)}-${b.issue}.issue</span></div>
        <div class="win-body">
          <div class="banner"><div class="amt">${usd(b.amount)}<small>USDC</small></div></div>
          <div class="title"><a href="https://github.com/${esc(b.repo)}/issues/${b.issue}" target="_blank" rel="noopener" data-title="${esc(b.repo)}#${b.issue}">${esc(b.repo)}#${b.issue}</a></div>
          <div class="meta">${esc(b.repo)} · #${b.issue}${b.awardedTo ? ` · → user ${b.awardedTo}` : ""}</div>
          <div class="foot">
            ${statusPill(b)}
            <a class="btn btn-sm" href="https://github.com/${esc(b.repo)}/issues/${b.issue}" target="_blank" rel="noopener">View issue</a>
          </div>
        </div>
      </article>`
    )
    .join("");
  fillTitles(board);
}

// ---------------------------------------------------------------------------------------------
// wallet

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
  $("connect").textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
  renderSnippets();
  return w;
}
$("connect").addEventListener("click", () => connect().catch((e) => toast(e.shortMessage || e.message)));

// ---------------------------------------------------------------------------------------------
// fund

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
    if (!fundRepo) {
      repoInput.dispatchEvent(new Event("change"));
      fundRepo = await gh(`repos/${String(f.get("repo")).trim()}`);
    }
    const w = await connect();
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
    loadBoard();
  } catch (e) {
    status(st, esc(e.shortMessage || e.message), "err");
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------------------------
// contributor lookup

$("lookup-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const login = new FormData(ev.target).get("login").trim().replace(/^@/, "");
  const out = $("lookup");
  out.innerHTML = `<p class="muted">Looking up @${esc(login)}…</p>`;
  try {
    const u = await gh(`users/${login}`);
    if (!$("link-repo").value) {
      $("link-repo").value = `${u.login}/${u.login}`;
      renderSnippets();
    }
    let wallet = ZERO, pending = 0n;
    if (deployed) {
      [wallet, pending] = await Promise.all([
        pub.readContract({ address: cfg.contract, abi, functionName: "walletOf", args: [BigInt(u.id)] }),
        pub.readContract({ address: cfg.contract, abi, functionName: "pending", args: [BigInt(u.id)] }),
      ]);
    }
    const linked = wallet !== ZERO;
    out.innerHTML = `
      <div class="card">
        <div class="who"><img src="${esc(u.avatar_url)}" alt="" />@${esc(u.login)} <span class="muted mono small">id ${u.id}</span></div>
        <div class="kv"><span>Wallet</span><span class="mono">${linked ? `<a href="${cfg.explorer}/address/${wallet}" target="_blank" rel="noopener">${wallet.slice(0, 8)}…${wallet.slice(-6)}</a>` : "not linked yet"}</span></div>
        <div class="kv"><span>Waiting for you</span><span>${usd(pending)} USDC</span></div>
        ${!linked && pending > 0n ? `<p class="status ok">You have USDC waiting. Run the link workflow on the right and it's sent immediately.</p>` : ""}
      </div>`;
  } catch (e) {
    out.innerHTML = `<p class="status err">${esc(e.message)}</p>`;
  }
});

// ---------------------------------------------------------------------------------------------

$("gh-link").href = `https://github.com/${cfg.workflowRepo}`;
if (cfg.relayer) $("relayer-addr").textContent = `relayer ${cfg.relayer.slice(0, 6)}…${cfg.relayer.slice(-4)}`;
renderSnippets();
loadBoard().catch((e) => ($("board").innerHTML = `<p class="status err">${esc(e.shortMessage || e.message)}</p>`));
