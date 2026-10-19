#!/usr/bin/env node
/**
 * NEON RACER — zero-dependency local play server.
 *
 *   node serve.mjs               serve dist/ (build first: npm run build)
 *   node serve.mjs --dev         serve the project sources (requires vite for TS)
 *   node serve.mjs --port 8080
 *
 * Prefers the production build in dist/; falls back to the project root.
 * OWNER: lead.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4173;
const distDir = join(root, 'dist');
const baseDir = args.includes('--dev') || !existsSync(join(distDir, 'index.html')) ? root : distDir;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let filePath = join(baseDir, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(baseDir, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 — not found. Did you run "npm run build"? (looked in ${baseDir})`);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  const serving = baseDir === distDir ? 'dist/ (production build)' : 'project root (sources)';
  console.log(`NEON RACER serving ${serving}`);
  console.log(`  →  http://127.0.0.1:${port}`);
  if (baseDir !== distDir) console.log('  note: TypeScript sources need a bundler — run "npm run dev" for development.');
  console.log('  press Ctrl+C to stop');
});
