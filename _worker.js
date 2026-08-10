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
//   TEAM_IDS               same, for team members
// Owning a Patreon campaign grants nothing on its own — set OWNER_IDS to your
// own Patreon user id (visible at /api/patreon/me once signed in).

import { handleDownload } from './download.js';
import { decodeBuildId } from './buildid.js';

const AUTHORIZE = 'https://www.patreon.com/oauth2/authorize';
const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const IDENTITY =
  'https://www.patreon.com/api/oauth2/v2/identity' +
  '?include=memberships.currently_entitled_tiers' +
  '&fields%5Bmember%5D=patron_status' +
  '&fields%5Buser%5D=full_name,image_url,thumb_url';

const TIERS = {
  supporter:  '5962086',
  packTester: '9234196',
  devCouncil: '6201011',
  legacy:     '5960935'  // deprecated tier — treated exactly as Supporter
};
const EARLY_ACCESS = [TIERS.packTester, TIERS.devCouncil];

const COOKIE = 'phdt';
// Bumped whenever the stored session shape changes in a way that must not be
// honoured from an old cookie. Old versions are rejected, not migrated.
const SESSION_V = 2;

// The built pages are self-unpacking bundles: everything except <title> lives
// inside a template string that only exists once JavaScript runs. Crawlers and
// link unfurlers (Discord, X, Google's first pass) don't run it, so the head
// they see is otherwise empty. These tags are injected server-side instead, and
// because they're derived from the request host, one build is correct on any
// domain — the beta subdomain gets noindex and its own canonical automatically.
const LIVE_HOST = 'primemods.net';

const PAGE_META = {
  '/': {
    desc: "Every vanilla Minecraft texture hand-drawn up to 256\u00d7, with full PBR and 3D depth. Free 32\u00d7 pack, higher resolutions and add-ons on Patreon.",
    ogTitle: "Prime's HD Textures",
    ogDesc: "Minecraft's vanilla textures, just uh\u2026 without the pixels."
  },
  '/downloads': {
    desc: "Build your copy of Prime's HD Textures: pick a resolution from 32\u00d7 to 256\u00d7, add Lush Foliage, PBR Items or Block Overlays, and download one merged pack for Minecraft Java.",
    ogTitle: "Downloads | Prime's HD Textures",
    ogDesc: "Pick a build, a resolution and any add-ons. You get one merged pack, ready to drop into Minecraft."
  }
};

const escAttr = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function isLiveHost(host) {
  return host === LIVE_HOST || host === `www.${LIVE_HOST}`;
}

function headTags(url, path) {
  const meta = PAGE_META[path] || PAGE_META['/'];
  const origin = `https://${url.hostname}`;
  const canonical = path === '/' ? `${origin}/` : `${origin}${path}/`;
  const tags = [
    `<meta name="description" content="${escAttr(meta.desc)}">`,
    '<meta name="theme-color" content="#2b2521">',
    `<link rel="canonical" href="${canonical}">`,
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    `<meta property="og:site_name" content="${escAttr("Prime's HD Textures")}">`,
    `<meta property="og:title" content="${escAttr(meta.ogTitle)}">`,
    `<meta property="og:description" content="${escAttr(meta.ogDesc)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:image" content="${origin}/og-card.jpg">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">'
  ];
  if (!isLiveHost(url.hostname)) tags.push('<meta name="robots" content="noindex, nofollow">');
  return tags.join('');
}

async function serveAsset(request, url, path, env) {
  const res = await env.ASSETS.fetch(request);
  if (!(res.headers.get('content-type') || '').includes('text/html')) {
    // Unhashed asset names are revalidated on every navigation by default, so
    // each page change re-checks every screenshot before it can paint. A short
    // window is enough to cover a page swap without delaying an update.
    if (url.pathname.includes('/uploads/')) {
      const out = new Response(res.body, res);
      out.headers.set('cache-control', 'public, max-age=60');
      return out;
    }
    return res;
  }
  const rewritten = new HTMLRewriter()
    .on('head', { element: el => el.append(headTags(url, path), { html: true }) })
    .transform(res);
  const out = new Response(rewritten.body, rewritten);
  if (!isLiveHost(url.hostname)) out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    // Without COOKIE_SECRET, sessions could be forged and every build id
    // decrypted. Refuse to do anything authenticated rather than quietly
    // falling back to a known string.
    if (p.startsWith('/api/') && !env.COOKIE_SECRET)
      return text('Server misconfigured: COOKIE_SECRET is not set.', 503);

    if (p === '/api/patreon/login')    return login(url, env);
    if (p === '/api/patreon/callback') return callback(request, url, env);
    if (p === '/api/patreon/me')       return me(request, env);
    if (p === '/api/patreon/refresh')  return refresh(request, env);
    if (p === '/api/patreon/logout')   return logout(url);
    if (p === '/api/build-id')         return buildIdLookup(request, env, url);
    if (p === '/api/download') {
      // Entitlement is checked against a re-validated session, so a lapsed
      // patron can't keep pulling paid builds on a stale cookie.
      const { session, cookie } = await revalidate(await readCookie(request, env), env, false);
      const res = await handleDownload(request, env, session);
      if (cookie) res.headers.append('set-cookie', cookie);
      return res;
    }

    return serveAsset(request, url, p, env);
  }
};

/* ---------- routes ---------- */

// Reached over plain http (a typed address with no scheme, before any
// https redirect), url.origin is http:// — and Patreon rejects a redirect URI
// that doesn't match the registered one exactly. The site is https-only, so
// pin the scheme rather than trusting the inbound request's.
function redirectUri(url) {
  return `https://${url.host}/api/patreon/callback`;
}

/* A one-time nonce echoed by Patreon and matched against a cookie only this
   origin can set. Without it, anyone can hand out a link that silently signs a
   visitor into the ATTACKER's Patreon account — which, here, would put someone
   else's id on the leak stamp of every pack they download. */
const STATE_COOKIE = 'phdt_s';

function login(url, env) {
  if (!env.PATREON_CLIENT_ID) return text('PATREON_CLIENT_ID is not set', 500);
  const state = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.PATREON_CLIENT_ID,
    redirect_uri: redirectUri(url),
    scope: 'identity identity.memberships',
    state
  });
  // Lax is enough: the callback arrives as a top-level navigation.
  return new Response(null, {
    status: 302,
    headers: {
      location: `${AUTHORIZE}?${q}`,
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/api/patreon; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

function cookieValue(request, name) {
  const raw = (request.headers.get('cookie') || '')
    .split(/;\s*/)
    .find(c => c.startsWith(`${name}=`));
  return raw ? raw.slice(name.length + 1) : '';
}

const clearState = `${STATE_COOKIE}=; Path=/api/patreon; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

async function callback(request, url, env) {
  const code = url.searchParams.get('code');
  if (!code) return text('Missing code. Patreon denied or cancelled.', 400);

  const expected = cookieValue(request, STATE_COOKIE);
  if (!expected || url.searchParams.get('state') !== expected)
    return text('Login session expired or did not start here. Try signing in again.', 400);

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
  const { access_token, refresh_token } = await tokenRes.json();

  const idRes = await fetch(IDENTITY, {
    headers: { authorization: `Bearer ${access_token}` }
  });
  if (!idRes.ok) return text(`Identity fetch failed: ${await idRes.text()}`, 502);
  const body = await idRes.json();

  const session = buildSession(body, env, { at: access_token, rt: refresh_token });
  if (!session.uid) return text('Patreon returned no account id. Try signing in again.', 502);
  const res = new Response(null, { status: 302, headers: { location: '/downloads' } });
  res.headers.append('set-cookie', await setCookie(session, env));
  res.headers.append('set-cookie', clearState);
  return res;
}

/* Turn a Patreon identity payload into the session we store. Called both at
   login and on every re-check, so the two can never drift apart. */
function buildSession(body, env, tokens) {
  const uid = String(body?.data?.id || '');
  const name = body?.data?.attributes?.full_name || 'Patron';
  const avatar = body?.data?.attributes?.thumb_url ||
                 body?.data?.attributes?.image_url || '';
  const entitled = [];
  for (const inc of body.included || []) {
    if (inc.type !== 'member') continue;
    if (inc.attributes?.patron_status !== 'active_patron') continue;
    for (const t of inc.relationships?.currently_entitled_tiers?.data || []) {
      entitled.push(String(t.id));
    }
  }

  return {
    v: SESSION_V,
    uid,
    name,
    avatar,
    tiers: entitled,
    at: tokens.at,
    rt: tokens.rt,
    ck: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  };
}

/* ---------- entitlements ----------
   Deliberately NOT stored in the cookie. Everything the download endpoint
   checks is recomputed here, on every request, from the account id and the
   tier ids Patreon last reported — so the cookie carries identity, never
   permission. Editing a payload can at most change WHO you claim to be, and
   the signature already stops that.

   OWNER_IDS / TEAM_IDS: comma-separated Patreon user ids with full access.
   Owning a Patreon campaign grants nothing: every creator on Patreon owns
   one, so treating that as proof of being THIS creator handed the Creator
   role to anyone with a campaign of their own. */
const idList = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);

function grants(uid, tiers, env) {
  const entitled = Array.isArray(tiers) ? tiers.map(String) : [];
  const owner = !!uid && idList(env.OWNER_IDS).includes(uid);
  const team = !owner && !!uid && idList(env.TEAM_IDS).includes(uid);
  const staff = owner || team;
  const has = t => entitled.includes(t);

  return {
    owner, team,
    tier: owner ? 'Creator'
      : team ? 'Team Member'
      : has(TIERS.devCouncil) ? 'Development Council'
      : has(TIERS.packTester) ? 'Pack Tester'
      : entitled.length ? 'Supporter'
      : 'Free',
    // Any active entitled tier counts as paid. Matching against a hardcoded
    // list of tier ids silently locks out patrons whenever a tier is added or
    // re-created on Patreon, which is what it did to Supporters.
    paid: staff || entitled.length > 0,
    early: staff || entitled.some(t => EARLY_ACCESS.includes(t))
  };
}

const GRANT_KEYS = ['owner', 'team', 'tier', 'paid', 'early'];

const sessionView = s => ({
  signedIn: true, uid: s.uid, name: s.name, tier: s.tier || 'Supporter',
  avatar: s.avatar || '', paid: !!s.paid, early: !!s.early,
  owner: !!s.owner, team: !!s.team, tiers: s.tiers, checkedAt: s.ck || 0
});

async function me(request, env) {
  const { session, cookie } = await revalidate(await readCookie(request, env), env, false);
  const res = json(session ? sessionView(session) : { signedIn: false });
  if (cookie) res.headers.append('set-cookie', cookie);
  return res;
}

/* The Refresh button. Same work as the hourly check, minus the wait — for the
   patron who just upgraded and wants their new tier now. */
async function refresh(request, env) {
  const cur = await readCookie(request, env);
  if (!cur) return json({ signedIn: false, refreshed: false });
  const { session, cookie, ok } = await revalidate(cur, env, true);
  const res = json({ ...sessionView(session), refreshed: !!ok });
  if (cookie) res.headers.append('set-cookie', cookie);
  return res;
}

/* ---------- keeping the session honest ----------
   The signed cookie is a snapshot of what Patreon said at login. Left alone it
   would happily keep granting a cancelled patron their old tier for a week.
   Once an hour — on whatever request comes first — we ask Patreon again and
   re-issue the cookie. Access tokens are stored in the cookie itself, so this
   needs no database and no re-login.

   Failures never downgrade or sign anyone out: a Patreon outage leaves the
   existing session in place and simply schedules a retry. */
const CHECK_MS = 1000 * 60 * 60;
const RETRY_MS = 1000 * 60 * 5;

const fetchIdentity = token =>
  fetch(IDENTITY, { headers: { authorization: `Bearer ${token}` } });

async function refreshTokens(rt, env) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: env.PATREON_CLIENT_ID,
      client_secret: env.PATREON_CLIENT_SECRET
    })
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function revalidate(session, env, force) {
  if (!session || !session.at) return { session, cookie: null, ok: false };
  if (!force && Date.now() - (session.ck || 0) < CHECK_MS)
    return { session, cookie: null, ok: false };

  // Back off before doing anything, so a failure can't retry on every request.
  const later = async () => {
    const s = { ...session, ck: Date.now() - CHECK_MS + RETRY_MS };
    return { session: s, cookie: await setCookie(s, env), ok: false };
  };

  let at = session.at, rt = session.rt;
  let res;
  try { res = await fetchIdentity(at); } catch { return later(); }

  if (res.status === 401 && rt) {
    const t = await refreshTokens(rt, env);
    if (!t || !t.access_token) return later();
    at = t.access_token;
    rt = t.refresh_token || rt;
    try { res = await fetchIdentity(at); } catch { return later(); }
  }
  if (!res.ok) return later();

  let body;
  try { body = await res.json(); } catch { return later(); }

  const next = buildSession(body, env, { at, rt });
  // A payload for a different account, or none at all, is not a downgrade.
  if (!next.uid || next.uid !== session.uid) return later();
  const cookie = await setCookie(next, env);
  return { session: { ...next, ...grants(next.uid, next.tiers, env) }, cookie, ok: true };
}

/* ---------- leak lookup ----------
   /api/build-id?token=<build_id from the pack> decrypts the stamp back into a
   Patreon user id and hands you the profile link. Owner and team sessions
   only, so a patron who finds their own stamp can't decode it. */
async function buildIdLookup(request, env, url) {
  const s = await readCookie(request, env);
  if (!s || !(s.owner || s.team)) return json({ error: 'Not authorised.' }, 403);

  const token = (url.searchParams.get('token') || url.searchParams.get('id') || '').trim();
  if (!token) return json({ error: 'Pass ?token= the build_id from the pack.' }, 400);
  if (token === 'anonymous')
    return json({ error: 'That build was downloaded without signing in (32× free tier).' }, 200);

  try {
    const uid = await decodeBuildId(token, env.COOKIE_SECRET);
    return json({ userId: uid, profile: `https://www.patreon.com/user?u=${uid}` });
  } catch (e) {
    return json({
      error: 'Couldn’t decode that build id. Either it’s mistyped, or it was ' +
             'issued under a different COOKIE_SECRET.'
    }, 400);
  }
}

/* Only a plain same-origin path is honoured. A leading // is protocol-relative
   outright, and a leading /\ becomes one as soon as the browser normalises the
   backslash — which is how a naive "starts with /" check turns into an open
   redirect. Resolve it and confirm the origin survived. */
function safeNext(next, url) {
  if (!next || next === '/') return '/';
  if (!/^\/[^/\\]/.test(next)) return '/';
  if (/[\u0000-\u001f\\]/.test(next)) return '/';
  try {
    const u = new URL(next, url.origin);
    return u.origin === url.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

function logout(url) {
  const dest = safeNext(url.searchParams.get('next'), url);
  const res = new Response(null, { status: 302, headers: { location: dest } });
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
    enc.encode(env.COOKIE_SECRET),
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
  // Strip anything derived before signing, so a stale grant can never ride
  // along inside a payload and be mistaken for stored truth later.
  const stored = { ...session };
  for (const k of GRANT_KEYS) delete stored[k];
  const payload = b64u(enc.encode(JSON.stringify(stored)));
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
  try {
    const ok = await crypto.subtle.verify(
      'HMAC', await key(env), unb64u(sig), enc.encode(payload)
    );
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    // Cookies minted before grants moved server-side carried their own
    // owner/paid flags. Refuse them outright rather than reason about them.
    if (s.v !== SESSION_V) return null;
    if (!(s.exp > Date.now())) return null;
    return { ...s, ...grants(String(s.uid || ''), s.tiers, env) };
  } catch {
    // Malformed base64 throws out of unb64u; a decode failure is a bad cookie,
    // not a server error.
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
