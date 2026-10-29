// Screenshots to show whoever is working on the game: pasted, dropped or picked on /share.html and saved
// into uploads/. Nothing here is ever served back over HTTP, so a hostile file can't run on our origin.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 15 << 20;
const KEEP = 200;

// What a file is gets decided by its first bytes, never by its name or the type the browser claims.
export function sniffImage(b) {
  if (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const loopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const privateLan = (ip) => /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip);

// reply(status, jsonBody) is supplied by the server so responses look like every other /api answer.
export function uploadHandler(dir, { allowLan = false } = {}) {
  return async (req, res, reply) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!(loopback(ip) || (allowLan && privateLan(ip)))) {
      return reply(403, { error: 'Screenshots can only be sent from the computer running the game (open it at localhost).' });
    }
    // our own page only: the custom header forces a CORS preflight no other site can pass
    let sameOrigin = false;
    try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin || req.headers['x-debris-upload'] !== '1') return reply(403, { error: 'Not allowed.' });
    if (Number(req.headers['content-length']) > MAX_BYTES) { res.setHeader('connection', 'close'); return reply(413, { error: 'That picture is over 15 MB.' }); }

    const chunks = [];
    let n = 0;
    try {
      for await (const c of req) {
        n += c.length;
        if (n > MAX_BYTES) { res.setHeader('connection', 'close'); reply(413, { error: 'That picture is over 15 MB.' }); req.destroy(); return; }
        chunks.push(c);
      }
    } catch {
      return reply(400, { error: 'The upload was cut off.' });
    }
    const buf = Buffer.concat(chunks);
    const ext = sniffImage(buf);
    if (!ext) return reply(415, { error: 'Only PNG, JPEG, GIF or WebP pictures.' });

    let note = '';
    try { note = decodeURIComponent(String(req.headers['x-note'] ?? '')).trim().slice(0, 2000); } catch { note = ''; }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const name = `shot-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`; // never a name the client chose
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), buf, { flag: 'wx' });
      if (note) await fs.writeFile(path.join(dir, `${name}.txt`), `${note}\n`, { flag: 'wx' });
    } catch (e) {
      console.error('upload failed:', e);
      return reply(500, { error: "Couldn't save the picture." });
    }
    prune(dir).catch(() => {});
    return reply(200, { name, bytes: buf.length });
  };
}

async function prune(dir) {
  const shots = (await fs.readdir(dir)).filter((f) => /^shot-.*\.(png|jpg|gif|webp)$/.test(f)).sort().reverse();
  for (const f of shots.slice(KEEP)) {
    await fs.rm(path.join(dir, f), { force: true });
    await fs.rm(path.join(dir, `${f}.txt`), { force: true });
  }
}
