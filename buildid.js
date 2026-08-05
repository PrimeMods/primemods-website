// Build ID — the stamp that goes into every download.
//
// The patron's Patreon user id encrypted with COOKIE_SECRET (AES-GCM), so the
// id in the pack is meaningless to anyone who finds it and only you can turn
// it back into an account. Same secret both ways, so don't rotate it.

async function aesKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const b64u = bytes =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64u = s =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function encodeBuildId(uid, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(String(uid))
  ));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}

export async function decodeBuildId(token, secret) {
  const bytes = unb64u(String(token).trim().replace(/^PHDT-/, ''));
  if (bytes.length < 29) throw new Error('not a build id');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
    await aesKey(secret),
    bytes.subarray(12)
  );
  return new TextDecoder().decode(pt);
}
