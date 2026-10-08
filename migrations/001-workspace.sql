-- Copyright 2026 Leland Jourdan II / C&L Strategy
-- SPDX-License-Identifier: Apache-2.0
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS records (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  case_id TEXT,
  revision INTEGER,
  json TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS records_case ON records(case_id, type, revision);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  hash TEXT NOT NULL
);
PRAGMA user_version = 1;
