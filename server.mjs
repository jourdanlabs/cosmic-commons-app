// Copyright 2026 Leland Jourdan II / JourdanLabs
// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import {readFileSync,existsSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from './app/store.mjs';
import {parseStrictJson} from './vendor/commons/dist/src/index.js';
import {assertEngine,ROOT} from './engine/integrity.mjs';
import * as adapter from './engine/adapter.mjs';
import {encodeBundle,decodeBundle} from './app/bundle.mjs';
import {assertSupportedLaunchRuntime,supportedLaunchRangeLabel} from './scripts/supported-runtime.mjs';

const VERSION='1.0.2';
const defaultData=()=>process.env.COMMONS_DATA_DIR||path.join(os.homedir(),process.platform==='darwin'?'Library/Application Support/COMMONS':'.local/share/commons');
const secretEqual=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const decode=b=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);
const failure=(message,status=400,code='INVALID_REQUEST')=>Object.assign(new Error(message),{status,code});
async function body(req,max=2000000){const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>max)throw failure('Request exceeds the supported byte limit',413,'BODY_LIMIT');chunks.push(b);}return Buffer.concat(chunks);}
async function json(req){return parseStrictJson(decode(await body(req)));}
function receiptTexts(envelope){return [...new Set((envelope?.records??[]).filter(r=>r.type==='run').map(r=>r.data?.receiptText))];}
export async function createApplication({dataDir=defaultData(),port=Number(process.env.PORT||4320)}={}){
  try { assertSupportedLaunchRuntime(); }
  catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
  assertEngine();
  if(existsSync(dataDir)&&lstatSync(dataDir).isSymbolicLink())throw new Error('COMMONS_DATA_DIR may not be a symlink');
  mkdirSync(dataDir,{recursive:true,mode:0o700});dataDir=realpathSync(dataDir);
  const store=new Store(dataDir),session=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
  let url;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function send(value,status=200){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));}
    function download(bytes,name,type='application/octet-stream'){res.setHeader('Content-Type',type);res.setHeader('Content-Disposition','attachment; filename="'+name.replace(/[^a-zA-Z0-9._-]/g,'_')+'"');res.end(bytes);}
    try{
      const authority='127.0.0.1:'+server.address().port;
      if(req.headers.host!==authority)throw failure('Host refused',403,'HOST_REFUSED');
      if(req.headers.origin&&req.headers.origin!==url)throw failure('Origin refused',403,'ORIGIN_REFUSED');
      const target=new URL(req.url,url),p=target.pathname;
      if(req.method==='GET'&&p==='/api/session'){res.setHeader('Set-Cookie','commons_session='+session+'; HttpOnly; SameSite=Strict; Path=/');return send({token});}
      if(p.startsWith('/api/')){
        const cookies=Object.fromEntries((req.headers.cookie??'').split(';').map(s=>s.trim().split('=')));
        if(!secretEqual(cookies.commons_session,session))throw failure('Local session required. Reload COMMONS.',403,'SESSION_REQUIRED');
        if(req.method!=='GET'&&(req.headers.origin!==url||!secretEqual(req.headers['x-commons-token'],token)))throw failure('Mutation token or origin refused',403,'CSRF_REFUSED');
      }
      if(req.method==='GET'){
        if(p==='/api/cases')return send({cases:store.listCases(Object.fromEntries(target.searchParams))});
        if(p==='/api/templates')return send({templates:store.listTemplates()});
        if(p==='/api/verifications')return send({records:store.listVerifications()});
        if(p==='/api/settings')return send({appVersion:VERSION,engine:assertEngine(),runtime:await adapter.runtime(),dataDir,counts:store.stats(),limits:{engineJsonBytes:2000000,attachmentBytes:10485760,bundleBytes:67108864,bundleMetadataBytes:2000000,workspaceBlobBytes:262144000}});
        if(p==='/api/backup')return download(encodeBundle(store.backup()),'COMMONS-workspace.commons-backup');
        let m=p.match(/^\/api\/cases\/([a-zA-Z0-9-]+)$/);if(m)return send(store.getCase(m[1]));
        m=p.match(/^\/api\/cases\/([a-zA-Z0-9-]+)\/export$/);if(m)return download(encodeBundle(store.exportCase(m[1])),'COMMONS-case-'+m[1]+'.commons');
        m=p.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/receipt$/);if(m){const r=store.getRun(m[1]);return download(r.receiptText,'COMMONS-'+m[1]+'.receipt.json','application/json; charset=utf-8');}
        m=p.match(/^\/api\/attachments\/([a-zA-Z0-9-]+)$/);if(m){const a=store.getAttachment(m[1]);return download(a.bytes,a.name,a.type||'application/octet-stream');}
        const assets=new Map([['/','index.html'],['/app.js','app.js'],['/ui.js','ui.js'],['/policy.js','policy.js'],['/investigate.js','investigate.js'],['/styles.css','styles.css'],['/LICENSE','../LICENSE'],['/NOTICE','../NOTICE']]);
        if(assets.has(p)){const f=path.join(ROOT,'web',assets.get(p));res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript; charset=utf-8':p.endsWith('.css')?'text/css; charset=utf-8':p==='/'?'text/html; charset=utf-8':'text/plain; charset=utf-8');return res.end(readFileSync(f));}
        throw failure('Not found',404,'NOT_FOUND');
      }
      if(req.method!=='POST')throw failure('Method not supported',405,'METHOD_NOT_ALLOWED');
      if(p==='/api/value'){
        const v=await json(req);if(typeof v.text!=='string'||!['number','boolean','null','json','string'].includes(v.type))throw failure('Choose an explicit value type and enter its text');
        const value=v.type==='string'?v.text:parseStrictJson(v.text);
        if(v.type!=='json'&&v.type!=='string'&&(v.type==='null'?value!==null:typeof value!==v.type))throw failure('Value does not match the selected type');
        return send({value});
      }
      if(p==='/api/format'){const input=parseStrictJson(decode(await body(req)));return send({formatted:JSON.stringify(input,null,2),input});}
      if(p==='/api/cases')return send({case:store.createCase(await json(req))},201);
      if(p==='/api/templates')return send({template:store.saveTemplate(await json(req))},201);
      if(p==='/api/verify'){
        const raw=decode(await body(req)),expected=target.searchParams.has('expect')?target.searchParams.get('expect'):undefined;
        const verification=await adapter.verify(raw,expected);return send({verification,record:store.addVerification(raw,expected,verification)});
      }
      if(p==='/api/import'||p==='/api/restore'){
        const envelope=decodeBundle(await body(req,64*1024*1024));
        // Stored/imported receipts remain read-only. Replay is a separate check from bundle commitments.
        const checks=[];for(const raw of receiptTexts(envelope)){const r=await adapter.verify(raw);if(r.integrity!=='VALID'||r.replay==='MISMATCH')throw failure('Imported receipt computation or integrity is invalid',400,'INVALID_BUNDLE_RECEIPT');checks.push(r);}
        if(p==='/api/import'){const result=store.importCase(envelope);return send({...result,replayChecks:checks},201);}
        const result=store.restore(envelope);return send({restored:true,result,checks});
      }
      let m=p.match(/^\/api\/cases\/([a-zA-Z0-9-]+)\/(save|save-text|archive|duplicate|fork|run|note|attachment)$/);
      if(!m)throw failure('Not found',404,'NOT_FOUND');
      const [_,id,action]=m;
      if(action==='attachment'){const bytes=await body(req,10*1024*1024);return send(store.addAttachment(id,{name:target.searchParams.get('name')||'attachment',type:target.searchParams.get('type')||'application/octet-stream',bytes}),201);}
      const data=await json(req);
      if(action==='save'||action==='save-text'){if(action==='save-text'){if(typeof data.rawInput!=='string')throw failure('Raw input is required');data.input=parseStrictJson(data.rawInput);delete data.rawInput;}return send({case:store.saveCase(id,data)});}
      if(action==='archive')return send({case:store.archiveCase(id,data.archived)});
      if(action==='duplicate')return send({case:store.duplicateCase(id)},201);
      if(action==='fork')return send({case:store.forkCase(id,data)},201);
      if(action==='note')return send({note:store.addNote(id,data)},201);
      if(action==='run'){
        if(typeof data.idempotencyKey!=='string'||!data.idempotencyKey||data.idempotencyKey.length>128)throw failure('An idempotency key is required');
        const existing=store.findRun(data.idempotencyKey,id);if(existing){if(existing.revision!==data.expectedRevision)throw failure('Run key already belongs to another revision.',409,'IDEMPOTENCY_CONFLICT');return send({run:existing,case:store.getCase(id).case});}
        const current=store.getCase(id).case;if(current.revision!==data.expectedRevision)throw failure('Case changed. Reload before running.',409,'REVISION_CONFLICT');
        const input=store.getSnapshot(id,data.expectedRevision),receipt=await adapter.run(JSON.stringify(input));
        const receiptText=JSON.stringify(receipt,null,2)+'\n';
        const run=store.addRun(id,data.expectedRevision,receiptText,data.idempotencyKey);return send({run,case:store.getCase(id).case});
      }
    }catch(error){if(!res.headersSent)send({error:error.message||'Operation failed',code:error.code||'INVALID_REQUEST'},error.status||400);else res.destroy();}
  });
  server.headersTimeout=10000;server.requestTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});url='http://127.0.0.1:'+server.address().port;
  return {server,url,store,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  createApplication().then(app=>{console.log('\nCOSMIC COMMONS 1.0.2\nReason. Decide. Replay.\n\nOpen '+app.url+'\nYour work stays on this computer.\nCtrl+C stops the application.\n');let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);});}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
