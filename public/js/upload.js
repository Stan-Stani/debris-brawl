// Sending screenshots to the game's uploads/ folder (see server/uploads.js).
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Pictures out of a paste or a drop: clipboard screenshots arrive as items, dropped files as files.
export function imagesIn(dt) {
  if (!dt) return [];
  const fromItems = [...(dt.items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  return fromItems.length ? fromItems : [...(dt.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

// Anything the server won't take (TIFF, HEIC in browsers that can open it, …) is redrawn as a PNG.
async function asAccepted(blob) {
  if (ACCEPTED.includes(blob.type)) return blob;
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) throw new Error(`Can't read ${blob.type || 'that file'}. Try a PNG or JPEG.`);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't convert that picture."))), 'image/png'));
}

export async function sendShot(file, note = '') {
  const body = await asAccepted(file);
  let r;
  try {
    r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'content-type': body.type, 'x-debris-upload': '1', 'x-note': encodeURIComponent(note) },
      body,
    });
  } catch {
    throw new Error("Couldn't reach the game server.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status}).`);
  return j; // { name, bytes }
}
