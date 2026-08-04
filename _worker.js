// Prime's HD Textures — Worker entry.
// Handles Patreon OAuth + serves static assets for everything else.
//
// Required env vars (Worker Settings → Variables):
//   PATREON_CLIENT_ID      plain text
//   PATREON_CLIENT_SECRET  secret
//   COOKIE_SECRET          secret (any long random string)
// Required binding:
//   PACKS                  R2 bucket holding the pack part zips
// Optional:
//   OWNER_IDS              comma-separated Patreon user ids with full access

import { handleDownload } from './download.js';

const AUTHORIZE = 'https://www.patreon.com/oauth2/authorize';
const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const IDENTITY =
  'https://www.patreon.com/api/oauth2/v2/identity' +
  '?include=memberships.currently_entitled_tiers' +
  '&fields%5Bmember%5D=patron_status' +
  '&fields%5Buser%5D=full_name';

const TIERS = {
  supporter:  '5962086',
  packTester: '9234196',
  devCouncil: '6201011',
  legacy:     '5960935'  // deprecated tier — treated exactly as Supporter
};
const EARLY_ACCESS = [TIERS.packTester, TIERS.devCouncil];
const PAID = Object.values(TIERS);

const COOKIE = 'phdt';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/api/patreon/login')    return login(url, env);
    if (p === '/api/patreon/callback') return callback(url, env);
    if (p === '/api/patreon/me')       return me(request, env);
    if (p === '/api/patreon/logout')   return logout(url);
    if (p === '/api/download')         return handleDownload(request, env, await readCookie(request, env));

    return env.ASSETS.fetch(request);
  }
};

/* ---------- routes ---------- */

function redirectUri(url) {
  return `${url.origin}/api/patreon/callback`;
}

function login(url, env) {
  if (!env.PATREON_CLIENT_ID) return text('PATREON_CLIENT_ID is not set', 500);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.PATREON_CLIENT_ID,
    redirect_uri: redirectUri(url),
    scope: 'identity identity.memberships'
  });
  return Response.redirect(`${AUTHORIZE}?${q}`, 302);
}

async function callback(url, env) {
  const code = url.searchParams.get('code');
  if (!code) return text('Missing code — Patreon denied or cancelled.', 400);

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: env.PATREON_CLIENT_ID,
      client_secret: env.PATREON_CLIENT_SECRET,
      redirect_uri: redirectUri(url)
    })
  });
  if (!tokenRes.ok) return text(`Token exchange failed: ${await tokenRes.text()}`, 502);
  const { access_token } = await tokenRes.json();

  const idRes = await fetch(IDENTITY, {
    headers: { authorization: `Bearer ${access_token}` }
  });
  if (!idRes.ok) return text(`Identity fetch failed: ${await idRes.text()}`, 502);
  const body = await idRes.json();

  const uid = String(body?.data?.id || '');
  const name = body?.data?.attributes?.full_name || 'Patron';
  const entitled = [];
  for (const inc of body.included || []) {
    if (inc.type !== 'member') continue;
    if (inc.attributes?.patron_status !== 'active_patron') continue;
    for (const t of inc.relationships?.currently_entitled_tiers?.data || []) {
      entitled.push(String(t.id));
    }
  }

  // OWNER_IDS: comma-separated Patreon user ids that always get full access,
  // regardless of what they're subscribed to.
  const owner = (env.OWNER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean).includes(uid);

  const has = t => entitled.includes(t);
  const tier = owner ? 'Creator'
    : has(TIERS.devCouncil) ? 'Development Council'
    : has(TIERS.packTester) ? 'Pack Tester'
    : 'Supporter';

  const session = {
    uid,
    name,
    tier,
    tiers: entitled,
    owner,
    paid: owner || entitled.some(t => PAID.includes(t)),
    early: owner || entitled.some(t => EARLY_ACCESS.includes(t)),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  };

  const res = new Response(null, { status: 302, headers: { location: '/downloads' } });
  res.headers.append('set-cookie', await setCookie(session, env));
  return res;
}

async function me(request, env) {
  const s = await readCookie(request, env);
  return json(
    s
      ? { signedIn: true, uid: s.uid, name: s.name, tier: s.tier || 'Supporter',
          paid: !!s.paid, early: !!s.early, owner: !!s.owner, tiers: s.tiers }
      : { signedIn: false }
  );
}

function logout(url) {
  const res = new Response(null, { status: 302, headers: { location: '/' } });
  res.headers.append(
    'set-cookie',
    `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  );
  return res;
}

/* ---------- signed cookie ---------- */

const enc = new TextEncoder();

async function key(env) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(env.COOKIE_SECRET || 'dev-only-insecure-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

const b64u = buf =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64u = s =>
  Uint8Array.from(
    atob(s.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );

async function setCookie(session, env) {
  const payload = b64u(enc.encode(JSON.stringify(session)));
  const sig = b64u(await crypto.subtle.sign('HMAC', await key(env), enc.encode(payload)));
  const maxAge = 60 * 60 * 24 * 7;
  return `${COOKIE}=${payload}.${sig}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function readCookie(request, env) {
  const raw = (request.headers.get('cookie') || '')
    .split(/;\s*/)
    .find(c => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const ok = await crypto.subtle.verify(
    'HMAC', await key(env), unb64u(sig), enc.encode(payload)
  );
  if (!ok) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/* ---------- helpers ---------- */

const text = (t, status = 200) =>
  new Response(t, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
