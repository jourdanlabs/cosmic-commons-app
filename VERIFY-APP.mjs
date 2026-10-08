// Copyright 2026 Leland Jourdan II / C&L Strategy · Apache-2.0
// A package manifest checks consistency; it is not a signature or trusted anchor.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('./',import.meta.url));
const expected=new Map();
for(const line of readFileSync(path.join(root,'CHECKSUMS-APP.sha256'),'utf8').trimEnd().split('\n')) {
  const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
  if(!match||match[2].startsWith('/')||match[2].includes('\\')||match[2].split('/').some(s=>!s||s==='.'||s==='..')||expected.has(match[2])) throw new Error('Invalid manifest');
  expected.set(match[2],match[1]);
}
const actual=new Set();
function walk(dir,prefix='') {
  for(const e of readdirSync(dir,{withFileTypes:true})) {
    const rel=prefix+e.name, p=path.join(dir,e.name);
    if(['data','node_modules','.git'].includes(rel)||rel==='CHECKSUMS-APP.sha256') continue;
    if(e.isSymbolicLink()) throw new Error('Symlink refused: '+rel);
    if(e.isDirectory()) walk(p,rel+'/');
    else if(e.isFile()) {
      actual.add(rel);
      if(createHash('sha256').update(readFileSync(p)).digest('hex')!==expected.get(rel)) throw new Error('Hash mismatch: '+rel);
    } else throw new Error('Unsupported file: '+rel);
  }
}
walk(root);
if(actual.size!==expected.size||[...expected.keys()].some(p=>!actual.has(p))) throw new Error('File set differs');
console.log(JSON.stringify({valid:true,files:actual.size,manifest:'CHECKSUMS-APP.sha256',authenticity:'NOT_ESTABLISHED'}));
