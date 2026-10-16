/**
 * SQLite through Node's built-in `node:sqlite` (no native build step).
 * One file per deployment; WAL mode so the WebSocket fan-out never blocks on
 * writers.  Schema is event-first: `events` is the source of truth,
 * `conversations` / `messages` are projections kept in the same transaction.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, platform TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
  CREATE TABLE IF NOT EXISTS pair_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    user_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (user_id, seq)
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_device_id TEXT, archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS conversations_user ON conversations(user_id, updated_at);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, device_id TEXT, client_msg_id TEXT,
    status TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id ON messages(user_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');
  CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
  CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END;
  CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

function migrate(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let v = row?.version ?? 0;
  for (; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec("DELETE FROM schema_version");
      db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(v + 1);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `${prefix}_${Buffer.from(bytes).toString("base64url")}`;
}
