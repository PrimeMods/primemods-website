// Prime's HD Textures — /api/download
//
// Builds the user's pack on the fly: pulls the pre-built part zips out of R2
// and streams them into ONE outer .zip, plus a stamp file tied to their
// Patreon account. Nothing is buffered — memory stays flat regardless of the
// pack size, so 256× + every add-on is fine.
//
// The outer zip uses the STORE method (no compression). The parts are already
// deflated zips, so re-compressing would burn CPU for ~0% gain.

const PARTS_LIMIT_GB = 4; // standard zip offsets; see note in guide

/* ---------- R2 key layout ----------
   base/<res>.zip                       32 | 64 | 128 | 256
   addons/<slug>/<res>.zip              per-resolution add-on
   addons/<slug>/any.zip                fallback if an add-on is res-agnostic
   early/current.zip                    the early access preview build
------------------------------------- */

const RESOLUTIONS = [32, 64, 128, 256];
const ADDONS = {
  'lush-foliage':   'Lush Foliage',
  'pbr-items':      'PBR Items',
  'block-overlays': 'Block Overlays'
};

export async function handleDownload(request, env, session) {
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const res = parseInt(url.searchParams.get('res') || '32', 10);
  const slugs = (url.searchParams.get('addons') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const early = url.searchParams.get('early') === '1';

  if (!RESOLUTIONS.includes(res)) return err('Unknown resolution.', check, 400);
  for (const s of slugs) if (!ADDONS[s]) return err('Unknown add-on.', check, 400);

  // ---- entitlements ----
  const signedIn = !!session;
  const paid = !!(session && session.paid);
  const canEarly = !!(session && session.early);

  if (res !== 32 && !paid)
    return err('64× and up need a paid Patreon tier.', check, 403);
  if (slugs.length && !paid)
    return err('Add-ons need a paid Patreon tier.', check, 403);
  if (early && !canEarly)
    return err('Early access is for Pack Tester and Development Council members.', check, 403);

  if (!env.PACKS) return err('File storage isn\u2019t configured yet.', check, 503);

  // ---- resolve the parts ----
  const parts = [];
  parts.push({ name: `PrimesHDTextures_${res}x.zip`, key: `base/${res}.zip` });
  for (const s of slugs) {
    parts.push({
      name: `Addon_${ADDONS[s].replace(/ /g, '')}_${res}x.zip`,
      keys: [`addons/${s}/${res}.zip`, `addons/${s}/any.zip`]
    });
  }
  if (early) parts.push({ name: 'EarlyAccess_Preview.zip', key: 'early/current.zip' });

  // Head each part so a missing file is a clean error, not a truncated zip.
  for (const p of parts) {
    const candidates = p.keys || [p.key];
    let found = null;
    for (const k of candidates) {
      const h = await env.PACKS.head(k);
      if (h) { found = k; p.size = h.size; break; }
    }
    if (!found) return err(`That build isn\u2019t uploaded yet (${candidates[0]}).`, check, 404);
    p.key = found;
  }

  const total = parts.reduce((n, p) => n + p.size, 0);
  if (total > PARTS_LIMIT_GB * 1024 ** 3)
    return err('That combination is too large to package.', check, 413);

  if (check) return json({ ok: true, parts: parts.length, bytes: total });

  // ---- stamp ----
  const stampId = await stamp(session, env);
  const stampFile =
    `Prime's HD Textures\r\n` +
    `Build: Beta 55 · Minecraft Java 26.2\r\n` +
    `Resolution: ${res}x\r\n` +
    `Add-ons: ${slugs.length ? slugs.map(s => ADDONS[s]).join(', ') : 'none'}\r\n` +
    `Early access: ${early ? 'yes' : 'no'}\r\n` +
    `Packaged: ${new Date().toISOString()}\r\n` +
    `Build ID: ${stampId}\r\n\r\n` +
    `This copy was built for a single Patreon supporter and the Build ID above\r\n` +
    `identifies the account it was issued to. Please don't redistribute it.\r\n`;

  const filename = 'PrimesHDTextures_' + res + 'x' +
    (slugs.length ? '+' + slugs.length + 'addons' : '') +
    (early ? '_EarlyAccess' : '') + '_Beta55.zip';

  const body = zipStream(parts, stampFile, stampId, env);

  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-build-id': stampId
    }
  });
}

/* ---------- the stamp ----------
   An HMAC of the Patreon user id, not the name. Nothing personal ends up in
   the file, but you can identify a leaked build by running the same HMAC over
   your patron list and matching the Build ID. */
async function stamp(session, env) {
  const seed = session ? (session.name || '') + '|' + (session.tiers || []).join(',') : 'anonymous';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.COOKIE_SECRET || 'dev-only-insecure-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(seed));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}

/* ---------- streaming STORE zip ----------
   Entries are written with a data descriptor (bit 3) so the CRC can be
   computed while the bytes flow through, with no second pass over the file. */
function zipStream(parts, stampText, stampId, env) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();

  (async () => {
    const dir = [];
    let offset = 0;

    const write = async bytes => { await w.write(bytes); offset += bytes.length; };

    const entry = async (name, source, knownSize) => {
      const nameBytes = new TextEncoder().encode(name);
      const start = offset;
      await write(localHeader(nameBytes));

      let crc = 0xFFFFFFFF, size = 0;
      if (source instanceof Uint8Array) {
        crc = crc32(source, crc); size = source.length;
        await write(source);
      } else {
        const reader = source.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = new Uint8Array(value);
          crc = crc32(chunk, crc); size += chunk.length;
          await write(chunk);
        }
      }
      crc = (crc ^ 0xFFFFFFFF) >>> 0;
      await write(dataDescriptor(crc, size));
      dir.push({ nameBytes, crc, size, start });
    };

    try {
      await entry('BUILD-INFO.txt', new TextEncoder().encode(stampText));
      for (const p of parts) {
        const obj = await env.PACKS.get(p.key);
        if (!obj) throw new Error('missing ' + p.key);
        await entry(p.name, obj.body, p.size);
      }

      const dirStart = offset;
      for (const e of dir) await write(centralHeader(e));
      await w.write(endRecord(dir.length, offset - dirStart, dirStart, stampId));
      await w.close();
    } catch (e) {
      await w.abort(e);
    }
  })();

  return readable;
}

/* ---------- zip records ---------- */

const u16 = (v, a, i) => { a[i] = v & 255; a[i + 1] = (v >>> 8) & 255; };
const u32 = (v, a, i) => { a[i] = v & 255; a[i + 1] = (v >>> 8) & 255; a[i + 2] = (v >>> 16) & 255; a[i + 3] = (v >>> 24) & 255; };

function localHeader(nameBytes) {
  const b = new Uint8Array(30 + nameBytes.length);
  u32(0x04034b50, b, 0);
  u16(20, b, 4);      // version needed
  u16(0x0808, b, 6);  // bit 3 data descriptor + bit 11 UTF-8 names
  u16(0, b, 8);       // method: store
  b.set(nameBytes, 30);
  u16(nameBytes.length, b, 26);
  return b;
}

function dataDescriptor(crc, size) {
  const b = new Uint8Array(16);
  u32(0x08074b50, b, 0);
  u32(crc, b, 4);
  u32(size, b, 8);
  u32(size, b, 12);
  return b;
}

function centralHeader(e) {
  const b = new Uint8Array(46 + e.nameBytes.length);
  u32(0x02014b50, b, 0);
  u16(20, b, 4);
  u16(20, b, 6);
  u16(0x0808, b, 8);
  u16(0, b, 10);
  u32(e.crc, b, 16);
  u32(e.size, b, 20);
  u32(e.size, b, 24);
  u16(e.nameBytes.length, b, 28);
  u32(e.start, b, 42);
  b.set(e.nameBytes, 46);
  return b;
}

// The Build ID also goes in the archive comment — invisible in Explorer and
// Finder, and it survives the zip being re-uploaded as-is.
function endRecord(count, dirSize, dirStart, stampId) {
  const comment = new TextEncoder().encode('PHDT-' + stampId);
  const b = new Uint8Array(22 + comment.length);
  u32(0x06054b50, b, 0);
  u16(count, b, 8);
  u16(count, b, 10);
  u32(dirSize, b, 12);
  u32(dirStart, b, 16);
  u16(comment.length, b, 20);
  b.set(comment, 22);
  return b;
}

/* ---------- crc32 ---------- */

let TABLE = null;
function crc32(bytes, crc) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return c >>> 0;
}

/* ---------- responses ---------- */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

function err(message, check, status) {
  if (check) return json({ ok: false, error: message }, 200);
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
