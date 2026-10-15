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
function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > 262144) {
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
        if (!configured)
          throw new HttpError(503, '尚未配置模型。请在项目的 .env 中填写模型服务，再重启服务器。');
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
        throw new HttpError(404, '页面不存在，请先运行 npm run build。');
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
        error:
          error instanceof HttpError
            ? error.message
            : '模型请求失败或超时，世界已保留原状，请重试。',
      });
    }
  };
}
