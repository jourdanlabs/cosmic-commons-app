// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ENGINE_ROOT = path.join(ROOT, 'vendor/commons');
export const lock = JSON.parse(readFileSync(new URL('./engine-lock.json', import.meta.url),'utf8'));
export const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
export function assertEngine(root = ENGINE_ROOT, manifest = lock) {
  const seen = new Set(); const changed = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p=path.join(dir,name), rel=path.relative(root,p).split(path.sep).join('/'), stat=lstatSync(p);
      if(stat.isSymbolicLink()) { changed.push(rel+' (symlink)'); continue; }
      if(stat.isDirectory()) walk(p);
      else if(stat.isFile()) { seen.add(rel); if(manifest.files[rel]!==bytesHash(readFileSync(p))) changed.push(rel); }
      else changed.push(rel+' (unsupported file)');
    }
  }
  walk(root);
  for(const rel of Object.keys(manifest.files)) if(!seen.has(rel)) changed.push(rel+' (missing)');
  if(changed.length) { const e=new Error('ENGINE_CHANGED: '+changed.slice(0,20).join(', '));e.code='ENGINE_CHANGED';e.status=503;throw e; }
  return {version:manifest.version,archiveSha256:manifest.archiveSha256,mode:manifest.mode,intact:true,files:seen.size};
}
