// Copyright 2026 Leland Jourdan II / JourdanLabs
// SPDX-License-Identifier: Apache-2.0
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertEngine } from './integrity.mjs';
const pending=[]; let active=false;
const LIMIT=8, TIMEOUT=30000;
function pump() {
  if(active||!pending.length) return;
  active=true;const job=pending.shift(); let finished=false;
  const child=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[],{execPath:process.execPath,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
  const timer=setTimeout(()=>finish(new Error('Computation timed out; no verdict was recorded.')),TIMEOUT);
  function finish(error,result) {if(finished)return;finished=true;clearTimeout(timer);child.kill();active=false;if(error)job.reject(error);else job.resolve(result);pump();}
  child.once('message',data=>{if(data.ok)finish(null,data.result);else {const e=new Error(data.error);e.code=data.code;e.status=400;finish(e);}});
  child.once('error',finish);child.once('exit',code=>{if(!finished)finish(new Error('Engine worker exited before returning a result ('+code+').'));});
  child.send(job.request);
}
export function execute(operation,raw='',expected) {
  try {assertEngine();if(Buffer.byteLength(raw,'utf8')>2000000)throw Object.assign(new Error('JSON_TOO_LARGE: 2,000,000 byte engine limit'),{status:413});}
  catch(e){return Promise.reject(e);}
  if(pending.length>=LIMIT)return Promise.reject(Object.assign(new Error('Computation queue is full. Retry after the current run.'),{status:429,code:'QUEUE_FULL'}));
  return new Promise((resolve,reject)=>{pending.push({request:{operation,raw,expected},resolve,reject});pump();});
}
export const run=raw=>execute('run',raw);
export const verify=(raw,expected)=>execute('verify',raw,expected);
export const runtime=()=>execute('runtime');
