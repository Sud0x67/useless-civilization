import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.mjs';
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
handler = createHandler({
  production,
  middleware: vite?.middlewares,
  config: {
    baseUrl: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
    apiKey: process.env.LLM_API_KEY,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    wireApi: process.env.LLM_WIRE_API || 'responses',
  },
});
server.listen(port, host, () =>
  console.log(`Useless Civilization is running at http://${host}:${port}/`),
);
async function close() {
  await vite?.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
