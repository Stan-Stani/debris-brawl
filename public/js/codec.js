// Maps travel as base64(deflate(Grid.encode())). The server packs them with node:zlib, which speaks the same format.
import { Grid } from '/shared/grid.js';

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function packGrid(g) {
  const z = await pipe(g.encode(), new CompressionStream('deflate'));
  let s = '';
  for (let i = 0; i < z.length; i += 0x8000) s += String.fromCharCode.apply(null, z.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function unpackGrid(b64) {
  const s = atob(b64), z = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) z[i] = s.charCodeAt(i);
  return Grid.decode(await pipe(z, new DecompressionStream('deflate')));
}

// A canvas as an image data URL to send with the map (WebP where the browser can make it, else PNG).
export async function packImage(canvas) {
  if (!canvas) return null;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.92));
  if (!blob) return null;
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}
