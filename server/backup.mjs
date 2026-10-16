import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const destination = process.argv[2];
if (!destination) {
  console.error('请提供备份路径：node --env-file=.env server/backup.mjs backups/town.sqlite');
  process.exit(1);
}
mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(process.env.DATABASE_PATH || 'data/town.sqlite', { readOnly: true });
try {
  await backup(db, destination);
  chmodSync(destination, 0o600);
  console.log('SQLite 备份完成。');
} finally {
  db.close();
}
