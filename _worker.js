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
//   PATREON_WEBHOOK_SECRET secret — enables /api/patreon/webhook (see README)
// Optional binding:
//   TIERS_KV               KV namespace; webhooks flag changed accounts here so
//                          the next request re-checks Patreon immediately, and
//                          the creator's live site settings live under 'site'
// Owning a Patreon campaign grants nothing on its own — set OWNER_IDS to your
// own Patreon user id (visible at /api/patreon/me once signed in).

import { handleDownload } from './download.js';
import { decodeBuildId } from './buildid.js';

const AUTHORIZE = 'https://www.patreon.com/oauth2/authorize';
const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';
const IDENTITY =
  'https://www.patreon.com/api/oauth2/v2/identity' +
  '?include=memberships.currently_entitled_tiers' +
  '&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents,last_charge_status' +
  '&fields%5Btier%5D=amount_cents,title' +
  '&fields%5Buser%5D=full_name,image_url,thumb_url';

const TIERS = {
  supporter:  '5962086',
  packTester: '9234196',
  devCouncil: '6201011',
  legacy:     '5960935'  // deprecated tier — treated exactly as Supporter
};
const EARLY_ACCESS = [TIERS.packTester, TIERS.devCouncil];
// Recorded when someone pays but Patreon reports no tier for the pledge, so
// "is paying" never has to be inferred from a tier id.
const PAYING = 'paying';

const COOKIE = 'phdt';
// Bumped whenever the stored session shape changes in a way that must not be
// honoured from an old cookie. Old versions are rejected, not migrated.
const SESSION_V = 4;

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
    if (p === '/api/patreon/debug')    return debugIdentity(request, env);
    if (p === '/api/patreon/webhook')  return webhook(request, env);
    if (p === '/api/site')             return request.method === 'GET' ? siteGet(env) : sitePost(request, env);
    if (p === '/api/patreon/logout')   return logout(url);
    if (p === '/api/build-id')         return buildIdLookup(request, env, url);
    if (p === '/api/download') {
      // Entitlement is checked against a re-validated session, so a lapsed
      // patron can't keep pulling paid builds on a stale cookie. Downloads are
      // the access-critical path, so they tolerate a much shorter snapshot age
      // than page loads do.
      const { session, cookie } = await revalidate(await readCookie(request, env), env, false, DOWNLOAD_CHECK_MS);
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
  // Patreon's free membership is a real tier: someone who joins a campaign at
  // $0 comes back as an active_patron entitled to it, so membership alone is
  // never proof of payment.
  //
  // The authority here is the MEMBER's currently_entitled_amount_cents — what
  // this account is entitled to right now, in cents. It is on the member
  // object, so unlike a tier price it is present even when the payload carries
  // no tier objects at all (which is how the previous id-list fallback ended
  // up granting the free tier: the free tier reused a known paid tier id).
  const tierCents = new Map();
  for (const inc of body.included || []) {
    if (inc.type !== 'tier') continue;
    tierCents.set(String(inc.id), Number(inc.attributes?.amount_cents));
  }

  const entitled = [];
  let pledge = 0;
  for (const inc of body.included || []) {
    if (inc.type !== 'member') continue;
    const a = inc.attributes || {};
    if (a.patron_status !== 'active_patron') continue;

    const ids = (inc.relationships?.currently_entitled_tiers?.data || [])
      .map(t => String(t.id));
    const memberCents = Number(a.currently_entitled_amount_cents);
    // Fall back to the summed tier prices only when the member field is
    // absent — never to a list of ids.
    const cents = Number.isFinite(memberCents) ? memberCents
      : ids.reduce((n, id) => n + (Number(tierCents.get(id)) || 0), 0);
    if (!(cents > 0)) continue;

    pledge = Math.max(pledge, cents);
    // Keep the tier ids for role labels (Pack Tester, Dev Council), but only
    // from a membership that is actually paying.
    for (const id of ids) if (!entitled.includes(id)) entitled.push(id);
    // A pledge with no tier attached still counts as paid.
    if (!ids.length && !entitled.includes(PAYING)) entitled.push(PAYING);
  }

  return {
    v: SESSION_V,
    uid,
    name,
    avatar,
    tiers: entitled,
    pc: pledge,
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
    // entitled only ever holds tiers from a membership whose pledge is above
    // zero (see buildSession), so any entry means money — no id list involved.
    paid: staff || entitled.length > 0,
    early: staff || entitled.some(t => EARLY_ACCESS.includes(t))
  };
}

const GRANT_KEYS = ['owner', 'team', 'tier', 'paid', 'early'];

const sessionView = s => ({
  signedIn: true, uid: s.uid, name: s.name, tier: s.tier || 'Free',
  avatar: s.avatar || '', paid: !!s.paid, early: !!s.early, pledgeCents: s.pc || 0, checkedAt: s.ck || 0,
  owner: !!s.owner, team: !!s.team, tiers: s.tiers
});

async function me(request, env) {
  const { session, cookie } = await revalidate(await readCookie(request, env), env, false);
  const res = json(session ? sessionView(session) : { signedIn: false });
  if (cookie) res.headers.append('set-cookie', cookie);
  return res;
}

/* Owner/team-only view of the raw Patreon answer for the signed-in account:
   what the previous fix was missing was any way to see the payload. Returns
   membership status, pledge cents and tier ids — never tokens. */
async function debugIdentity(request, env) {
  const session = await readCookie(request, env);
  if (!session || !(session.owner || session.team)) return json({ error: 'not allowed' }, 403);
  let body;
  try {
    const res = await fetchIdentity(session.at);
    if (!res.ok) return json({ error: 'patreon ' + res.status }, 502);
    body = await res.json();
  } catch (e) { return json({ error: String(e) }, 502); }

  const tiers = (body.included || []).filter(i => i.type === 'tier')
    .map(i => ({ id: String(i.id), title: i.attributes?.title, amount_cents: i.attributes?.amount_cents }));
  const members = (body.included || []).filter(i => i.type === 'member').map(i => ({
    patron_status: i.attributes?.patron_status,
    currently_entitled_amount_cents: i.attributes?.currently_entitled_amount_cents,
    last_charge_status: i.attributes?.last_charge_status,
    tier_ids: (i.relationships?.currently_entitled_tiers?.data || []).map(t => String(t.id))
  }));
  const built = buildSession(body, env, { at: session.at, rt: session.rt });
  return json({
    uid: String(body?.data?.id || ''),
    members, tiers,
    resolved: { tiers: built.tiers, pledgeCents: built.pc },
    grants: grants(built.uid, built.tiers, env)
  });
}

/* Patreon → us. Registered in the Patreon developer portal against
   https://<host>/api/patreon/webhook for the members:* and members:pledge:*
   triggers. The body is verified with HMAC-MD5 over the raw bytes using the
   webhook's own secret (X-Patreon-Signature), exactly as Patreon documents.
   We store nothing from the payload except that the account changed: the
   next request re-derives everything from the identity API, which keeps a
   single source of truth. */
async function webhook(request, env) {
  if (request.method !== 'POST') return text('POST only', 405);
  if (!env.PATREON_WEBHOOK_SECRET) return text('PATREON_WEBHOOK_SECRET is not set.', 503);
  const raw = new Uint8Array(await request.arrayBuffer());
  const sig = (request.headers.get('x-patreon-signature') || '').toLowerCase();
  const expect = hmacMd5Hex(enc.encode(env.PATREON_WEBHOOK_SECRET), raw);
  if (!timingEqual(sig, expect)) return text('Bad signature.', 401);

  let body;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return text('Bad JSON.', 400); }
  const uid = String(body?.data?.relationships?.user?.data?.id || '');
  const event = request.headers.get('x-patreon-event') || '';
  if (!uid) return json({ ok: true, ignored: 'no user id', event });
  if (!env.TIERS_KV) return json({ ok: true, ignored: 'TIERS_KV not bound', event });
  // Cookies live 7 days; the stamp only has to outlive the oldest cookie.
  await env.TIERS_KV.put('dirty:' + uid, String(Date.now()), { expirationTtl: 60 * 60 * 24 * 8 });
  return json({ ok: true, uid, event });
}

function md5(bytes) {
  const K = new Uint32Array(64), S = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const n = bytes.length, padLen = (((n + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(padLen); buf.set(bytes); buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, (n * 8) >>> 0, true);
  dv.setUint32(padLen - 4, Math.floor(n / 536870912), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const s = S[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}
const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
function hmacMd5Hex(keyBytes, msg) {
  if (keyBytes.length > 64) keyBytes = md5(keyBytes);
  const k = new Uint8Array(64); k.set(keyBytes);
  const ipad = k.map(b => b ^ 0x36), opad = k.map(b => b ^ 0x5c);
  const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  return hex(md5(cat(opad, md5(cat(ipad, msg)))));
}
function timingEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* The Refresh button. Same work as the periodic check, minus the wait — for the
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
   Three things keep the snapshot current, fastest first:

   1. Patreon webhooks. A pledge create/update/delete for this campaign hits
      /api/patreon/webhook, which stamps dirty:<uid> in KV. The very next
      request from that account — page load, focus re-check, download — sees
      the stamp is newer than its snapshot and re-asks Patreon right away.
   2. A short periodic check (CHECK_MS) on whatever request comes first, for
      when webhooks or KV are not configured.
   3. Downloads re-check after DOWNLOAD_CHECK_MS regardless, and the client's
      Refresh / "I just upgraded" path forces one.

   Access tokens are stored in the cookie itself, so none of this needs a
   re-login. Failures never downgrade or sign anyone out: a Patreon outage
   leaves the existing session in place and simply schedules a retry. */
const CHECK_MS = 1000 * 60 * 10;
const DOWNLOAD_CHECK_MS = 1000 * 60 * 2;
const RETRY_MS = 1000 * 60 * 5;
// After a failed attempt, a webhook stamp may not retrigger sooner than this.
const DIRTY_RETRY_MS = 1000 * 30;

/* Webhook stamp for one account: the ms timestamp of the last change Patreon
   told us about, or 0 when there is none / no KV bound. */
async function dirtySince(uid, env) {
  if (!env.TIERS_KV || !uid) return 0;
  try { return Number(await env.TIERS_KV.get('dirty:' + uid)) || 0; } catch { return 0; }
}

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

async function revalidate(session, env, force, maxAge = CHECK_MS) {
  if (!session || !session.at) return { session, cookie: null, ok: false };
  const now = Date.now();
  if (!force && now - (session.ck || 0) < maxAge) {
    // Snapshot is young — unless a webhook has flagged this account since it
    // was taken, in which case it is stale no matter how young it is.
    const dirty = await dirtySince(session.uid, env);
    const stale = dirty > (session.ck || 0) && now - (session.la || 0) > DIRTY_RETRY_MS;
    if (!stale) return { session, cookie: null, ok: false };
  }

  // Back off before doing anything, so a failure can't retry on every request.
  const later = async () => {
    const s = { ...session, ck: Date.now() - CHECK_MS + RETRY_MS, la: Date.now() };
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


/* ---------- live site settings ----------
   Small things the creator changes between builds — version names, changelog
   links, whether the preview build is open. Stored as one JSON record in KV,
   read by the Downloads page on load, edited through an owner-only panel.

   Who may write: decided HERE, never by the client. The phdt cookie is HMAC-
   signed, so its uid cannot be forged; owner status is derived from that uid
   against OWNER_IDS on every request. The "owner" flag the page uses only
   decides whether to draw the form. */
const SITE_KEY = 'site';
const SITE_DEFAULTS = {
  currentName: 'Update 56',
  currentLink: 'https://www.patreon.com/primemods/posts/out-now-clarity-168328467?pr=true',
  previewName: 'Update 57 - Preview 1',
  previewLink: 'https://www.patreon.com/primemods/posts/coming-sep-1st-168105932',
  previewEnabled: false,
  previewSoonLabel: 'COMING SEPTEMBER'
};
const SITE_FIELDS = Object.keys(SITE_DEFAULTS);

async function readSite(env) {
  let stored = null;
  if (env.TIERS_KV) {
    try { const raw = await env.TIERS_KV.get(SITE_KEY); stored = raw ? JSON.parse(raw) : null; } catch { stored = null; }
  }
  const out = { ...SITE_DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const k of SITE_FIELDS) if (k in stored) out[k] = stored[k];
    out.updatedAt = Number(stored.updatedAt) || 0;
  }
  return out;
}

/* Strict allow-list validation. Anything not matching is a 400 — no partial
   writes. Links must be https so a stored value can never become a
   javascript: href; text is trimmed and stripped of control characters. */
function cleanSite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Body must be an object.' };
  for (const k of Object.keys(input)) if (!SITE_FIELDS.includes(k)) return { error: 'Unknown field: ' + k };
  const out = {};
  const str = (k, max) => {
    const v = input[k];
    if (typeof v !== 'string') return k + ' must be text.';
    const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!t || t.length > max) return k + ' must be 1-' + max + ' characters.';
    out[k] = t;
  };
  const link = (k) => {
    const v = input[k];
    if (typeof v !== 'string' || v.length > 400) return k + ' must be a link under 400 characters.';
    let u; try { u = new URL(v.trim()); } catch { return k + ' is not a valid link.'; }
    if (u.protocol !== 'https:') return k + ' must start with https://';
    out[k] = u.href;
  };
  const e = str('currentName', 60) || link('currentLink') || str('previewName', 60) || link('previewLink') || str('previewSoonLabel', 40);
  if (e) return { error: e };
  if (typeof input.previewEnabled !== 'boolean') return { error: 'previewEnabled must be true or false.' };
  out.previewEnabled = input.previewEnabled;
  return { value: out };
}

async function siteGet(env) {
  const res = json(await readSite(env));
  res.headers.set('cache-control', 'no-store');
  return res;
}

async function sitePost(request, env) {
  if (request.method !== 'POST') return text('POST only', 405);
  // Same-origin only. The cookie is SameSite=Lax, which already keeps it off
  // cross-site POSTs; the Origin check and the custom header (which forces a
  // CORS preflight this Worker never answers) close the remaining gaps.
  const url = new URL(request.url);
  let originHost = '';
  try { originHost = new URL(request.headers.get('origin') || '').host; } catch { originHost = ''; }
  if (!originHost || originHost !== url.host) return text('Cross-origin request refused.', 403);
  if (request.headers.get('x-phdt') !== 'site') return text('Missing request header.', 403);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return text('JSON only.', 415);

  const session = await readCookie(request, env);          // signature-checked
  if (!session || !session.uid) return text('Sign in first.', 401);
  const g = grants(session.uid, session.tiers, env);        // OWNER_IDS, server-side
  if (!g.owner) return text('Creator account only.', 403);
  if (!env.TIERS_KV) return text('TIERS_KV is not bound.', 503);

  let body;
  try { body = await request.json(); } catch { return text('Bad JSON.', 400); }
  const { value, error } = cleanSite(body);
  if (error) return json({ ok: false, error }, 400);
  await env.TIERS_KV.put(SITE_KEY, JSON.stringify({ ...value, updatedAt: Date.now(), updatedBy: session.uid }));
  return json({ ok: true, site: await readSite(env) });
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
