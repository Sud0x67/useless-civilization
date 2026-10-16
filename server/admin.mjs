import { readFile } from 'node:fs/promises';
const [action, path] = process.argv.slice(2);
if (!['pause', 'resume', 'reset', 'import'].includes(action) || !process.env.ADMIN_TOKEN) {
  console.error(
    '用法：node --env-file=.env server/admin.mjs pause|resume|reset|import [replay.json]；需要 ADMIN_TOKEN',
  );
  process.exit(1);
}
const replay = action === 'import' ? await readFile(path, 'utf8') : undefined;
const response = await fetch(process.env.ADMIN_URL || 'http://127.0.0.1:4180/api/admin', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
  },
  body: JSON.stringify({ action, replay }),
});
console.log(response.ok ? '管理操作已完成。' : (await response.json()).error);
if (!response.ok) process.exitCode = 1;
