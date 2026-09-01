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
//   bedrock/base/<res>.mcpack      Bedrock Edition, same layout under a prefix
//   bedrock/early/<res>.mcpack     (.zip is accepted for either as well)

import { encodeBuildId } from './buildid.js';
const RESOLUTIONS = [32, 64, 128, 256];
// How much of a source zip to hold open at once. Holding one range open for a
// whole client-paced download is what broke; a window is short-lived by design.
// Each costs a subrequest, and the paid plan allows 1000 per request.
const WINDOW = 8 * 1024 * 1024;
// Reopening to skip a gap costs a subrequest too, so only do it when the gap is
// bigger than the bytes it would save transferring.
const SEEK_MIN = 512 * 1024;
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const EMPTY = new Uint8Array(0);
// Overlay order: later sources override earlier ones on a path collision.
const ADDONS = {
  'lush-foliage':   'Lush Foliage',
  'pbr-items':      'PBR Items',
  'block-overlays': 'Block Overlays'
};
const ADDON_ORDER = ['lush-foliage', 'pbr-items', 'block-overlays'];

// Always taken from the base pack — an add-on's copies are ignored.
const BASE_OWNED = new Set(['pack.png', 'pack.mcmeta', 'manifest.json']);

const BUILD_LABEL = 'Beta 55';
const MC_LABEL = 'Minecraft Java 26.2';

/* Isolate-level memo of parsed source zips.
   Parsing a central directory is the single most expensive thing this endpoint
   does, and the page hits /api/download three times for one download (size
   preview, preflight, transfer) — plus once per add-on toggle. Without this,
   a multi-source build re-parses every zip each time and trips the Worker CPU
   limit (error 1102). Keyed by object key + size, so a reupload invalidates. */
const INDEX_CACHE = new Map();
const MCMETA_CACHE = new Map();
const MCMETA_MAX = 12;              // parsed mcmeta is a few hundred bytes each
const INDEX_MAX = 4;                // one download touches at most 5 sources
const INDEX_ENTRY_BUDGET = 40000;   // total zip entries held across cached indexes

function memo(cache, key, make, max) {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const made = make();          // a promise — concurrent callers share one parse
  cache.set(key, made);
  made.catch(() => cache.delete(key));
  while (cache.size > max) cache.delete(cache.keys().next().value);
  return made;
}

/* Count-based eviction is not enough for INDEX_CACHE: an index is a parsed
   central directory, tens of thousands of objects for a big pack. Budget it by
   total entries so a warm isolate can't accumulate every resolution at once
   and hit the 128MB ceiling mid-download. */
function trimIndexCache() {
  let total = 0;
  const sized = [];
  for (const [k, v] of INDEX_CACHE) {
    const n = v && v.entries ? v.entries.length : 0;
    total += n;
    sized.push([k, n]);
  }
  for (const [k, n] of sized) {
    if (total <= INDEX_ENTRY_BUDGET || INDEX_CACHE.size <= 1) break;
    INDEX_CACHE.delete(k);
    total -= n;
  }
}

export async function handleDownload(request, env, session) {
  const url = new URL(request.url);
  const check = url.searchParams.get('check') === '1';

  const res = parseInt(url.searchParams.get('res') || '32', 10);
  const slugs = ADDON_ORDER.filter(s =>
    (url.searchParams.get('addons') || '').split(',').map(x => x.trim()).includes(s));
  const early = url.searchParams.get('early') === '1';
  // Bedrock packs live under their own prefix, so one bucket serves both
  // editions. Absent or unrecognised means Java.
  const bedrock = url.searchParams.get('edition') === 'bedrock';

  if (!RESOLUTIONS.includes(res)) return err('Unknown resolution.', check, 400);
  // Bedrock is Creator-only while it's being tested, matching the picker.
  if (bedrock && !(session && session.owner))
    return err('Bedrock Edition isn\u2019t released yet.', check, 403);
  if (bedrock && slugs.length)
    return err('Add-ons are Java Edition only.', check, 400);

  const paid = !!(session && session.paid);
  const canEarly = !!(session && session.early);
  if (res !== 32 && !paid) return err('64× and up need a paid Patreon tier.', check, 403);
  if (slugs.length && !paid) return err('Add-ons need a paid Patreon tier.', check, 403);
  if (early && !canEarly)
    return err('Early access is for Pack Tester and Development Council members.', check, 403);
  if (!env.PACKS) return err('File storage isn\u2019t configured yet.', check, 503);

  const pre = bedrock ? 'bedrock/' : '';
  // Bedrock packs are uploaded as .mcpack. That is a zip with a different
  // extension, so the assembler is unchanged — only the lookup has to allow it.
  const ext = bedrock ? ['.mcpack', '.zip'] : ['.zip'];
  const sources = [{ label: 'base', keys: ext.map(e => `${pre}base/${res}${e}`) }];
  for (const s of slugs) sources.push({ label: ADDONS[s], keys: [`addons/${s}.zip`] });
  if (early) sources.push({ label: 'Early access', keys: ext.map(e => `${pre}early/${res}${e}`), early: true });

  const found = await Promise.all(sources.map(async s => {
    for (const key of s.keys) {
      const h = await env.PACKS.head(key);
      if (h) return { key, size: h.size };
    }
    return null;
  }));
  for (let i = 0; i < sources.length; i++) {
    if (!found[i])
      return err('This file doesn\u2019t seem to exist. Contact a moderator in the Discord.', check, 404);
    sources[i].key = found[i].key;
    sources[i].size = found[i].size;
  }

  let plan;
  try {
    plan = await buildPlan(env, sources, { res, slugs, early, session, bedrock });
  } catch (e) {
    return err('Couldn\u2019t read one of the pack files: ' + e.message, check, 500);
  }

  if (check)
    return json({
      ok: true,
      files: plan.entries.length,
      bytes: plan.totalBytes,
      sources: sources.length,
      zip64: plan.needZip64,
      dirStart: plan.dirStart,
      dirSize: plan.dirSize,
      buildId: plan.buildId === 'anonymous' ? 'anonymous' : 'stamped',
      perSource: plan.sources.map(s => ({
        key: s.key,
        size: s.size,
        indexed: s.index.entries.length,
        used: plan.entries.filter(e => e.sourceIndex === plan.sources.indexOf(s)).length
      })),
      methods: plan.entries.reduce((m, e) => { m[e.method] = (m[e.method] || 0) + 1; return m; }, {})
    });

  // Bedrock imports as .mcpack; the bytes are the same zip either way.
  // Same name as the Java files apart from the extension: Bedrock imports as
  // .mcpack, though the bytes are the same zip either way.
  const suffix = ` [${res}x]` + (bedrock ? '.mcpack' : '.zip');
  const filename = `Prime's HD Textures${suffix}`;

  return new Response(streamZip(env, plan), {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(plan.totalBytes),
      'content-disposition': `attachment; filename="Primes HD Textures${suffix}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
      'x-build-id': plan.buildId
    }
  });
}

/* ---------------- planning ----------------
   Read every source's central directory, resolve the overlay, then lay out
   the output byte-for-byte so we can send an exact Content-Length. */

async function buildPlan(env, sources, opts) {
  const idx = await Promise.all(sources.map(s =>
    memo(INDEX_CACHE, s.key + ':' + s.size,
      () => readZipIndex(env.PACKS, s.key, s.size), INDEX_MAX)));
  sources.forEach((s, i) => { s.index = idx[i]; });
  // Resolved values are in the map now, so their real weight can be measured.
  for (const [k, v] of INDEX_CACHE) if (v && typeof v.then === 'function') INDEX_CACHE.set(k, await v);
  trimIndexCache();

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

  // Generated entries replace / add to what came out of the zips. Java packs
  // carry pack.mcmeta, Bedrock carries manifest.json; both get the build id.
  const generated = [];
  const meta = opts.bedrock
    ? await packManifest(env, sources, opts, buildId)
    : await packMeta(env, sources, opts, buildId);
  if (meta) { generated.push(meta); owner.delete(meta.name); }

  // Output order: base entries first, then each overlay's new files.
  const entries = [];
  const seen = new Set();
  sources.forEach((s, si) => {
    for (const e of s.index.entries) {
      if (e.dir || owner.get(e.name) !== si || seen.has(e.name)) continue;
      seen.add(e.name);
      entries.push({ ...e, sourceIndex: si });
    }
  });
  entries.push(...generated);

  // Lay out offsets. nameBytes come pre-encoded off the cached index.
  let offset = 0;
  for (const e of entries) {
    if (!e.nameBytes) e.nameBytes = ENC.encode(e.name);
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
  const comment = ENC.encode('PHDT-' + buildId);
  const totalBytes = dirStart + dirSize +
    (needZip64 ? 56 + 20 : 0) + 22 + comment.length;

  return { sources, entries, dirStart, dirSize, needZip64, comment, totalBytes, buildId };
}

/* Rewrites pack.mcmeta so the in-game pack list describes what was built.
   Early access replaces the base description; each add-on's own description is
   appended with " + ". */
async function packMeta(env, sources, opts, buildId) {
  try {
    const base = sources[0];
    const baseEntry = base.index.entries.find(x => x.name === 'pack.mcmeta');
    if (!baseEntry) return null;
    const meta = await readPackJson(env, base, baseEntry);
    if (!meta || !meta.pack) return null;

    // Early access replaces the base description; add-ons append to it.
    const earlySrc = sources.find(s => s.early);
    const addonSrcs = sources.filter((s, i) => i > 0 && !s.early);

    const descOf = async s => {
      if (s === base) return describe(meta);
      const e = s.index.entries.find(x => x.name === 'pack.mcmeta');
      return e ? describe(await readPackJson(env, s, e)) : '';
    };

    const head = earlySrc ? (await descOf(earlySrc)) || describe(meta) : describe(meta);
    const parts = head ? [head] : [];
    for (const s of addonSrcs) {
      const d = await descOf(s);
      if (d && !parts.includes(d)) parts.push(d);
    }

    meta.pack.description = parts.join(' + ');
    delete meta.phdt;
    meta.build_id = buildId;

    return storedEntry('pack.mcmeta', JSON.stringify(meta, null, 2));
  } catch (e) {
    return null; // fall back to copying the base's file verbatim
  }
}

/* The Bedrock equivalent: manifest.json instead of pack.mcmeta. Same job —
   describe the build in the in-game pack list and stamp it with the build id, so
   an .mcpack is traceable to the account that downloaded it exactly as a .zip
   is. Add-ons are Java-only, so only early access can change the description. */
async function packManifest(env, sources, opts, buildId) {
  try {
    const base = sources[0];
    const baseEntry = base.index.entries.find(x => x.name === 'manifest.json');
    if (!baseEntry) return null;
    const man = await readPackJson(env, base, baseEntry);
    if (!man || !man.header) return null;

    const earlySrc = sources.find(s => s.early);
    if (earlySrc && earlySrc !== base) {
      const e = earlySrc.index.entries.find(x => x.name === 'manifest.json');
      const em = e ? await readPackJson(env, earlySrc, e) : null;
      const d = em && em.header && em.header.description;
      if (typeof d === 'string' && d.trim()) man.header.description = d.trim();
    }

    delete man.phdt;
    // Top level for tooling, and in metadata where Bedrock keeps pack info.
    man.build_id = buildId;
    if (!man.metadata || typeof man.metadata !== 'object') man.metadata = {};
    man.metadata.build_id = buildId;

    return storedEntry('manifest.json', JSON.stringify(man, null, 2));
  } catch (e) {
    return null; // fall back to copying the base's file verbatim
  }
}

// Cached per source and file name: the same three or four small JSON files are
// re-read on every preflight otherwise, each costing an R2 range read plus an
// inflate.
function readPackJson(env, src, e) {
  return memo(MCMETA_CACHE, src.key + ':' + src.size + ':' + e.name, async () => {
    let bytes = await readEntryBytes(env.PACKS, src.key, e);
    if (e.method === 8) bytes = await inflateRaw(bytes);
    else if (e.method !== 0) return null;
    try { return JSON.parse(DEC.decode(bytes)); } catch (x) { return null; }
  }, MCMETA_MAX).then(m => m && JSON.parse(JSON.stringify(m)));   // callers mutate it
}

// pack.mcmeta descriptions can be a plain string or a JSON text component.
function describe(meta) {
  const d = meta && meta.pack && meta.pack.description;
  if (typeof d === 'string') return d.trim();
  if (Array.isArray(d)) return d.map(p => typeof p === 'string' ? p : (p && p.text) || '').join('').trim();
  if (d && typeof d.text === 'string') return d.text.trim();
  return '';
}

/* ---------------- output stream ---------------- */

async function writeArchive(env, plan, put, at) {
  for (let si = 0; si < plan.sources.length; si++) {
    const src = plan.sources[si];
    const mine = plan.entries.filter(e => e.sourceIndex === si);
    if (!mine.length) continue;
    mine.sort((a, b) => a.srcOffset - b.srcOffset);
    at.source = src.key;
    at.entries = mine.length;
    const before = at.written;
    const expect = mine.reduce((n, e) => n + 30 + e.nameBytes.length + e.compSize, 0);
    await copyFromSource(env, src, mine, put, at);
    if (at.written - before !== expect)
      throw new Error(`${src.key}: wrote ${at.written - before} of ${expect} bytes`);
  }
  at.source = 'generated';
  for (const e of plan.entries) {
    if (!e.data) continue;
    at.entry = e.name;
    await put(localHeader(e));
    await put(e.data);
  }
  if (at.written !== plan.dirStart)
    throw new Error(`data region ended at ${at.written}, expected ${plan.dirStart}`);
  at.source = 'central directory';
  for (const e of plan.entries) await put(centralHeader(e));
  if (plan.needZip64) {
    await put(zip64End(plan.entries.length, plan.dirSize, plan.dirStart));
    await put(zip64Locator(plan.dirStart + plan.dirSize));
  }
  await put(endRecord(plan));
  if (at.written !== plan.totalBytes)
    throw new Error(`sent ${at.written} bytes, declared ${plan.totalBytes}`);
}

function streamZip(env, plan) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const at = { written: 0, source: null, entry: null, nth: 0 };
  const put = async bytes => { at.written += bytes.length; await w.write(bytes); };

  (async () => {
    try {
      await writeArchive(env, plan, put, at);
      await w.close();
    } catch (e) {
      // Better a failed download than a complete-looking, unopenable zip.
      await w.abort(e);
    }
  })();

  return readable;
}


/* One sequential ranged read per source zip: walk its data region in offset
   order, forward the entries we kept and discard the rest. */
async function copyFromSource(env, src, wanted, put, at) {
  const s = new ByteStream(env.PACKS, src.key, wanted[0].srcOffset, src.index.dirOffset);

  for (const e of wanted) {
    at.entry = e.name;
    at.nth++;
    await s.skipTo(e.srcOffset);
    const hdr = await s.take(30);
    if (rd32(hdr, 0) !== 0x04034b50) throw new Error(src.key + ': bad local header for ' + e.name);
    await s.skipTo(e.srcOffset + 30 + rd16(hdr, 26) + rd16(hdr, 28));
    await put(localHeader(e));
    await s.pipe(e.compSize, put);
  }
  s.cancel();
}

// Exact-length reader over a ReadableStream, with byte-forwarding that never
// holds more than one chunk.
class ByteStream {
  constructor(bucket, key, startPos, end) {
    this.bucket = bucket;
    this.key = key;
    this.pos = startPos;      // where we are in the source file
    this.next = startPos;     // first byte not yet requested
    this.end = end;           // never read past the central directory
    this.reader = null;
    this.buf = EMPTY;
  }
  async fill() {
    for (;;) {
      if (!this.reader) {
        if (this.next >= this.end) throw new Error('unexpected end of pack data');
        const length = Math.min(WINDOW, this.end - this.next);
        const obj = await this.bucket.get(this.key, { range: { offset: this.next, length } });
        if (!obj) throw new Error('missing ' + this.key);
        this.reader = obj.body.getReader();
        this.next += length;
      }
      const { done, value } = await this.reader.read();
      if (done) { this.reader = null; continue; }   // window exhausted, open the next
      const chunk = new Uint8Array(value);
      if (this.buf.length) {
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf); merged.set(chunk, this.buf.length);
        this.buf = merged;
      } else this.buf = chunk;
      return;
    }
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
    if (n < 0) throw new Error('pack entries are out of order');
    // A gap bigger than what is already buffered is cheaper to seek over than
    // to transfer and throw away.
    if (n > this.buf.length + SEEK_MIN) {
      this.cancel();
      this.reader = null;
      this.buf = EMPTY;
      this.pos = this.next = target;
      return;
    }
    while (n > 0) {
      if (!this.buf.length) await this.fill();
      const take = Math.min(n, this.buf.length);
      this.buf = this.buf.subarray(take);
      this.pos += take; n -= take;
    }
  }
  async pipe(n, put) {
    let left = n;
    while (left > 0) {
      if (!this.buf.length) await this.fill();
      const take = Math.min(left, this.buf.length);
      // Always a copy: the stream must own what it is handed.
      await put(this.buf.slice(0, take));
      this.buf = this.buf.subarray(take);
      this.pos += take; left -= take;
    }
  }
  cancel() {
    if (!this.reader) return;
    try { this.reader.cancel().catch(() => {}); } catch (e) {}
    this.reader = null;
  }
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
  const eocdPos = size - tailLen + eocd;
  let cdEnd = eocdPos;

  if (dirOffset === 0xFFFFFFFF || count === 0xFFFF || dirSize === 0xFFFFFFFF) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (rd32(tail, i) === 0x07064b50) { loc = i; break; }
    }
    if (loc < 0) throw new Error(key + ': zip64 locator not found');
    const z64at = Number(rd64(tail, loc + 8));
    const z64 = await range(bucket, key, z64at, 56);
    count = Number(rd64(z64, 32));
    dirSize = Number(rd64(z64, 40));
    dirOffset = Number(rd64(z64, 48));
    cdEnd = z64at;
  }

  // Some zips carry a prefix (self-extracting stubs, or an archive appended to
  // another file), which shifts every recorded offset. Work out the real start
  // of the central directory and correct by the difference.
  const actualDirStart = cdEnd - dirSize;
  const prefix = actualDirStart - dirOffset;

  const dir = await range(bucket, key, actualDirStart, dirSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (rd32(dir, p) !== 0x02014b50) throw new Error(key + ': bad central directory');
    const flags = rd16(dir, p + 8);
    const method = rd16(dir, p + 10);
    const mtime = rd16(dir, p + 12);
    const mdate = rd16(dir, p + 14);
    const crc = rd32(dir, p + 16);
    let compSize = rd32(dir, p + 20);
    let uncompSize = rd32(dir, p + 24);
    const nameLen = rd16(dir, p + 28);
    const extraLen = rd16(dir, p + 30);
    const commentLen = rd16(dir, p + 32);
    let localOffset = rd32(dir, p + 42);
    // Copied, not a subarray: a view would pin the whole multi-MB central
    // directory buffer alive for as long as this index stays cached.
    let nameBytes = dir.slice(p + 46, p + 46 + nameLen);
    let name = DEC.decode(nameBytes);
    if (name.indexOf('\\') !== -1) { name = name.split('\\').join('/'); nameBytes = ENC.encode(name); }

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

    // Entries written with a streamed data descriptor (flag bit 3) have zeroed
    // sizes in their LOCAL header, but the central directory values above are
    // authoritative — and we re-emit our own headers from those. The trailing
    // descriptor is simply skipped, since we seek to each entry by offset.

    entries.push({
      name,
      nameBytes,
      dir: name.charCodeAt(name.length - 1) === 47,
      method, crc, compSize, uncompSize, mtime, mdate,
      srcOffset: localOffset + prefix,
      utf8: !!(flags & 0x0800)
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  entries.sort((a, b) => a.srcOffset - b.srcOffset);

  // Validate before we commit to streaming: once response headers are out, a
  // failure can only truncate the download.
  const files = entries.filter(e => !e.dir);
  if (files.length) {
    const probe = await range(bucket, key, files[0].srcOffset, 4);
    if (rd32(probe, 0) !== 0x04034b50)
      throw new Error(key + ' has unreadable entry offsets');
    const last = files[files.length - 1];
    if (last.srcOffset + last.compSize > actualDirStart)
      throw new Error(key + ' is truncated or its directory is inconsistent');
  }

  return { entries, dirOffset: actualDirStart };
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
  const data = typeof text === 'string' ? ENC.encode(text) : text;
  return {
    name, data, method: 0, crc: crc32(data),
    compSize: data.length, uncompSize: data.length, utf8: true,
    mtime: 0, mdate: DOS_EPOCH_DATE
  };
}

const DOS_EPOCH_DATE = 33;

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
  const nb = e.nameBytes || (e.nameBytes = ENC.encode(e.name));
  const b = new Uint8Array(30 + nb.length);
  u32(0x04034b50, b, 0);
  u16(e.method === 8 ? 20 : 10, b, 4);
  u16(0x0800, b, 6);          // UTF-8 names, no data descriptor
  u16(e.method, b, 8);
  u16(e.mtime || 0, b, 10);
  u16(e.mdate || DOS_EPOCH_DATE, b, 12);
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
  u16(e.zip64 ? 45 : (e.method === 8 ? 20 : 10), b, 6);
  u16(0x0800, b, 8);
  u16(e.method, b, 10);
  u16(e.mtime || 0, b, 12);
  u16(e.mdate || DOS_EPOCH_DATE, b, 14);
  u32(e.crc, b, 16);
  u32(Math.min(e.compSize, 0xFFFFFFFF), b, 20);
  u32(Math.min(e.uncompSize, 0xFFFFFFFF), b, 24);
  u16(nb.length, b, 28);
  u16(extra, b, 30);
  u32(0x20, b, 38);                    // FILE_ATTRIBUTE_ARCHIVE
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
  u32(0x07064b50, b, 0);
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
   The patron's Patreon user id, encrypted with COOKIE_SECRET. Anyone who finds
   it in a leaked pack learns nothing; decode it at /api/build-id to get the
   account. */
async function stamp(session, env) {
  if (!session || !session.uid) return 'anonymous';
  try {
    return await encodeBuildId(session.uid, env.COOKIE_SECRET);
  } catch (e) {
    return 'anonymous';
  }
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
