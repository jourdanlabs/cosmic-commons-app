// Copyright 2026 Leland Jourdan II / C&L Strategy · Apache-2.0
// Native ES modules: validation only, never compile or bundle the frozen engine.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, assertEngine } from '../engine/integrity.mjs';
if(process.versions.node!=='24.19.0') throw new Error('Node 24.19.0 required');
assertEngine();
const files=['server.mjs'];
for(const dir of ['app','engine','web','scripts']) for(const file of readdirSync(path.join(ROOT,dir))) {
  if(/\.(mjs|js)$/.test(file)) files.push(`${dir}/${file}`);
}
for(const file of files) {
  const check=spawnSync(process.execPath,['--check',path.join(ROOT,file)],{encoding:'utf8'});
  if(check.status!==0) throw new Error(`${file}: ${check.stderr}`);
}
for(const file of ['web/index.html','web/styles.css','migrations/001-workspace.sql','LICENSE','NOTICE','README.md']) {
  if(!existsSync(path.join(ROOT,file))) throw new Error(`Missing ${file}`);
}
assertEngine();console.log(`Validated ${files.length} application modules. Engine unchanged. No dependency installation or compilation needed.`);
