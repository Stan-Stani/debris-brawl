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
