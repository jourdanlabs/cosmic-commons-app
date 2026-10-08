// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
// App-only binary transport. Engine JSON and receipts retain the frozen strict boundary.
import { parseStrictJson } from '../vendor/commons/dist/src/index.js';
import { bytesHash } from '../engine/integrity.mjs';
const MAGIC=Buffer.from('COMMONS-PACKAGE-1\n');
const MAX=64*1024*1024;
export function encodeBundle(envelope) {
  const blobs=[];
  const headerValue={...envelope,blobs:envelope.blobs.map(item=>{
    if(typeof item.base64!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.base64))throw new Error('Invalid blob encoding');
    const b=Buffer.from(item.base64,'base64');if(b.toString('base64')!==item.base64)throw new Error('Noncanonical blob encoding');
    const index=blobs.length;blobs.push(b);return {...item,base64:{commonsBlob:index,length:b.length,sha256:bytesHash(b)}};
  })};
  const header=Buffer.from(JSON.stringify(headerValue),'utf8');
  parseStrictJson(header.toString('utf8'));
  const lengths=Buffer.alloc(4);lengths.writeUInt32BE(header.length);
  const chunks=[MAGIC,lengths,header];for(const b of blobs){const n=Buffer.alloc(4);n.writeUInt32BE(b.length);chunks.push(n,b);}
  const size=chunks.reduce((n,b)=>n+b.length,0);if(size>MAX)throw Object.assign(new Error('Case package exceeds 64 MiB'),{status:413});
  return Buffer.concat(chunks);
}
export function decodeBundle(bytes) {
  if(bytes.length>MAX)throw Object.assign(new Error('Case package exceeds 64 MiB'),{status:413});
  const decode=b=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);
  if(!bytes.subarray(0,MAGIC.length).equals(MAGIC))return parseStrictJson(decode(bytes));
  let cursor=MAGIC.length;if(cursor+4>bytes.length)throw new Error('Truncated package header');
  const length=bytes.readUInt32BE(cursor);cursor+=4;if(length>2000000||cursor+length>bytes.length)throw new Error('Invalid package header length');
  const header=parseStrictJson(decode(bytes.subarray(cursor,cursor+length)));cursor+=length;
  const blobs=[];while(cursor<bytes.length){if(cursor+4>bytes.length)throw new Error('Truncated attachment length');const n=bytes.readUInt32BE(cursor);cursor+=4;if(n>10*1024*1024||cursor+n>bytes.length)throw new Error('Invalid attachment length');blobs.push(bytes.subarray(cursor,cursor+n));cursor+=n;if(blobs.length>200)throw new Error('Too many package attachments');}
  const used=new Set();
  if(!Array.isArray(header.blobs))throw new Error('Missing package blobs');
  const envelope={...header,blobs:header.blobs.map(item=>{
    const v=item.base64;
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='commonsBlob,length,sha256'||!Number.isInteger(v.commonsBlob)||v.commonsBlob<0||used.has(v.commonsBlob))throw new Error('Invalid attachment reference');
    const b=blobs[v.commonsBlob];if(!b||b.length!==v.length||bytesHash(b)!==v.sha256)throw new Error('Attachment commitment mismatch');used.add(v.commonsBlob);return {...item,base64:b.toString('base64')};
  })};
  if(used.size!==blobs.length)throw new Error('Unreferenced package attachment');return envelope;
}
