// Copyright 2026 Leland Jourdan II / C&L Strategy · Apache-2.0
import { assertEngine } from '../engine/integrity.mjs';
import { assertSupportedLaunchRuntime, supportedLaunchRangeLabel } from './supported-runtime.mjs';
try { assertSupportedLaunchRuntime(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const {DatabaseSync}=process.getBuiltinModule('node:sqlite');
const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE check_runtime (id INTEGER PRIMARY KEY)');db.close();
console.log(`Node ${process.versions.node} · ${process.platform}/${process.arch} · SQLite available`);
console.log(`COMMONS ${assertEngine().version} · original engine files intact`);
console.log('Ready. Run node server.mjs, then open http://127.0.0.1:4320');
