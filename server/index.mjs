import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.mjs';
import { SharedTown } from './town.mjs';
const production = process.argv.includes('--production');
const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || '127.0.0.1';
let handler;
const server = createServer((req, res) => handler(req, res));
let vite;
if (!production) {
  const { createServer: createVite } = await import('vite');
  vite = await createVite({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
}
const config = {
  baseUrl: process.env.LLM_BASE_URL,
  model: process.env.LLM_MODEL,
  apiKey: process.env.LLM_API_KEY,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  wireApi: process.env.LLM_WIRE_API || 'responses',
  adminToken: process.env.ADMIN_TOKEN,
  trustProxy: process.env.TRUST_PROXY === '1',
};
const localPreview = process.env.LOCAL_PREVIEW === '1';
if (localPreview && host !== '127.0.0.1') throw new Error('单人预览仅允许监听本机');
const town = localPreview
  ? undefined
  : new SharedTown({
      path: process.env.DATABASE_PATH || 'data/town.sqlite',
      config,
      limits: {
        callsMinute: Number(process.env.MODEL_CALLS_PER_MINUTE || 6),
        callsDay: Number(process.env.MODEL_CALLS_PER_DAY || 5000),
        visitorDay: Number(process.env.VISITOR_OPERATIONS_PER_DAY || 600),
        interval: Number(process.env.TOWN_INTERVAL_MS || 20000),
      },
    });
handler = createHandler({ production, middleware: vite?.middlewares, config, town });
server.listen(port, host, () =>
  console.log(`Useless Civilization is running at http://${host}:${port}/`),
);
async function close() {
  town?.close();
  await vite?.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
