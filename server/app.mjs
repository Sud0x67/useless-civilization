import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnRequestSchema, ModelRequestSchema } from '../src/shared/schema.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
import { HttpError, requestModel } from './model.mjs';
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
function readJson(req, limit = 524288) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > limit) {
        done = true;
        reject(new HttpError(413, '请求太大，请减少世界数据。'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求不是有效的 JSON。'));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        reject(new HttpError(400, '请求读取失败。'));
      }
    });
  });
}
export function createHandler({
  config = {},
  town,
  production = false,
  middleware,
  staticDir = resolve(root, 'dist'),
} = {}) {
  let inflight = 0;
  let calls = [];
  const configured = Boolean(config.baseUrl && config.model);
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Frame-Options', 'DENY');
      if (
        town &&
        url.pathname.startsWith('/api/') &&
        (req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin &&
            req.headers.origin !== (config.publicOrigin || `http://${req.headers.host}`)))
      )
        throw new HttpError(403, '只接受本站操作。');
      if (town && url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const origin = req.headers.origin;
          const expected = config.publicOrigin || `http://${req.headers.host}`;
          if (origin && origin !== expected) throw new HttpError(403, '只接受本站操作。');
          if (!req.headers['content-type']?.startsWith('application/json'))
            throw new HttpError(415, '请使用 JSON 请求。');
        }
        if (url.pathname === '/api/admin' && req.method === 'POST') {
          const body = await readJson(req, 10001024);
          town.admin(req.headers.authorization?.replace(/^Bearer /, ''), body.action, body.replay);
          return json(res, 200, { ok: true });
        }
        const identity = town.identity(req, res);
        if (url.pathname === '/api/status' && req.method === 'GET')
          return json(res, 200, {
            shared: true,
            configured,
            model: configured ? String(config.model).slice(0, 80) : null,
            wireApi: config.wireApi || 'responses',
          });
        if (url.pathname === '/api/history' && req.method === 'GET')
          return json(res, 200, {
            version: town.version,
            snapshots: town.store.db
              .prepare('SELECT world FROM snapshots ORDER BY version')
              .all()
              .map((row) => JSON.parse(row.world)),
          });
        if (url.pathname === '/api/town' && req.method === 'GET')
          return json(res, 200, town.snapshot(identity));
        if (url.pathname === '/api/stream' && req.method === 'GET') {
          let pending;
          const disconnect = town.connect(
            identity,
            (data) => {
              const message = `data: ${JSON.stringify(data)}\n\n`;
              if (!res.headersSent) pending = message;
              else if (res.writableLength > 1048576) res.destroy();
              else res.write(message);
            },
            String(url.searchParams.get('connection') || 'default').slice(0, 64),
          );
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
          });
          res.write('retry: 3000\n\n' + (pending || ''));
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          res.on('close', () => {
            clearInterval(heartbeat);
            disconnect();
          });
          return;
        }
        if (url.pathname === '/api/commands' && req.method === 'POST')
          return json(res, 202, town.accept(identity, await readJson(req, 4096)));
        if (/^\/api\/commands\/\d+$/.test(url.pathname) && req.method === 'DELETE') {
          town.cancel(identity, Number(url.pathname.split('/').at(-1)));
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/presence' && req.method === 'POST') {
          const body = await readJson(req, 256);
          town.presence(
            identity,
            body.visible === true,
            String(body.connection || 'default').slice(0, 64),
          );
          return json(res, 200, { ok: true });
        }
        throw new HttpError(404, '接口不存在。');
      }
      if (url.pathname === '/api/status' && req.method === 'GET')
        return json(res, 200, {
          configured,
          model: configured ? String(config.model).slice(0, 80) : null,
          wireApi: config.wireApi || 'responses',
        });
      if (['/api/decide', '/api/turn'].includes(url.pathname) && req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== config.publicOrigin)
          throw new HttpError(403, '只接受本站发起的模型请求。');
        if (!configured) throw new HttpError(503, '小镇暂时无法互动，请稍后再来。');
        if (!req.headers['content-type']?.startsWith('application/json'))
          throw new HttpError(415, '请使用 JSON 请求。');
        const parsed = (
          url.pathname === '/api/turn' ? TurnRequestSchema : ModelRequestSchema
        ).safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, '角色或世界参数不正确。');
        calls = calls.filter((time) => Date.now() - time < 60000);
        if (calls.length >= 12 || inflight >= 2)
          throw new HttpError(429, '模型请求有点频繁，请稍后再试。');
        calls.push(Date.now());
        inflight++;
        try {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          res.on('close', cancel);
          try {
            return json(
              res,
              200,
              await requestModel(
                config,
                { ...parsed.data, round: url.pathname === '/api/turn' },
                controller.signal,
              ),
            );
          } finally {
            res.off('close', cancel);
          }
        } finally {
          inflight--;
        }
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, '接口不存在。');
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new HttpError(405, '不支持此请求方法。');
      if (!production && middleware)
        return middleware(req, res, () => {
          res.writeHead(404);
          res.end('Not found');
        });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.split('/').some((part) => part.startsWith('.')))
        throw new HttpError(404, '页面不存在。');
      const dist = resolve(staticDir);
      let target = resolve(dist, '.' + pathname);
      if (target !== dist && !target.startsWith(dist + sep))
        throw new HttpError(404, '页面不存在。');
      try {
        if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      } catch {
        if (!extname(pathname)) target = resolve(dist, 'index.html');
      }
      let body;
      try {
        body = await readFile(target);
      } catch {
        throw new HttpError(404, '页面不存在。');
      }
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
      };
      res.writeHead(200, {
        'Content-Type': types[extname(target)] || 'application/octet-stream',
        'Cache-Control': pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error instanceof HttpError ? error.status : 502, {
        error: error instanceof HttpError ? error.message : '回应失败或超时，请重试。',
      });
    }
  };
}
