// "Sign in with GitHub" for the app dashboard.
//
// This proves who is *viewing* the dashboard. It is not what protects funds: payouts only go to a
// wallet proven by GitHub's own OIDC token (the link workflow), verified on-chain. The OAuth access
// token is used once to read /user and then discarded; the session cookie holds only id + login.

export interface AuthEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** Public site origin (e.g. https://mergepay.fun) when the site is served through a proxy. */
  PUBLIC_ORIGIN?: string;
}

export type Session = { id: number; login: string; avatar: string; exp: number };

const SESSION_COOKIE = "mp_session";
const STATE_COOKIE = "mp_oauth_state";
const SESSION_TTL = 30 * 24 * 3600;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signSession(secret: string, s: Session) {
  const body = b64url(enc.encode(JSON.stringify(s)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

export async function verifySession(secret: string, value: string | undefined): Promise<Session | null> {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  try {
    if (!timingSafeEqual(fromB64url(sig), await hmac(secret, body))) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    return s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}

function cookie(req: Request, name: string) {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** Only same-site relative paths, so /auth/login can't be used as an open redirect. */
const safeNext = (n: string | null) => (n && /^\/(?!\/)[\w\-./#?=&]*$/.test(n) ? n : "/app");

export const authConfigured = (env: AuthEnv) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET);

export async function currentUser(req: Request, env: AuthEnv) {
  return env.SESSION_SECRET ? verifySession(env.SESSION_SECRET, cookie(req, SESSION_COOKIE)) : null;
}

export type LinkConfig = { contract: string; workflowRepo: string; tag: string };

const LINK_REPO = "mergepay-link";
const LINK_FILE = ".github/workflows/mergepay-link.yml";

function linkWorkflow(c: LinkConfig, origin: string) {
  return `# Created by MergePay's one-click wallet link. Safe to keep or delete.
# It proves "this GitHub account controls this wallet" to the MergePay contract on Arc:
# GitHub signs a token for this run, and the contract verifies GitHub's signature.
name: MergePay link
on:
  workflow_dispatch:
    inputs:
      wallet:
        description: Arc wallet to receive bounties
        required: true

jobs:
  link:
    uses: ${c.workflowRepo}/.github/workflows/link.yml@${c.tag}
    permissions:
      id-token: write
    with:
      wallet: \${{ inputs.wallet }}
      contract: "${c.contract}"
      relayer: ${origin}
`;
}

const ghApi = (token: string) => async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "mergepay",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  return res;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One-click link: in a public repo the user owns (created if needed), write the link workflow and
 * dispatch it with their wallet. GitHub then signs the proof inside that run; the contract checks it.
 * Returns the Actions page URL to watch.
 */
async function runOneClickLink(token: string, login: string, wallet: string, cfg: LinkConfig, origin: string) {
  const api = ghApi(token);
  const repo = `${login}/${LINK_REPO}`;

  let r = await api(`/repos/${repo}`);
  if (r.status === 404) {
    r = await api(`/user/repos`, {
      method: "POST",
      body: JSON.stringify({
        name: LINK_REPO,
        description: "Proves my GitHub account's payout wallet to MergePay on Arc (one-click link).",
        auto_init: true,
        has_issues: false,
        has_wiki: false,
        has_projects: false,
      }),
    });
    if (!r.ok) throw new Error(`couldn't create ${repo} (${r.status})`);
    await sleep(1500); // let the initial commit settle
    r = await api(`/repos/${repo}`);
  }
  if (!r.ok) throw new Error(`couldn't read ${repo} (${r.status})`);
  const info = (await r.json()) as { default_branch: string; owner: { login: string } };
  if (info.owner.login.toLowerCase() !== login.toLowerCase()) throw new Error(`${repo} isn't owned by you`);
  const branch = info.default_branch;

  const content = linkWorkflow(cfg, origin);
  const existing = await api(`/repos/${repo}/contents/${LINK_FILE}?ref=${branch}`);
  const file = existing.ok ? ((await existing.json()) as { sha: string; content: string }) : null;
  const sha = file?.sha;
  const current = file ? atob(file.content.replace(/\n/g, "")) : null;
  if (current !== content) {
    const put = await api(`/repos/${repo}/contents/${LINK_FILE}`, {
      method: "PUT",
      body: JSON.stringify({
        message: sha ? "Update MergePay link workflow" : "Add MergePay link workflow",
        content: btoa(content),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!put.ok) throw new Error(`couldn't write the workflow (${put.status}${put.status === 404 ? ": missing workflow permission" : ""})`);
  }

  // A just-written workflow can take a few seconds before GitHub accepts dispatches for it.
  for (let attempt = 0; ; attempt++) {
    const d = await api(`/repos/${repo}/actions/workflows/mergepay-link.yml/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: branch, inputs: { wallet } }),
    });
    if (d.status === 204) break;
    if (attempt >= 6) throw new Error(`GitHub didn't start the workflow (${d.status}). Is Actions enabled on ${repo}?`);
    await sleep(2000);
  }
  return `https://github.com/${repo}/actions/workflows/mergepay-link.yml`;
}

/** Handles /auth/login, /auth/link, /auth/callback, /auth/logout. Returns null for other paths. */
export async function handleAuth(req: Request, env: AuthEnv, link?: LinkConfig): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/auth/")) return null;
  // Behind a proxy (Netlify serving mergepay.fun) the worker sees its own workers.dev host, but the
  // browser, its cookies and GitHub's callback live on the public origin.
  const site = env.PUBLIC_ORIGIN || url.origin;
  if (!authConfigured(env)) return new Response("GitHub sign-in is not configured on this deployment.", { status: 503 });

  // /auth/login           -> identity only, no scopes
  // /auth/link?wallet=0x… -> asks for public_repo + workflow once, runs the link, discards the token
  if (url.pathname === "/auth/login" || url.pathname === "/auth/link") {
    const isLink = url.pathname === "/auth/link";
    const wallet = (url.searchParams.get("wallet") ?? "").toLowerCase();
    if (isLink && !/^0x[0-9a-f]{40}$/.test(wallet)) return new Response("wallet must be a 0x address", { status: 400 });
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const next = isLink ? "/app#wallet" : safeNext(url.searchParams.get("next"));
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    gh.searchParams.set("redirect_uri", `${site}/auth/callback`);
    gh.searchParams.set("state", state);
    gh.searchParams.set("allow_signup", "true");
    if (isLink) gh.searchParams.set("scope", "public_repo workflow");
    const payload = JSON.stringify({ state, next, mode: isLink ? "link" : "login", wallet });
    return new Response(null, {
      status: 302,
      headers: { location: gh.toString(), "set-cookie": setCookie(STATE_COOKIE, b64url(enc.encode(payload)), 600) },
    });
  }

  if (url.pathname === "/auth/callback") {
    let st: { state: string; next: string; mode: string; wallet: string } | null = null;
    try {
      st = JSON.parse(new TextDecoder().decode(fromB64url(cookie(req, STATE_COOKIE) ?? "")));
    } catch {}
    const code = url.searchParams.get("code");
    if (!code || !st?.state || url.searchParams.get("state") !== st.state) {
      return new Response("Sign-in expired or was tampered with. Please try again.", { status: 400 });
    }
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${site}/auth/callback`,
      }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return new Response("GitHub didn't return a token. Please try again.", { status: 502 });

    const userRes = await ghApi(access_token)("/user");
    if (!userRes.ok) return new Response("Couldn't read your GitHub profile.", { status: 502 });
    const u = (await userRes.json()) as { id: number; login: string; avatar_url: string };

    let next = safeNext(st.next);
    if (st.mode === "link" && link) {
      try {
        const run = await runOneClickLink(access_token, u.login, st.wallet, link, url.origin);
        next = `/app?linking=${encodeURIComponent(st.wallet)}&run=${encodeURIComponent(run)}#wallet`;
      } catch (e) {
        next = `/app?link_error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}#wallet`;
      }
    }
    // access_token goes out of scope here: never stored, never sent to the browser.

    const session = await signSession(env.SESSION_SECRET!, {
      id: u.id,
      login: u.login,
      avatar: u.avatar_url,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    });
    const headers = new Headers({ location: next });
    headers.append("set-cookie", setCookie(SESSION_COOKIE, session, SESSION_TTL));
    headers.append("set-cookie", setCookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === "/auth/logout") {
    return new Response(null, { status: 302, headers: { location: "/app", "set-cookie": setCookie(SESSION_COOKIE, "", 0) } });
  }

  return new Response("not found", { status: 404 });
}
