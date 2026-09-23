/* Typist — tiny static dev server (node dev-server.js [port])
   Serves the project with caching disabled.
   Dev-only helpers for inspection:
     POST /__shot  JSON {name, data: dataURL}  -> shots/<name>.png|.jpg
     POST /__file?name=<file>  raw body       -> shots/<file>  (videos, svg, json) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8860;
const shotDir = path.join(root, 'shots');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff',
};
const safeName = (n, fallback) => String(n || fallback).replace(/[^a-z0-9_.-]/gi, '_').replace(/^\.+/, '');

function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks)));
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/__shot')) {
    readBody(req, buf => {
      try {
        const { name, data } = JSON.parse(buf.toString('utf8'));
        const ext = /^data:image\/png/.test(data) ? '.png' : '.jpg';
        fs.mkdirSync(shotDir, { recursive: true });
        const file = path.join(shotDir, safeName(name, 'shot') + ext);
        fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file }));
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/__file')) {
    const name = new URL(req.url, 'http://x').searchParams.get('name');
    readBody(req, buf => {
      fs.mkdirSync(shotDir, { recursive: true });
      const file = path.join(shotDir, safeName(name, 'file.bin'));
      fs.writeFileSync(file, buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file, bytes: buf.length }));
    });
    return;
  }
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(root, url));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log(`Typist -> http://localhost:${port}`));
