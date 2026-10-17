import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWorld } from '../src/world/engine.ts';
import { WorldSchema } from '../src/shared/schema.ts';

export class TownStore {
  constructor(path = 'data/town.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (version INTEGER PRIMARY KEY, world TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, ip TEXT NOT NULL,
        request_id TEXT NOT NULL, created INTEGER NOT NULL, action TEXT NOT NULL,
        original TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
        UNIQUE(owner, request_id)
      );
      CREATE INDEX IF NOT EXISTS command_owner_time ON commands(owner, created);
      CREATE INDEX IF NOT EXISTS command_ip_time ON commands(ip, created);
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY, created INTEGER NOT NULL, input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS calls_time ON calls(created);
      CREATE TABLE IF NOT EXISTS model_failures (
        call_id INTEGER PRIMARY KEY, created INTEGER NOT NULL, kind TEXT NOT NULL, diagnostic TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS council_votes (
        motion_id TEXT NOT NULL, owner TEXT NOT NULL, ip TEXT NOT NULL,
        choice TEXT NOT NULL CHECK(choice IN ('yes','no')), updated INTEGER NOT NULL,
        PRIMARY KEY (motion_id, owner)
      );
      CREATE INDEX IF NOT EXISTS council_vote_ip ON council_votes(motion_id, ip);
      CREATE TABLE IF NOT EXISTS council_attendees (
        motion_id TEXT NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(motion_id, owner)
      );
      CREATE TABLE IF NOT EXISTS constitution_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, motion_id TEXT UNIQUE NOT NULL, article TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS council_proposals (owner TEXT NOT NULL, ip TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS council_proposal_time ON council_proposals(created);
      CREATE TABLE IF NOT EXISTS council_ai_proposals (
        motion_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS council_ai_proposal_time ON council_ai_proposals(created);
    `);
    if (!this.get('secret')) this.set('secret', randomBytes(32).toString('hex'));
    if (!this.get('world')) {
      this.transaction(() => {
        this.set('world', JSON.stringify(createWorld()));
        this.set('version', '1');
        this.set('paused', 'false');
        this.db.prepare('INSERT INTO snapshots VALUES (?, ?)').run(1, this.get('world'));
      });
    }
    // A model reply lost during process shutdown is never automatically charged again.
    this.db.exec(
      "UPDATE commands SET status='failed', error='上次回应未完成，可以重试。' WHERE status='running'",
    );
    WorldSchema.parse(JSON.parse(this.get('world')));
  }
  get(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  }
  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, String(value));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  saveWorld(world) {
    WorldSchema.parse(world);
    const version = Number(this.get('version')) + 1;
    const value = JSON.stringify(world);
    this.set('world', value);
    this.set('version', version);
    this.db.prepare('INSERT INTO snapshots VALUES (?, ?)').run(version, value);
    this.db.prepare('DELETE FROM snapshots WHERE version <= ?').run(version - 120);
    return version;
  }
  async backup(path) {
    await backup(this.db, path);
    chmodSync(path, 0o600);
  }
  close() {
    this.db.close();
  }
}
