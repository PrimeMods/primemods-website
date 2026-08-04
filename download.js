// Prime's HD Textures — /api/download
//
// Assembles ONE ready-to-load resource pack. The base pack and every selected
// add-on / early-access pack share the same file structure, so add-ons are
// overlaid onto the base: last source to declare a path wins.
//
// Nothing is inflated. Each source zip's central directory tells us the
// compressed bytes, CRC and method for every file, so entries are copied
// verbatim into the output zip. Memory stays flat and CPU stays low no matter
// how large the pack is.
//
// R2 key layout — every object is a normal resource pack .zip:
//   base/<res>.zip                 32 | 64 | 128 | 256
//   addons/<slug>.zip              one file each, resolution agnostic
//   early/<res>.zip

const RESOLUTIONS = [32, 64, 128, 256];

// Overlay order: later sources override earlier ones on a path collision.
const ADDONS = {
  'lush-foliage':   'Lush Foliage',
  'pbr-items':      'PBR Items',
  'block-overlays': 'Block Overlays'
};
const ADDON_ORDER = ['lush-foliage', 'pbr-items', 'block-overlays'];

// Always taken from the base pack — an add-on's copies are ignored.
const BASE_OWNED = new Set(['pack.png', 'pack.mcmeta']);

const BUILD_LABEL = 'Beta 55';
const MC_LABEL = 'Minecraft Java 26.2';

export async function handleDownload(request, env, session) {
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const res = parseInt(url.searchParams.get('res') || '32', 10);
  const slugs = ADDON_ORDER.filter(s =>
    (url.searchParams.get('addons') || '').split(',').map(x => x.trim()).includes(s));
  const early = url.searchParams.get('early') === '1';

  if (!RESOLUTIONS.includes(res)) return err('Unknown resolution.', check, 400);

  const paid = !!(session && session.paid);
  const canEarly = !!(session && session.early);
  if (res !== 32 && !paid) return err('64× and up need a paid Patreon tier.', check, 403);
  if (slugs.length && !paid) return err('Add-ons need a paid Patreon tier.', check, 403);
  if (early && !canEarly)
    return err('Early access is for Pack Tester and Development Council members.', check, 403);
  if (!env.PACKS) return err('File storage isn\u2019t configured yet.', check, 503);

  const sources = [{ label: 'base', key: `base/${res}.zip` }];
  for (const s of slugs) sources.push({ label: ADDONS[s], key: `addons/${s}.zip` });
  if (early) sources.push({ label: 'Early access', key: `early/${res}.zip` });

  for (const s of sources) {
    const h = await env.PACKS.head(s.key);
    if (!h) return err(`That build isn\u2019t uploaded yet (${s.key}).`, check, 404);
    s.size = h.size;
  }

  let plan;
  try {
    plan = await buildPlan(env, sources, { res, slugs, early, session });
  } catch (e) {
    return err('Couldn\u2019t read one of the pack files: ' + e.message, check, 500);
  }

  if (check)
    return json({ ok: true, files: plan.entries.length, bytes: plan.totalBytes, sources: sources.length });

  const filename = 'PrimesHDTextures_' + res + 'x' +
    (slugs.length ? '+' + slugs.length + 'addons' : '') +
    (early ? '_EarlyAccess' : '') + '_' + BUILD_LABEL.replace(/\s+/g, '') + '.zip';

  return new Response(streamZip(env, plan), {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(plan.totalBytes),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-build-id': plan.buildId
    }
  });
}

/* ---------------- planning ----------------
   Read every source's central directory, resolve the overlay, then lay out
   the output byte-for-byte so we can send an exact Content-Length. */

async function buildPlan(env, sources, opts) {
  for (const s of sources) s.index = await readZipIndex(env.PACKS, s.key, s.size);

  // Resolve overlay: later source wins, except the base-owned root files.
  const owner = new Map();
  sources.forEach((s, si) => {
    for (const e of s.index.entries) {
      if (e.dir) continue;
      if (si > 0 && BASE_OWNED.has(e.name)) continue;
      owner.set(e.name, si);
    }
  });

  const buildId = await stamp(opts.session, env);

  // Generated entries replace / add to what came out of the zips.
  const generated = [];
  const meta = await packMeta(env, sources[0], opts, buildId);
  if (meta) { generated.push(meta); owner.delete('pack.mcmeta'); }
  generated.push(storedEntry('phdt_build.txt', buildInfo(opts, buildId, sources)));

  // Output order: base entries first, then each overlay's new files.
  const entries = [];
  sources.forEach((s, si) => {
    for (const e of s.index.entries) {
      if (e.dir || owner.get(e.name) !== si) continue;
      entries.push({ ...e, sourceIndex: si });
    }
  });
  entries.push(...generated);

  // Lay out offsets.
  let offset = 0;
  for (const e of entries) {
    e.nameBytes = new TextEncoder().encode(e.name);
    e.localOffset = offset;
    offset += 30 + e.nameBytes.length + e.compSize;
  }
  const dirStart = offset;
  let dirSize = 0;
  for (const e of entries) {
    e.zip64 = e.localOffset > 0xFFFFFFFE;
    dirSize += 46 + e.nameBytes.length + (e.zip64 ? 12 : 0);
  }
  const needZip64 = dirStart + dirSize > 0xFFFFFFFE || entries.length > 0xFFFE;
  const comment = new TextEncoder().encode('PHDT-' + buildId);
  const totalBytes = dirStart + dirSize +
    (needZip64 ? 56 + 20 : 0) + 22 + comment.length;

  return { sources, entries, dirStart, dirSize, needZip64, comment, totalBytes, buildId };
}

/* Rewrites pack.mcmeta so the in-game pack list names what was built. The
   file is a couple hundred bytes, so inflating it is free. Build ID rides
   along in a custom key Minecraft ignores. */
async function packMeta(env, base, opts, buildId) {
  try {
    const e = base.index.entries.find(x => x.name === 'pack.mcmeta');
    if (!e) return null;
    let bytes = await readEntryBytes(env.PACKS, base.key, e);
    if (e.method === 8) bytes = await inflateRaw(bytes);
    else if (e.method !== 0) return null;
    const meta = JSON.parse(new TextDecoder().decode(bytes));
    if (!meta.pack) return null;

    const bits = [opts.res + '×'];
    for (const s of opts.slugs) bits.push(ADDONS[s]);
    if (opts.early) bits.push('Early access');
    meta.pack.description = `Prime's HD Textures ${BUILD_LABEL}\n§7${bits.join(' · ')}`;
    meta.phdt = { build: BUILD_LABEL, id: buildId };

    return storedEntry('pack.mcmeta', JSON.stringify(meta, null, 2));
  } catch (e) {
    return null; // fall back to copying the base's file verbatim
  }
}

function buildInfo(opts, buildId, sources) {
  return `Prime's HD Textures\r\n` +
    `Build: ${BUILD_LABEL} · ${MC_LABEL}\r\n` +
    `Resolution: ${opts.res}x\r\n` +
    `Add-ons: ${opts.slugs.length ? opts.slugs.map(s => ADDONS[s]).join(', ') : 'none'}\r\n` +
    `Early access: ${opts.early ? 'yes' : 'no'}\r\n` +
    `Layers: ${sources.map(s => s.label).join(' -> ')}\r\n` +
    `Packaged: ${new Date().toISOString()}\r\n` +
    `Build ID: ${buildId}\r\n\r\n` +
    `This copy was built for a single Patreon supporter and the Build ID above\r\n` +
    `identifies the account it was issued to. Please don't redistribute it.\r\n`;
}

/* ---------------- output stream ---------------- */

function streamZip(env, plan) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();

  (async () => {
    try {
      for (let si = 0; si < plan.sources.length; si++) {
        const src = plan.sources[si];
        const mine = plan.entries.filter(e => e.sourceIndex === si);
        if (!mine.length) continue;
        mine.sort((a, b) => a.srcOffset - b.srcOffset);
        await copyFromSource(env, src, mine, w);
      }
      for (const e of plan.entries) {
        if (!e.data) continue;
        await w.write(localHeader(e));
        await w.write(e.data);
      }
      for (const e of plan.entries) await w.write(centralHeader(e));
      if (plan.needZip64) {
        await w.write(zip64End(plan.entries.length, plan.dirSize, plan.dirStart));
        await w.write(zip64Locator(plan.dirStart + plan.dirSize));
      }
      await w.write(endRecord(plan));
      await w.close();
    } catch (e) {
      await w.abort(e);
    }
  })();

  return readable;
}

/* One sequential ranged read per source zip: walk its data region in offset
   order, forward the entries we kept and discard the rest. */
async function copyFromSource(env, src, wanted, w) {
  const first = wanted[0].srcOffset;

  const obj = await env.PACKS.get(src.key, { range: { offset: first, length: src.index.dirOffset - first } });
  if (!obj) throw new Error('missing ' + src.key);
  const s = new ByteStream(obj.body, first);

  for (const e of wanted) {
    await s.skipTo(e.srcOffset);
    const hdr = await s.take(30);
    if (rd32(hdr, 0) !== 0x04034b50) throw new Error(src.key + ': bad local header for ' + e.name);
    await s.skipTo(e.srcOffset + 30 + rd16(hdr, 26) + rd16(hdr, 28));
    await w.write(localHeader(e));
    await s.pipe(e.compSize, w);
  }
  await s.cancel();
}

// Exact-length reader over a ReadableStream, with byte-forwarding that never
// holds more than one chunk.
class ByteStream {
  constructor(stream, startPos) {
    this.reader = stream.getReader();
    this.pos = startPos;
    this.buf = new Uint8Array(0);
  }
  async fill() {
    const { done, value } = await this.reader.read();
    if (done) throw new Error('unexpected end of pack data');
    const chunk = new Uint8Array(value);
    if (this.buf.length) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf); merged.set(chunk, this.buf.length);
      this.buf = merged;
    } else this.buf = chunk;
  }
  async take(n) {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    this.pos += n;
    return out;
  }
  async skipTo(target) {
    let n = target - this.pos;
    while (n > 0) {
      if (!this.buf.length) await this.fill();
      const take = Math.min(n, this.buf.length);
      this.buf = this.buf.subarray(take);
      this.pos += take; n -= take;
    }
  }
  async pipe(n, w) {
    let left = n;
    while (left > 0) {
      if (!this.buf.length) await this.fill();
      const take = Math.min(left, this.buf.length);
      await w.write(this.buf.subarray(0, take).slice());
      this.buf = this.buf.subarray(take);
      this.pos += take; left -= take;
    }
  }
  async cancel() { try { await this.reader.cancel(); } catch (e) {} }
}

/* ---------------- reading source zips ---------------- */

async function range(bucket, key, offset, length) {
  const o = await bucket.get(key, { range: { offset, length } });
  if (!o) throw new Error('missing ' + key);
  return new Uint8Array(await o.arrayBuffer());
}

async function readZipIndex(bucket, key, size) {
  const tailLen = Math.min(size, 66000);
  const tail = await range(bucket, key, size - tailLen, tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (rd32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(key + ' is not a zip');

  let count = rd16(tail, eocd + 10);
  let dirSize = rd32(tail, eocd + 12);
  let dirOffset = rd32(tail, eocd + 16);

  if (dirOffset === 0xFFFFFFFF || count === 0xFFFF) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (rd32(tail, i) === 0x07064b58) { loc = i; break; }
    }
    if (loc < 0) throw new Error(key + ': zip64 locator not found');
    const z64at = Number(rd64(tail, loc + 8));
    const z64 = await range(bucket, key, z64at, 56);
    count = Number(rd64(z64, 32));
    dirSize = Number(rd64(z64, 40));
    dirOffset = Number(rd64(z64, 48));
  }

  const dir = await range(bucket, key, dirOffset, dirSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (rd32(dir, p) !== 0x02014b50) throw new Error(key + ': bad central directory');
    const flags = rd16(dir, p + 8);
    const method = rd16(dir, p + 10);
    const crc = rd32(dir, p + 16);
    let compSize = rd32(dir, p + 20);
    let uncompSize = rd32(dir, p + 24);
    const nameLen = rd16(dir, p + 28);
    const extraLen = rd16(dir, p + 30);
    const commentLen = rd16(dir, p + 32);
    let localOffset = rd32(dir, p + 42);
    const name = new TextDecoder().decode(dir.subarray(p + 46, p + 46 + nameLen));

    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      const ex = dir.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0;
      while (q + 4 <= ex.length) {
        const id = rd16(ex, q), len = rd16(ex, q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (uncompSize === 0xFFFFFFFF) { uncompSize = Number(rd64(ex, r)); r += 8; }
          if (compSize === 0xFFFFFFFF) { compSize = Number(rd64(ex, r)); r += 8; }
          if (localOffset === 0xFFFFFFFF) { localOffset = Number(rd64(ex, r)); r += 8; }
          break;
        }
        q += 4 + len;
      }
    }

    if (flags & 0x0008)
      throw new Error(key + ': ' + name + ' uses a streamed data descriptor — re-zip the pack');

    entries.push({
      name: name.replace(/\\/g, '/'),
      dir: name.endsWith('/'),
      method, crc, compSize, uncompSize,
      srcOffset: localOffset,
      utf8: !!(flags & 0x0800)
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  entries.sort((a, b) => a.srcOffset - b.srcOffset);
  return { entries, dirOffset };
}

async function readEntryBytes(bucket, key, e) {
  const hdr = await range(bucket, key, e.srcOffset, 30);
  const dataAt = e.srcOffset + 30 + rd16(hdr, 26) + rd16(hdr, 28);
  return range(bucket, key, dataAt, e.compSize);
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------------- zip writing ---------------- */

function storedEntry(name, text) {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return {
    name, data, method: 0, crc: crc32(data),
    compSize: data.length, uncompSize: data.length, utf8: true
  };
}

const u16 = (v, a, i) => { a[i] = v & 255; a[i + 1] = (v >>> 8) & 255; };
const u32 = (v, a, i) => {
  a[i] = v & 255; a[i + 1] = (v >>> 8) & 255;
  a[i + 2] = (v >>> 16) & 255; a[i + 3] = (v >>> 24) & 255;
};
const u64 = (v, a, i) => {
  let n = BigInt(v);
  for (let k = 0; k < 8; k++) { a[i + k] = Number(n & 255n); n >>= 8n; }
};
const rd16 = (a, i) => a[i] | (a[i + 1] << 8);
const rd32 = (a, i) => (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0;
const rd64 = (a, i) => {
  let n = 0n;
  for (let k = 7; k >= 0; k--) n = (n << 8n) | BigInt(a[i + k]);
  return n;
};

function localHeader(e) {
  const nb = e.nameBytes || (e.nameBytes = new TextEncoder().encode(e.name));
  const b = new Uint8Array(30 + nb.length);
  u32(0x04034b50, b, 0);
  u16(e.method === 8 ? 20 : 10, b, 4);
  u16(0x0800, b, 6);          // UTF-8 names, no data descriptor
  u16(e.method, b, 8);
  u32(e.crc, b, 14);
  u32(Math.min(e.compSize, 0xFFFFFFFF), b, 18);
  u32(Math.min(e.uncompSize, 0xFFFFFFFF), b, 22);
  u16(nb.length, b, 26);
  b.set(nb, 30);
  return b;
}

function centralHeader(e) {
  const nb = e.nameBytes;
  const extra = e.zip64 ? 12 : 0;
  const b = new Uint8Array(46 + nb.length + extra);
  u32(0x02014b50, b, 0);
  u16(45, b, 4);
  u16(e.method === 8 ? 20 : 10, b, 6);
  u16(0x0800, b, 8);
  u16(e.method, b, 10);
  u32(e.crc, b, 16);
  u32(Math.min(e.compSize, 0xFFFFFFFF), b, 20);
  u32(Math.min(e.uncompSize, 0xFFFFFFFF), b, 24);
  u16(nb.length, b, 28);
  u16(extra, b, 30);
  u32(e.zip64 ? 0xFFFFFFFF : e.localOffset, b, 42);
  b.set(nb, 46);
  if (extra) {
    u16(0x0001, b, 46 + nb.length);
    u16(8, b, 48 + nb.length);
    u64(e.localOffset, b, 50 + nb.length);
  }
  return b;
}

function zip64End(count, dirSize, dirStart) {
  const b = new Uint8Array(56);
  u32(0x06064b50, b, 0);
  u64(44, b, 4);
  u16(45, b, 12); u16(45, b, 14);
  u64(count, b, 24); u64(count, b, 32);
  u64(dirSize, b, 40); u64(dirStart, b, 48);
  return b;
}

function zip64Locator(at) {
  const b = new Uint8Array(20);
  u32(0x07064b58, b, 0);
  u64(at, b, 8);
  u32(1, b, 16);
  return b;
}

// The Build ID also lives in the archive comment — invisible in Explorer and
// Finder, and it survives the zip being reuploaded as-is.
function endRecord(plan) {
  const n = plan.needZip64 ? 0xFFFF : plan.entries.length;
  const b = new Uint8Array(22 + plan.comment.length);
  u32(0x06054b50, b, 0);
  u16(n, b, 8); u16(n, b, 10);
  u32(plan.needZip64 ? 0xFFFFFFFF : plan.dirSize, b, 12);
  u32(plan.needZip64 ? 0xFFFFFFFF : plan.dirStart, b, 16);
  u16(plan.comment.length, b, 20);
  b.set(plan.comment, 22);
  return b;
}

/* ---------------- stamp ----------------
   An HMAC of the patron's identity, not the name itself. Nothing personal
   lands in the file, but you can trace a leaked build by running the same
   HMAC over your patron list and matching the ID. */
async function stamp(session, env) {
  const seed = session
    ? (session.name || '') + '|' + (session.tiers || []).join(',')
    : 'anonymous';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.COOKIE_SECRET || 'dev-only-insecure-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(seed));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}

/* ---------------- crc32 ---------------- */

let TABLE = null;
function crc32(bytes) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------------- responses ---------------- */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

function err(message, check, status) {
  if (check) return json({ ok: false, error: message }, 200);
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
