import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.BACKUP_DIRECTORY || '/var/backups/useless-civilization';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = join(directory, `town-${new Date().toISOString().slice(0, 10)}.sqlite`);
const db = new DatabaseSync(
  process.env.DATABASE_PATH || '/var/lib/useless-civilization/town.sqlite',
  { readOnly: true },
);
try {
  await backup(db, target);
  chmodSync(target, 0o600);
} finally {
  db.close();
}
const check = new DatabaseSync(target);
try {
  check.exec('PRAGMA journal_mode=DELETE');
  if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
    throw new Error('备份完整性校验失败');
} finally {
  check.close();
}
// Prune only this application's dated backup files after the new backup verifies.
const files = readdirSync(directory)
  .filter((name) => /^town-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
  .sort()
  .reverse();
for (const file of files.slice(7)) {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = join(directory, file + suffix);
    if (existsSync(path)) unlinkSync(path);
  }
}
console.log('Daily SQLite backup verified; latest seven dated backups retained.');
