/**
 * Database layer -- Node's built-in SQLite (no native deps, no install step).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'tournament.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
// Additive upgrades for databases created by an earlier version.
migrate(db);

/** Rows come back as null-prototype objects; normalise to plain objects. */
const plain = (row) => (row ? { ...row } : row);

export function all(sql, params = []) {
  return db.prepare(sql).all(...params).map(plain);
}
export function get(sql, params = []) {
  return plain(db.prepare(sql).get(...params)) ?? null;
}
export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
export function insert(sql, params = []) {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

/** Run `fn` inside a transaction; rolls back on throw. Supports nesting. */
let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();          // already inside one
  db.exec('BEGIN');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    txDepth--;
  }
}

/** JSON column helpers -- tolerate legacy/corrupt values instead of throwing. */
export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
export const toJson = (value) => JSON.stringify(value ?? null);

export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/**
 * Build a parameterised UPDATE from a whitelist, ignoring undefined fields.
 * Returns false when the payload contained nothing updatable.
 */
export function updateRow(table, id, fields, allowed) {
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(fields[key]);
  }
  if (!sets.length) return false;
  if (allowed.includes('updated_at') === false) {
    const hasCol = all(`PRAGMA table_info(${table})`).some((c) => c.name === 'updated_at');
    if (hasCol) sets.push(`updated_at = datetime('now')`);
  }
  params.push(id);
  run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, params);
  return true;
}

export default db;
