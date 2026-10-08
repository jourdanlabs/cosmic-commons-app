// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
// These tests exercise the shipped local server and its actual immutable engine
// worker. They do not substitute a mock engine or copy verdict logic into tests.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, cp, appendFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { sha256 } from '../vendor/commons/dist/src/canonical.js';
import { encodeBundle, decodeBundle } from '../app/bundle.mjs';
import { bundleHash } from '../app/store.mjs';

const clone = value => structuredClone(value);
const example = async name => JSON.parse(await readFile(new URL(`../vendor/commons/examples/${name}.json`, import.meta.url), 'utf8'));
let createApplication, app, client, dataDir;
const otherApps = [];
const temporaryDirectories = [];

async function makeClient(application) {
  const response = await fetch(application.url + '/api/session');
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const { token } = await response.json();
  assert.ok(cookie, 'local session has a cookie');
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32, 'local session token is unguessable');
  return async (path, body, options = {}) => {
    const method = options.method ?? (body === undefined ? 'GET' : 'POST');
    const headers = { cookie, ...(method === 'GET' ? {} : { origin: application.url, 'x-commons-token': token, 'content-type': 'application/json' }), ...options.headers };
    if (options.noCookie) delete headers.cookie;
    if (options.noToken) delete headers['x-commons-token'];
    if (options.noOrigin) delete headers.origin;
    const response = await fetch(application.url + path, { method, headers, ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: response.status, headers: response.headers, body: parsed, text, bytes };
  };
}

async function expectOK(path, body, options, useClient = client) {
  const result = await useClient(path, body, options);
  assert.ok(result.status === 200 || result.status === 201, `${path}: ${result.status} ${result.text}`);
  return result.body;
}

async function newCase(input, title = 'API test case', useClient = client) {
  const { case: created } = await expectOK('/api/cases', { kind: input.kind, title }, undefined, useClient);
  const { case: saved } = await expectOK(`/api/cases/${created.id}/save`, { expectedRevision: created.revision, input }, undefined, useClient);
  return saved;
}

async function runCase(input, title, useClient = client) {
  const saved = await newCase(input, title, useClient);
  const result = await expectOK(`/api/cases/${saved.id}/run`, { expectedRevision: saved.revision, idempotencyKey: randomUUID() }, undefined, useClient);
  assert.equal(result.run.revision, saved.revision);
  assert.equal(result.run.receipt.digest, result.run.digest);
  return { ...result, saved };
}

function policyInput(value = 85) {
  return {
    kind: 'policy', asOf: '2026-09-29T00:00:00.000Z',
    policy: { id: 'decision', version: '1', rules: [{ id: 'threshold', factId: 'score', op: 'gte', value: 80 }] },
    evidence: { sources: [{ id: 'record', content: { score: value } }], facts: [{ id: 'score', sourceId: 'record', value }] },
  };
}

function rehash(receipt) {
  const { digest: ignored, ...payload } = receipt;
  receipt.digest = sha256(payload);
  return receipt;
}

function recommitBundle(envelope) {
  envelope.manifest = {
    records: envelope.records.map(record => ({ type: record.type, id: record.id, sha256: bundleHash(record) })),
    blobs: envelope.blobs.map(({ sha256, bytes }) => ({ sha256, bytes })),
    auditSha256: bundleHash(envelope.audit),
  };
  const { digest: ignored, ...payload } = envelope;
  envelope.digest = bundleHash(payload);
  return envelope;
}

async function verify(rawText, digest) {
  return client('/api/verify' + (digest ? '?expect=' + digest : ''), rawText, { raw: true });
}

function assertRawRefusal(response, clue) {
  assert.ok(response.status === 400 || response.status === 413 || response.status === 200, response.text);
  if (response.status === 200) {
    assert.equal(response.body?.verification?.valid, false, 'malformed raw receipt cannot verify');
    assert.equal(response.body.verification.integrity, 'NOT_CHECKED', 'raw rejection occurs before digest calculation');
    assert.equal(response.body.verification.replay, 'NOT_RUN');
  }
  if (clue) assert.match(response.text, clue);
}

before(async () => {
  ({ createApplication } = await import('../server.mjs'));
  dataDir = await mkdtemp(join(tmpdir(), 'commons-api-'));
  temporaryDirectories.push(dataDir);
  app = await createApplication({ dataDir, port: 0 });
  client = await makeClient(app);
});

after(async () => {
  await app?.close();
  for (const application of otherApps) await application.close();
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
});

test('production application binds loopback and supplies local security headers', async () => {
  assert.equal(app.server.address().address, '127.0.0.1');
  const response = await fetch(app.url + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src\s+'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /COMMONS/);
  const settings = await expectOK('/api/settings');
  assert.equal(settings.engine.version, '0.2.2');
  assert.equal(settings.engine.archiveSha256, 'a7a644f9d99a49c17905ae8ff08cf0aa2c8a69883e89c9964028662d431b5a26');
  assert.equal(settings.engine.intact, true);
});

test('DNS-rebinding Host is refused even on an otherwise local request', async () => {
  const result = await new Promise((resolve, reject) => {
    const req = request(app.url + '/api/settings', { headers: { host: 'attacker.invalid' } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(result.status, 403, result.text);
});

test('cross-origin mutations are refused with a valid local session', async () => {
  const response = await client('/api/cases', { kind: 'policy', title: 'Cross-origin case' }, { headers: { origin: 'https://attacker.invalid' } });
  assert.equal(response.status, 403);
});

test('missing CSRF token, missing cookie, and wrong token cannot mutate data', async () => {
  for (const options of [{ noToken: true }, { noCookie: true }, { headers: { 'x-commons-token': 'incorrect-token' } }]) {
    const response = await client('/api/cases', { kind: 'policy', title: 'Untrusted mutation' }, options);
    assert.equal(response.status, 403, response.text);
  }
});

test('upload, restore, import and engine work receive the same CSRF boundary', async () => {
  const created = await newCase(policyInput());
  for (const path of ['/api/restore', '/api/import', '/api/verify', `/api/cases/${created.id}/attachment?name=test.txt&type=text%2Fplain`, `/api/cases/${created.id}/run`]) {
    const response = await client(path, '{}', { raw: true, noToken: true });
    assert.equal(response.status, 403, path + ': ' + response.text);
  }
});

test('decoded duplicate keys are refused before case creation', async () => {
  for (const raw of ['{"kind":"policy","title":"first","title":"second"}', '{"kind":"policy","title":"first","t\\u0069tle":"second"}']) {
    const response = await client('/api/cases', raw, { raw: true });
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /duplicate/i);
  }
});

test('unsafe integers and excess decimal precision are not rounded into facts', async () => {
  for (const text of ['9007199254740993', '0.10000000000000001', '1.00000000000000001', '-0']) {
    const response = await client('/api/value', { type: 'number', text });
    assert.equal(response.status, 400, `${text}: ${response.text}`);
  }
  assert.equal((await expectOK('/api/value', { type: 'number', text: '0.1' })).value, 0.1);
  assert.equal((await expectOK('/api/value', { type: 'boolean', text: 'false' })).value, false);
  assert.equal((await expectOK('/api/value', { type: 'null', text: 'null' })).value, null);
  assert.equal((await expectOK('/api/value', { type: 'string', text: '' })).value, '');
});

test('malformed UTF-8 is refused without replacing bytes', async () => {
  const raw = Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","kind":"policy"}')]);
  const response = await client('/api/cases', raw, { raw: true });
  assert.equal(response.status, 400, response.text);
  assert.match(response.text, /utf|encod|unicode/i);
});

test('ordinary JSON is bounded at two million raw bytes', async () => {
  const response = await client('/api/format', '{}' + ' '.repeat(2_000_001), { raw: true });
  assert.equal(response.status, 413, response.text);
});

test('advanced JSON preserves invalid drafts by refusing without creating a revision', async () => {
  const saved = await newCase(policyInput());
  for (const rawInput of ['{', '{"kind":"policy","kind":"discovery"}', '{"value":9007199254740993}']) {
    const response = await client(`/api/cases/${saved.id}/save-text`, { expectedRevision: saved.revision, rawInput });
    assert.equal(response.status, 400, response.text);
  }
  const detail = await expectOK(`/api/cases/${saved.id}`);
  assert.equal(detail.case.revision, saved.revision);
  assert.deepEqual(detail.case.input, saved.input);
});

for (const [name, input, expected] of [
  ['satisfied requirements', () => policyInput(), 'ALLOW'],
  ['known failure', () => policyInput(79), 'DENY'],
  ['missing evidence', () => ({ ...policyInput(), evidence: { sources: [], facts: [] } }), 'DEFER'],
  ['numeric type mismatch', () => policyInput('85'), 'ERROR'],
  ['expired evidence', () => { const input = policyInput(); input.evidence.facts[0].expiresAt = input.asOf; return input; }, 'DEFER'],
  ['future evidence', () => { const input = policyInput(); input.evidence.facts[0].observedAt = '2026-09-30T00:00:00.000Z'; return input; }, 'DEFER'],
  ['conflicting claims', () => { const input = policyInput(); input.evidence.facts[0].claimId = 'claim'; input.evidence.facts.push({ id: 'alternate', sourceId: 'record', claimId: 'claim', value: 1 }); return input; }, 'DEFER'],
  ['source commitment mismatch', () => { const input = policyInput(); input.evidence.sources[0].digest = '0'.repeat(64); return input; }, 'ERROR'],
  ['dependency cycle', () => { const input = policyInput(); input.evidence.facts[0].dependsOn = ['score']; return input; }, 'ERROR'],
]) {
  test(`engine-backed policy evaluates ${name} as ${expected}`, async () => {
    const { run } = await runCase(input(), name);
    assert.equal(run.result.verdict, expected);
    assert.equal(run.receipt.input.asOf, '2026-09-29T00:00:00.000Z', 'run preserves explicit evaluation time');
    assert.ok(Array.isArray(run.result.trace));
  });
}

test('a known failed requirement still denies with another missing requirement', async () => {
  const input = policyInput(79);
  input.policy.rules.push({ id: 'missing', factId: 'absent', op: 'exists' });
  const { run } = await runCase(input);
  assert.equal(run.result.verdict, 'DENY');
  assert.deepEqual(run.result.trace.map(rule => rule.result), ['FAIL', 'DEFER']);
});

test('exists treats explicit null and false as present; zero is never missing', async () => {
  for (const value of [null, false, 0, '']) {
    const input = policyInput(value);
    input.policy.rules = [{ id: 'present', factId: 'score', op: 'exists' }];
    assert.equal((await runCase(input)).run.result.verdict, 'ALLOW');
  }
});

test('optimistic revision conflicts refuse save and stale run requests', async () => {
  const saved = await newCase(policyInput());
  const edited = (await expectOK(`/api/cases/${saved.id}/save`, { expectedRevision: saved.revision, input: policyInput(79) })).case;
  for (const [operation, data] of [['save', { input: policyInput() }], ['run', { idempotencyKey: randomUUID() }]]) {
    const response = await client(`/api/cases/${saved.id}/${operation}`, { expectedRevision: saved.revision, ...data });
    assert.equal(response.status, 409, response.text);
  }
  assert.equal((await expectOK(`/api/cases/${saved.id}`)).case.revision, edited.revision);
});

test('saved edits leave the old receipt on its old revision and mark the result stale', async () => {
  const { run, saved } = await runCase(policyInput());
  const edited = (await expectOK(`/api/cases/${saved.id}/save`, { expectedRevision: saved.revision, input: policyInput(79) })).case;
  assert.ok(edited.revision > run.revision);
  assert.equal(edited.latestRun.current, false);
  const downloaded = await client(`/api/runs/${run.id}/receipt`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.text, run.receiptText, 'stored raw receipt is never rewritten');
  assert.equal(JSON.parse(downloaded.text).result.verdict, 'ALLOW');
});

test('run retries with the same idempotency key create one durable run', async () => {
  const saved = await newCase(policyInput());
  const data = { expectedRevision: saved.revision, idempotencyKey: randomUUID() };
  const first = await expectOK(`/api/cases/${saved.id}/run`, data);
  const second = await expectOK(`/api/cases/${saved.id}/run`, data);
  assert.equal(first.run.id, second.run.id);
  assert.equal(first.run.digest, second.run.digest);
  assert.equal((await expectOK(`/api/cases/${saved.id}`)).runs.length, 1);
});

test('simultaneous retry requests record one run with the same idempotency key', async () => {
  const saved = await newCase(policyInput());
  const data = { expectedRevision: saved.revision, idempotencyKey: randomUUID() };
  const [first, second] = await Promise.all([
    expectOK(`/api/cases/${saved.id}/run`, data),
    expectOK(`/api/cases/${saved.id}/run`, data),
  ]);
  assert.equal(first.run.id, second.run.id);
  assert.equal((await expectOK(`/api/cases/${saved.id}`)).runs.length, 1);
});

test('human notes and duplication cannot change a computed verdict', async () => {
  const { run, saved } = await runCase(policyInput(79));
  await expectOK(`/api/cases/${saved.id}/note`, { text: 'Human disagreement: please reconsider.', runId: run.id });
  const detail = await expectOK(`/api/cases/${saved.id}`);
  assert.equal(detail.case.latestRun.result.verdict, 'DENY');
  assert.equal(detail.case.latestRun.digest, run.digest);
  const duplicated = (await expectOK(`/api/cases/${saved.id}/duplicate`, {})).case;
  assert.notEqual(duplicated.id, saved.id);
  assert.equal(duplicated.latestRun, null);
});

test('matched worker replay distinguishes retained anchor from unanchored consistency', async () => {
  const { run } = await runCase(policyInput());
  const clean = await verify(run.receiptText, run.digest);
  assert.equal(clean.status, 200, clean.text);
  assert.equal(clean.body.verification.valid, true);
  assert.equal(clean.body.verification.integrity, 'VALID');
  assert.equal(clean.body.verification.replay, 'MATCH');
  assert.equal(clean.body.verification.anchoring, 'MATCH');
  const unanchored = await verify(run.receiptText);
  assert.equal(unanchored.body.verification.valid, true);
  assert.equal(unanchored.body.verification.anchoring, 'UNANCHORED');
});

test('false first duplicate verdict receipt is refused by the actual raw upload route', async () => {
  const { run } = await runCase(policyInput(79));
  for (const key of ['verdict', 'v\\u0065rdict']) {
    const raw = run.receiptText.replace(/"verdict"\s*:\s*"DENY"/, `"${key}": "ALLOW", "verdict": "DENY"`);
    assert.notEqual(raw, run.receiptText, 'attack injected only duplicate verdict');
    assertRawRefusal(await verify(raw, run.digest), /duplicate/i);
  }
});

test('forged output fails digest integrity before replay', async () => {
  const { run } = await runCase(policyInput(79));
  const forged = clone(run.receipt);
  forged.result.verdict = 'ALLOW';
  const response = await verify(JSON.stringify(forged), run.digest);
  assert.equal(response.body.verification.valid, false);
  assert.equal(response.body.verification.integrity, 'INVALID');
});

test('rehashed false approval fails recomputation even with a matching forged digest', async () => {
  const { run } = await runCase(policyInput(79));
  const forged = clone(run.receipt);
  forged.result.verdict = 'ALLOW';
  rehash(forged);
  const response = await verify(JSON.stringify(forged), forged.digest);
  assert.equal(response.body.verification.valid, false);
  assert.equal(response.body.verification.integrity, 'VALID');
  assert.equal(response.body.verification.anchoring, 'MATCH');
  assert.equal(response.body.verification.replay, 'MISMATCH');
});

test('a different retained digest refuses anchoring without pretending a match', async () => {
  const { run } = await runCase(policyInput());
  const response = await verify(run.receiptText, '0'.repeat(64));
  assert.equal(response.body.verification.valid, false);
  assert.equal(response.body.verification.anchoring, 'MISMATCH');
});

test('runtime changes are explicitly unsupported, never approximate replay', async () => {
  const { run } = await runCase(policyInput());
  const altered = clone(run.receipt);
  altered.runtime.architecture = 'different-architecture';
  rehash(altered);
  const response = await verify(JSON.stringify(altered), altered.digest);
  assert.equal(response.body.verification.integrity, 'VALID');
  assert.equal(response.body.verification.valid, false);
  assert.equal(response.body.verification.replay, 'UNSUPPORTED');
});

test('raw receipt verification refuses invalid encoding, lossy numbers and oversized text', async () => {
  assertRawRefusal(await verify(Buffer.from([0xc3, 0x28])), /utf|encod|unicode/i);
  assertRawRefusal(await verify('{"schemaVersion":9007199254740993}'));
  assertRawRefusal(await verify('{"schemaVersion":1.00000000000000001}'));
  const oversized = await verify('{}' + ' '.repeat(2_000_001));
  assert.equal(oversized.status, 413);
});

test('guided investigation inputs reach the real sensor engine with hand-calculated posterior', async () => {
  const { run } = await runCase(await example('sensor-investigation'));
  assert.ok(Math.abs(run.result.snapshot.posterior.positive - 16 / 17) < 1e-14);
  assert.equal(run.result.snapshot.remainingBudget, 4);
  assert.equal(run.result.action.actionId, 'investigate');
  assert.equal(run.result.adequacy.status, 'NOT_REJECTED');
});

test('the zero-prior decoy cannot rescue a rejected declared family', async () => {
  const { run } = await runCase(await example('discovery-deferred'));
  assert.equal(run.result.adequacy.status, 'REJECTED_DECLARED_FAMILY');
  assert.equal(run.result.decisionStatus, 'DEFER');
  assert.equal(run.result.action, null);
  assert.equal(run.result.snapshot.posterior['excluded-decoy'], 0);
});

test('omitted adequacy defers action suggestions despite a concentrated posterior', async () => {
  const input = await example('sensor-investigation');
  delete input.adequacy;
  const { run } = await runCase(input);
  assert.equal(run.result.adequacy.status, 'NOT_EVALUATED');
  assert.equal(run.result.decisionStatus, 'DEFER');
  assert.equal(run.result.action, null);
});

test('unsupported nonbinary adequacy shows DEFER and suppresses actions', async () => {
  const input = await example('sensor-investigation');
  input.definition.experiments[0].outcomes = ['1', '0', 'other'];
  input.definition.experiments[0].likelihoods = {
    positive: { '1': 0.6, '0': 0.3, other: 0.1 },
    negative: { '1': 0.2, '0': 0.7, other: 0.1 },
  };
  const { run } = await runCase(input);
  assert.equal(run.result.adequacy.status, 'UNSUPPORTED');
  assert.equal(run.result.decisionStatus, 'DEFER');
  assert.equal(run.result.action, null);
});

test('duplicate observation IDs and overspent experiment budgets refuse without a fabricated run', async () => {
  for (const attack of ['duplicate observation', 'overspent budget']) {
    const input = await example('sensor-investigation');
    if (attack === 'duplicate observation') input.observations[1].id = input.observations[0].id;
    else input.definition.budget = 1;
    const saved = await newCase(input);
    const response = await client(`/api/cases/${saved.id}/run`, { expectedRevision: saved.revision, idempotencyKey: randomUUID() });
    assert.equal(response.status, 400, attack + ': ' + response.text);
    assert.match(response.text, attack === 'duplicate observation' ? /duplicate|already/i : /budget/i);
    assert.equal((await expectOK(`/api/cases/${saved.id}`)).runs.length, 0);
  }
});

test('post-observation model changes require a fork and preserve the original history', async () => {
  const input = await example('sensor-investigation');
  const saved = await newCase(input);
  const changed = clone(input); changed.definition.hypotheses[0].prior = 0.6; changed.definition.hypotheses[1].prior = 0.4;
  const response = await client(`/api/cases/${saved.id}/save`, { expectedRevision: saved.revision, input: changed });
  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.code, 'MODEL_FORK_REQUIRED');
  const fork = (await expectOK(`/api/cases/${saved.id}/fork`, { input: changed })).case;
  assert.notEqual(fork.id, saved.id);
  assert.deepEqual(fork.input.observations, []);
  assert.notEqual(fork.input.adequacy.epochId, input.adequacy.epochId);
  assert.deepEqual((await expectOK(`/api/cases/${saved.id}`)).case.input, input);
});

test('private causal inputs are not a capability of the public application', async () => {
  const response = await client('/api/cases', { kind: 'causal', title: 'Unsupported private feature' });
  assert.equal(response.status, 400, response.text);
});

test('uploaded HTML remains a bounded download and binds its exact raw bytes', async () => {
  const saved = await newCase(policyInput());
  const bytes = Buffer.from('<script>globalThis.shouldNeverExecute = true</script>');
  const { attachment, source, case: updated } = await expectOK(`/api/cases/${saved.id}/attachment?name=notes.html&type=text%2Fhtml`, bytes, { raw: true, headers: { 'content-type': 'application/octet-stream' } });
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(source.content.fileSha256, fileHash);
  assert.equal(source.digest, sha256(source.content));
  assert.ok(updated.revision > saved.revision);
  const downloaded = await client(`/api/attachments/${attachment.id}`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(downloaded.bytes, bytes);
});

test('attachment display names are sanitized and cannot control a filesystem path', async () => {
  for (const name of ['../outside.txt', 'folder/file.txt', 'bad\\file.txt']) {
    const saved = await newCase(policyInput());
    const { attachment } = await expectOK(`/api/cases/${saved.id}/attachment?name=${encodeURIComponent(name)}&type=text%2Fplain`, Buffer.from('file'), { raw: true });
    assert.doesNotMatch(attachment.name, /[\\/]/);
    const downloaded = await client(`/api/attachments/${attachment.id}`);
    assert.equal(downloaded.text, 'file');
    assert.doesNotMatch(downloaded.headers.get('content-disposition'), /[\\/]/);
  }
});

test('oversized attachment refuses without adding evidence or revisions', async () => {
  const saved = await newCase(policyInput());
  const response = await client(`/api/cases/${saved.id}/attachment?name=large.bin&type=application%2Foctet-stream`, Buffer.alloc(10 * 1024 * 1024 + 1), { raw: true });
  assert.equal(response.status, 413, response.text);
  const detail = await expectOK(`/api/cases/${saved.id}`);
  assert.equal(detail.case.revision, saved.revision);
  assert.deepEqual(detail.case.attachments, []);
});

test('path traversal cannot download arbitrary project or workspace files', async () => {
  for (const path of ['/api/attachments/..%2F..%2Fpackage.json', '/api/cases/..%2F..%2Fpackage.json', '/%2e%2e/%2e%2e/engine/engine-lock.json', '/vendor/commons/src/index.ts']) {
    const response = await client(path);
    assert.ok(response.status === 400 || response.status === 404, `${path}: ${response.status}`);
  }
});

test('case exports carry receipt text, all versioned records and exact attachment bytes', async () => {
  const { run, saved } = await runCase(policyInput(), 'Exported case');
  const bytes = Buffer.from('attachment evidence\n');
  await expectOK(`/api/cases/${saved.id}/attachment?name=evidence.txt&type=text%2Fplain`, bytes, { raw: true });
  const response = await client(`/api/cases/${saved.id}/export`);
  assert.equal(response.status, 200, response.text);
  const envelope = decodeBundle(response.bytes);
  assert.equal(envelope.format, 'commons-case');
  assert.equal(envelope.version, 1);
  assert.ok(envelope.records.length >= 3);
  assert.ok(response.text.includes(run.digest));
  assert.ok(envelope.blobs.some(blob => Buffer.from(blob.base64, 'base64').equals(bytes)));
  const imported = await expectOK('/api/import', response.bytes, { raw: true });
  assert.ok(imported.case.id);
  assert.ok(imported.checks);
});

test('altered export data, missing attachment or changed raw blob refuses atomically', async () => {
  const saved = await newCase(policyInput(), 'Tamper-resistant export');
  await expectOK(`/api/cases/${saved.id}/attachment?name=evidence.txt&type=text%2Fplain`, Buffer.from('unaltered'), { raw: true });
  const envelope = decodeBundle((await client(`/api/cases/${saved.id}/export`)).bytes);
  const beforeCount = (await expectOK('/api/cases')).cases.length;
  const changedBlob = clone(envelope); changedBlob.blobs[0].base64 = Buffer.from('altered').toString('base64');
  const missingBlob = clone(envelope); missingBlob.blobs = [];
  const changedRecord = clone(envelope); changedRecord.records[0].data.title = 'Forged title';
  for (const altered of [changedBlob, missingBlob, changedRecord]) {
    const response = await client('/api/import', encodeBundle(altered), { raw: true });
    assert.equal(response.status, 400, response.text);
    assert.equal((await expectOK('/api/cases')).cases.length, beforeCount, 'failed import wrote no case');
  }
});

test('a forged approval inside a completely rehashed case package still fails real engine replay', async () => {
  const { saved } = await runCase(policyInput(79));
  const envelope = decodeBundle((await client(`/api/cases/${saved.id}/export`)).bytes);
  const record = envelope.records.find(row => row.type === 'run');
  const receipt = JSON.parse(record.data.receiptText);
  receipt.result.verdict = 'ALLOW'; rehash(receipt);
  record.data.receiptText = JSON.stringify(receipt, null, 2) + '\n';
  record.data.digest = receipt.digest;
  recommitBundle(envelope);
  const before = (await expectOK('/api/cases')).cases.length;
  const response = await client('/api/import', encodeBundle(envelope), { raw: true });
  assert.equal(response.status, 400, response.text);
  assert.equal(response.body.code, 'INVALID_BUNDLE_RECEIPT');
  assert.equal((await expectOK('/api/cases')).cases.length, before);
});

test('full package linkage checks refuse omitted bytes and false source projection even after all hashes are recomputed', async () => {
  const saved = await newCase(policyInput());
  await expectOK(`/api/cases/${saved.id}/attachment?name=evidence.txt&type=text%2Fplain`, Buffer.from('exact bytes'), { raw: true });
  const envelope = decodeBundle((await client(`/api/cases/${saved.id}/export`)).bytes);
  const missing = clone(envelope); missing.blobs = []; recommitBundle(missing);
  const projection = clone(envelope);
  const revision = projection.records.filter(row => row.type === 'revision').sort((a, b) => a.revision - b.revision).at(-1);
  const source = revision.data.input.evidence.sources.find(source => source.content?.fileSha256);
  source.content.fileSha256 = '0'.repeat(64); source.digest = sha256(source.content); recommitBundle(projection);
  const count = (await expectOK('/api/cases')).cases.length;
  for (const value of [missing, projection]) {
    const response = await client('/api/import', encodeBundle(value), { raw: true });
    assert.equal(response.status, 400, response.text);
    assert.match(response.body.code, /MISSING_BLOB|BUNDLE_LINKAGE/);
    assert.equal((await expectOK('/api/cases')).cases.length, count);
  }
});

test('backup restores durable cases, runs and blobs; invalid restore retains active workspace', async () => {
  const { run, saved } = await runCase(policyInput(79), 'Backup source');
  const bytes = Buffer.from('backup-bound bytes');
  const { attachment } = await expectOK(`/api/cases/${saved.id}/attachment?name=backup.txt&type=text%2Fplain`, bytes, { raw: true });
  const backup = await client('/api/backup');
  assert.equal(backup.status, 200, backup.text);
  const backupEnvelope = decodeBundle(backup.bytes);
  assert.equal(backupEnvelope.format, 'commons-backup');
  const restoredDir = await mkdtemp(join(tmpdir(), 'commons-api-restore-'));
  temporaryDirectories.push(restoredDir);
  const target = await createApplication({ dataDir: restoredDir, port: 0 });
  otherApps.push(target);
  const targetClient = await makeClient(target);
  await expectOK('/api/restore', backup.bytes, { raw: true }, targetClient);
  const detail = await expectOK(`/api/cases/${saved.id}`, undefined, undefined, targetClient);
  assert.equal(detail.case.title, 'Backup source');
  assert.equal(detail.runs[0].digest, run.digest);
  const file = await targetClient(`/api/attachments/${attachment.id}`);
  assert.deepEqual(file.bytes, bytes);
  const altered = clone(backupEnvelope); altered.blobs[0].base64 = Buffer.from('changed').toString('base64');
  const refused = await targetClient('/api/restore', encodeBundle(altered), { raw: true });
  assert.equal(refused.status, 400, refused.text);
  assert.equal((await expectOK(`/api/cases/${saved.id}`, undefined, undefined, targetClient)).runs[0].digest, run.digest);
});

test('application restart preserves inputs, historical receipt text and attachment bytes', async () => {
  const { run, saved } = await runCase(policyInput(), 'Restart survivor');
  const bytes = Buffer.from('persistent attachment');
  const { attachment } = await expectOK(`/api/cases/${saved.id}/attachment?name=stored.txt&type=text%2Fplain`, bytes, { raw: true });
  await app.close();
  app = await createApplication({ dataDir, port: 0 });
  client = await makeClient(app);
  const detail = await expectOK(`/api/cases/${saved.id}`);
  assert.equal(detail.case.title, 'Restart survivor');
  assert.equal(detail.runs[0].receiptText, run.receiptText);
  assert.equal(detail.runs[0].digest, run.digest);
  const response = await client(`/api/attachments/${attachment.id}`);
  assert.deepEqual(response.bytes, bytes);
});

test('user content named base64 is preserved exactly by app package transport', async () => {
  const input = policyInput();
  input.evidence.sources[0].content = { base64: 'arbitrary user text', bytesBase64: 'not binary data', contentBase64: 'human assertion', dataBase64: 'no normalization' };
  const saved = await newCase(input, 'Exact user content');
  const exported = await client(`/api/cases/${saved.id}/export`);
  const envelope = decodeBundle(exported.bytes);
  const revision = envelope.records.filter(row => row.type === 'revision').sort((a, b) => a.revision - b.revision).at(-1);
  assert.deepEqual(revision.data.input.evidence.sources[0].content, input.evidence.sources[0].content);
  const imported = await expectOK('/api/import', exported.bytes, { raw: true });
  assert.deepEqual(imported.case.input.evidence.sources[0].content, input.evidence.sources[0].content);
});

test('human evidence content named receiptText is not parsed as an imported engine receipt', async () => {
  const input = policyInput(); input.evidence.sources[0].content = { receiptText: 'A human quotation, not an engine receipt.' };
  const saved = await newCase(input, 'Human quotation');
  const exported = await client(`/api/cases/${saved.id}/export`);
  const imported = await expectOK('/api/import', exported.bytes, { raw: true });
  assert.deepEqual(imported.case.input.evidence.sources[0].content, input.evidence.sources[0].content);
});

test('binary packages refuse changed blob bytes and duplicate decoded header keys before import', async () => {
  const saved = await newCase(policyInput());
  await expectOK(`/api/cases/${saved.id}/attachment?name=evidence.txt&type=text%2Fplain`, Buffer.from('binary-bound evidence'), { raw: true });
  const exported = await client(`/api/cases/${saved.id}/export`);
  const altered = Buffer.from(exported.bytes); altered[altered.length - 1] ^= 1;
  assert.equal((await client('/api/import', altered, { raw: true })).status, 400);
  const magic = Buffer.from('COMMONS-PACKAGE-1\n');
  const length = exported.bytes.readUInt32BE(magic.length);
  const header = exported.bytes.subarray(magic.length + 4, magic.length + 4 + length).toString('utf8');
  const duplicated = header.replace(/"format"\s*:/, '"f\\u006frmat":"commons-case","format":');
  assert.notEqual(duplicated, header);
  const newLength = Buffer.alloc(4); newLength.writeUInt32BE(Buffer.byteLength(duplicated));
  const attack = Buffer.concat([magic, newLength, Buffer.from(duplicated), exported.bytes.subarray(magic.length + 4 + length)]);
  const refused = await client('/api/import', attack, { raw: true });
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.text, /duplicate/i);
});

test('engine adapter refuses a modified frozen file in an isolated copied tree', async () => {
  const copiedRoot = await mkdtemp(join(tmpdir(), 'commons-engine-immutability-'));
  temporaryDirectories.push(copiedRoot);
  await cp(new URL('../engine/', import.meta.url), join(copiedRoot, 'engine'), { recursive: true });
  await cp(new URL('../vendor/', import.meta.url), join(copiedRoot, 'vendor'), { recursive: true });
  await appendFile(join(copiedRoot, 'vendor/commons/dist/src/policy.js'), '\n// Unauthorized downstream mutation.\n');
  const copiedAdapter = await import(new URL('file://' + join(copiedRoot, 'engine/adapter.mjs')).href);
  await assert.rejects(copiedAdapter.run(JSON.stringify(policyInput())), error => {
    assert.equal(error.code, 'ENGINE_CHANGED');
    assert.match(error.message, /dist\/src\/policy\.js/);
    return true;
  });
  assert.equal((await expectOK('/api/settings')).engine.intact, true, 'the real frozen tree remained unchanged');
});

test('workspace symlink is refused instead of following a different data directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'commons-api-symlink-'));
  temporaryDirectories.push(parent);
  const target = join(parent, 'link');
  await symlink(dataDir, target, 'dir');
  await assert.rejects(createApplication({ dataDir: target, port: 0 }), /symlink/i);
});
