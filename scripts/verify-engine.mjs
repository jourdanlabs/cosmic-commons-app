// Copyright 2026 Leland Jourdan II / C&L Strategy · Apache-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, lock, assertEngine, bytesHash } from '../engine/integrity.mjs';
const actual=bytesHash(readFileSync(path.join(ROOT,'engine',lock.archive)));
if(actual!==lock.archiveSha256) throw new Error('ENGINE_ARCHIVE_CHANGED');
console.log(JSON.stringify({...assertEngine(),archiveIntact:true},null,2));
