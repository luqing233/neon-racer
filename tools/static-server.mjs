#!/usr/bin/env node
/**
 * static-server.mjs — zero-dependency static file server for the Neon Racer
 * verification harness.
 *
 * It serves the BUILT `dist/` directory (falls back to the project root when
 * dist/ does not exist) on 127.0.0.1 so Windows Chrome — which shares 127.0.0.1
 * with WSL in mirrored networking mode — can load the game.
 *
 * Used as a module:            const server = await startServer({ root: 'dist' });
 *                              console.log(server.url); … await server.close();
 * Used as a CLI:               node tools/static-server.mjs --port 8080 --dir dist
 */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Choose the directory to serve: explicit `root` wins; otherwise dist/ when it
 * contains an index.html; otherwise the project root (dev fallback required by T4).
 */
export function resolveRoot(root = null) {
  if (root) {
    const resolved = path.resolve(PROJECT_ROOT, root);
    if (!existsSync(resolved)) throw new Error(`static server root does not exist: ${resolved}`);
    return resolved;
  }
  const dist = path.join(PROJECT_ROOT, 'dist');
  if (existsSync(path.join(dist, 'index.html'))) return dist;
  return PROJECT_ROOT;
}

/**
 * Start the server.
 * @returns {Promise<{url:string, port:number, root:string, requests:string[], close:()=>Promise<void>}>}
 */
export async function startServer({ root = null, port = 0, host = '127.0.0.1', quiet = true } = {}) {
  const servedRoot = resolveRoot(root);
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    requests.push(pathname);

    const finish = (status) => {
      if (!quiet) {
        console.error(`[static] ${status} ${req.method} ${pathname} ${Date.now() - started}ms`);
      }
    };

    // The game ships no favicon; answer politely so console stays clean.
    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      finish(204);
      return;
    }

    const sendFile = async (filePath, status = 200) => {
      const info = await stat(filePath).catch(() => null);
      if (!info || !info.isFile()) return false;
      res.writeHead(status, {
        'content-type': contentType(filePath),
        'content-length': info.size,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      if (req.method === 'HEAD') {
        res.end();
        finish(status);
        return true;
      }
      createReadStream(filePath)
        .on('error', () => {
          res.destroy();
        })
        .pipe(res);
      finish(status);
      return true;
    };

    const safeJoin = (relativePath) => {
      const candidate = path.resolve(servedRoot, `.${relativePath}`);
      if (candidate !== servedRoot && !candidate.startsWith(servedRoot + path.sep)) return null;
      return candidate;
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
      res.end('method not allowed');
      finish(405);
      return;
    }

    // 1) exact file
    const direct = safeJoin(pathname === '/' ? '/index.html' : pathname);
    if (direct && (await sendFile(direct))) return;

    // 2) directory index
    if (direct) {
      const dirIndex = path.join(direct, 'index.html');
      if (existsSync(dirIndex) && (await sendFile(dirIndex))) return;
    }

    // 3) SPA-ish fallback to index.html for extension-less routes
    if (!path.extname(pathname)) {
      const spaIndex = path.join(servedRoot, 'index.html');
      if (await sendFile(spaIndex, 200)) return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`not found: ${pathname}`);
    finish(404);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    url,
    port: actualPort,
    root: servedRoot,
    requests,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/* ---------------------------------------------------------------- CLI test -- */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const port = Number(getArg('port', '8080'));
  const dir = getArg('dir', getArg('root', null));
  const server = await startServer({ root: dir, port, quiet: false });
  console.log(`serving ${server.root}`);
  console.log(`listening on ${server.url}  (Ctrl+C to stop)`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
