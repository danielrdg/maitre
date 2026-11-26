import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export interface LoungeServer {
  url: string;
  port: number;
  address: AddressInfo;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const COOKIE_PREFIX = 'maitre_key_';
const MAX_PORT_TRIES = 21;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((res, rej) => {
    const onError = (err: Error) => rej(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      res();
    });
  });
}

export async function startLoungeServer(opts: {
  root: string;
  port: number;
  token: string;
  host?: '127.0.0.1';
  routes?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
}): Promise<LoungeServer> {
  const root = resolve(opts.root);
  let realRoot: string | undefined;
  let boundPort = opts.port;
  const host = opts.host ?? '127.0.0.1';

  const server = createServer(async (req, res) => {
    const deny = (status: number) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(status === 403 ? 'Forbidden' : 'Not found');
    };
    try {
      const hostHeader = req.headers.host;
      if (hostHeader !== `127.0.0.1:${boundPort}` && hostHeader !== `localhost:${boundPort}`) return deny(403);
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`) {
        return deny(403);
      }
      const cookieName = COOKIE_PREFIX + boundPort;
      const raw = req.url ?? '/';
      if (!raw.startsWith('/')) return deny(403);
      const q = raw.indexOf('?');
      const rawPath = q === -1 ? raw : raw.slice(0, q);
      const params = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));

      const queryKey = params.get('key');
      const cookieKey = cookieValue(req.headers.cookie, cookieName);
      const viaQuery = queryKey !== null && safeEqual(queryKey, opts.token);
      const viaCookie = cookieKey !== undefined && safeEqual(cookieKey, opts.token);
      if (!viaQuery && !viaCookie) return deny(403);

      if (opts.routes) {
        let url: URL;
        try {
          // Concatenate, never resolve: new URL('//evil/x', base) would make "evil" the host.
          url = new URL(`http://127.0.0.1:${boundPort}${raw}`);
        } catch {
          return deny(403);
        }
        if (await opts.routes(req, res, url)) return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(403);

      let decoded: string;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        return deny(403);
      }
      if (decoded.includes('\0')) return deny(403);
      const rel = decoded === '/' ? '/index.html' : decoded;
      const file = resolve(root, '.' + rel);
      if (!file.startsWith(root + sep)) return deny(403);

      let body: Buffer;
      try {
        realRoot ??= await realpath(root);
        const real = await realpath(file);
        if (!real.startsWith(realRoot + sep)) return deny(403);
        body = await readFile(real);
      } catch {
        return deny(404);
      }
      const headers: Record<string, string> = {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      };
      if (viaQuery) headers['set-cookie'] = `${cookieName}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      if (res.headersSent) res.destroy();
      else deny(404);
    }
  });

  let port = opts.port;
  for (let i = 0; ; i++) {
    try {
      await listen(server, port, host);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || opts.port === 0 || i >= MAX_PORT_TRIES - 1) throw err;
      port++;
    }
  }

  const address = server.address() as AddressInfo;
  boundPort = address.port;
  return {
    url: `http://${host}:${address.port}/?key=${opts.token}`,
    port: address.port,
    address,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
        server.closeAllConnections();
      }),
  };
}
