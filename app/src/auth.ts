// "Sign in with GitHub" for the app dashboard.
//
// This proves who is *viewing* the dashboard. It is not what protects funds: payouts only go to a
// wallet proven by GitHub's own OIDC token (the link workflow), verified on-chain. The OAuth access
// token is used once to read /user and then discarded; the session cookie holds only id + login.

export interface AuthEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
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

/** Handles /auth/login, /auth/callback, /auth/logout. Returns null for other paths. */
export async function handleAuth(req: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/auth/")) return null;
  if (!authConfigured(env)) return new Response("GitHub sign-in is not configured on this deployment.", { status: 503 });

  if (url.pathname === "/auth/login") {
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const next = safeNext(url.searchParams.get("next"));
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    gh.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
    gh.searchParams.set("state", state);
    gh.searchParams.set("allow_signup", "true");
    // No scopes: public profile only.
    return new Response(null, {
      status: 302,
      headers: { location: gh.toString(), "set-cookie": setCookie(STATE_COOKIE, `${state}|${next}`, 600) },
    });
  }

  if (url.pathname === "/auth/callback") {
    const [expected, next] = (cookie(req, STATE_COOKIE) ?? "").split("|");
    const code = url.searchParams.get("code");
    if (!code || !expected || url.searchParams.get("state") !== expected) {
      return new Response("Sign-in expired or was tampered with. Please try again.", { status: 400 });
    }
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/auth/callback`,
      }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return new Response("GitHub didn't return a token. Please try again.", { status: 502 });

    const userRes = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${access_token}`, accept: "application/vnd.github+json", "user-agent": "mergepay" },
    });
    if (!userRes.ok) return new Response("Couldn't read your GitHub profile.", { status: 502 });
    const u = (await userRes.json()) as { id: number; login: string; avatar_url: string };
    // access_token goes out of scope here: never stored, never sent to the browser.

    const session = await signSession(env.SESSION_SECRET!, {
      id: u.id,
      login: u.login,
      avatar: u.avatar_url,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    });
    const headers = new Headers({ location: safeNext(next ?? null) });
    headers.append("set-cookie", setCookie(SESSION_COOKIE, session, SESSION_TTL));
    headers.append("set-cookie", setCookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === "/auth/logout") {
    return new Response(null, { status: 302, headers: { location: "/app", "set-cookie": setCookie(SESSION_COOKIE, "", 0) } });
  }

  return new Response("not found", { status: 404 });
}
