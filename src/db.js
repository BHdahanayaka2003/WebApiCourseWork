import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provinces (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS districts (
  id INTEGER PRIMARY KEY, province_id INTEGER NOT NULL REFERENCES provinces(id),
  name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS substations (
  id INTEGER PRIMARY KEY, district_id INTEGER NOT NULL REFERENCES districts(id),
  name TEXT NOT NULL UNIQUE, voltage_level_kv INTEGER NOT NULL, capacity_mva REAL NOT NULL);
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY,
  substation_id INTEGER NOT NULL REFERENCES substations(id),
  meter_id TEXT NOT NULL UNIQUE,              -- meter/inverter id is an ATTRIBUTE, not a Device entity
  name TEXT NOT NULL, owner_name TEXT NOT NULL,
  capacity_kw REAL NOT NULL CHECK (capacity_kw > 0),
  latitude REAL NOT NULL, longitude REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  installed_on TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
-- Append-only time series: one row per reading, never a last_power column on installations.
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,                            -- UTC, ISO-8601, second precision
  power_kw REAL NOT NULL CHECK (power_kw >= 0),
  energy_kwh REAL NOT NULL CHECK (energy_kwh >= 0),   -- cumulative
  voltage_v REAL NOT NULL,
  UNIQUE (installation_id, ts));
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
CREATE INDEX IF NOT EXISTS idx_installations_sub ON installations(substation_id);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('national','provincial','district')),
  province_id INTEGER REFERENCES provinces(id), district_id INTEGER REFERENCES districts(id));
CREATE VIEW IF NOT EXISTS substation_geo AS
  SELECT s.*, d.province_id FROM substations s JOIN districts d ON d.id = s.district_id;
CREATE VIEW IF NOT EXISTS installation_geo AS
  SELECT i.*, s.district_id, d.province_id FROM installations i
  JOIN substations s ON s.id = i.substation_id JOIN districts d ON d.id = s.district_id;
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
