// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, bundleHash } from '../app/store.mjs';
import { runRequest, sha256 } from '../vendor/commons/dist/src/index.js';

function fixture(t) { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'commons-store-'))); const store = new Store(dir); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); }); return { store, dir }; }
function copy(value) { return structuredClone(value); }
function hasCode(code) { return e => e.code === code; }
function refreshDigest(bundle) { const { digest, ...rest } = bundle; bundle.digest = bundleHash(rest); return bundle; }
function refreshManifest(bundle) { bundle.manifest.records = bundle.records.map(r => ({ type: r.type, id: r.id, sha256: bundleHash(r) })); bundle.manifest.blobs = bundle.blobs.map(({ sha256, bytes }) => ({ sha256, bytes })); bundle.manifest.auditSha256 = bundleHash(bundle.audit); return refreshDigest(bundle); }

test('saved case revisions persist across restart; conflicts preserve prior state', t => {
  const { store, dir } = fixture(t);
  const first = store.createCase({ kind: 'policy', title: 'Actual case', tags: ['release'] });
  const input = copy(first.input); input.policy.rules.push({ id: 'required', factId: 'review', op: 'exists' });
  const second = store.saveCase(first.id, { expectedRevision: 1, input, title: 'Revised case' });
  assert.equal(second.revision, 2);
  assert.throws(() => store.saveCase(first.id, { expectedRevision: 1, input }), hasCode('REVISION_CONFLICT'));
  store.close(); const reopened = new Store(dir);
  try { const detail = reopened.getCase(first.id); assert.equal(detail.case.title, 'Revised case'); assert.equal(detail.history.length, 2); assert.equal(detail.history[0].input.policy.rules.length, 0); assert.equal(reopened.listCases({ search: 'revised' }).length, 1); } finally { reopened.close(); }
});

test('run records bind exact saved revisions; idempotency and stale flags survive editing', t => {
  const { store } = fixture(t);
  const c = store.createCase({ kind: 'policy', title: 'Release', templateId: 'release-authorization' });
  const receiptText = JSON.stringify(runRequest(c.input), null, 2) + '\n';
  const run = store.addRun(c.id, 1, receiptText, 'one');
  assert.equal(run.current, true); assert.equal(run.result.verdict, 'ALLOW');
  assert.equal(store.addRun(c.id, 1, receiptText, 'one').id, run.id);
  const next = copy(c.input); next.evidence.facts.find(f => f.id === 'critical').value = 3;
  store.saveCase(c.id, { expectedRevision: 1, input: next });
  assert.equal(store.getRun(run.id).current, false);
  assert.equal(store.getCase(c.id).case.latestRun.current, false);
  assert.throws(() => store.addRun(c.id, 2, receiptText, 'other'), hasCode('RUN_INPUT_MISMATCH'));
  assert.throws(() => store.addRun(c.id, 2, receiptText, 'one'), hasCode('IDEMPOTENCY_CONFLICT'));
  const duplicate = store.duplicateCase(c.id); assert.equal(duplicate.latestRun, null); assert.equal(duplicate.revision, 1);
});

test('investigation observations freeze model and prefix; explicit forks create new empty epochs', t => {
  const { store } = fixture(t);
  const c = store.createCase({ kind: 'discovery', title: 'Sensor', templateId: 'sensor-investigation' });
  const change = copy(c.input); change.definition.budget = 11;
  assert.throws(() => store.saveCase(c.id, { expectedRevision: 1, input: change }), hasCode('MODEL_FORK_REQUIRED'));
  const remove = copy(c.input); remove.observations.pop();
  assert.throws(() => store.saveCase(c.id, { expectedRevision: 1, input: remove }), hasCode('MODEL_FORK_REQUIRED'));
  const append = copy(c.input); append.observations.push({ id: 'measurement-3', experimentId: 'probe', outcome: '0' });
  store.saveCase(c.id, { expectedRevision: 1, input: append });
  const fork = store.forkCase(c.id, { input: change, title: 'Reconsidered sensor' });
  assert.notEqual(fork.input.adequacy.epochId, c.input.adequacy.epochId); assert.deepEqual(fork.input.observations, []);
  assert.equal(fork.input.definition.budget, 11); assert.equal(store.getCase(c.id).history[0].input.observations.length, 2);
});

test('attachments bind raw bytes separately from their engine source projection', t => {
  const { store } = fixture(t); const c = store.createCase({ kind: 'policy', title: 'Documents' });
  const bytes = Buffer.from('Evidence document\n');
  const { attachment, source, case: updated } = store.addAttachment(c.id, { bytes, name: '../../doc.txt', type: 'text/plain' });
  assert.doesNotMatch(attachment.name, /[\/\\]/); assert.equal(updated.revision, 2);
  assert.equal(attachment.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(source.digest, sha256(source.content)); assert.notEqual(source.digest, attachment.sha256);
  assert.deepEqual(store.getAttachment(attachment.id).bytes, bytes);
  const wrong = copy(store.exportCase(c.id)); wrong.blobs[0].base64 = Buffer.from('Altered').toString('base64');
  assert.throws(() => store.importCase(wrong), hasCode('BUNDLE_INTEGRITY'));
});

test('complete case export/import retains exact receipt bytes and attachment history with new local identities', t => {
  const { store } = fixture(t);
  const c = store.createCase({ kind: 'policy', title: 'Own case', templateId: 'release-authorization' });
  const added = store.addAttachment(c.id, { name: 'review.txt', type: 'text/plain', bytes: Buffer.from('approved') });
  const raw = JSON.stringify(runRequest(added.case.input), null, 2) + '\n';
  const run = store.addRun(c.id, 2, raw, 'check-1'); store.addNote(c.id, { text: 'Reviewer commentary', runId: run.id });
  const bundle = store.exportCase(c.id); const imported = store.importCase(bundle);
  assert.notEqual(imported.case.id, c.id); assert.equal(imported.checks.manifest, 'MATCH');
  const detail = store.getCase(imported.case.id);
  assert.equal(detail.history.length, 2); assert.equal(detail.runs[0].receiptText, raw); assert.equal(detail.runs[0].result.verdict, 'ALLOW');
  assert.equal(detail.notes[0].runId, detail.runs[0].id); assert.notEqual(detail.case.attachments[0].id, added.attachment.id);
  assert.equal(detail.case.attachments[0].originalId, added.attachment.id);
  assert.deepEqual(store.getAttachment(detail.case.attachments[0].id).bytes, Buffer.from('approved'));
  // Imported snapshots deliberately retain original engine-visible appFileId.
  // A second export still verifies that projection against provenance mapping.
  assert.doesNotThrow(() => store.importCase(store.exportCase(imported.case.id)));
});

test('manifest rewriting cannot detach a run from its saved input or inject a stored verdict', t => {
  const { store } = fixture(t); const c = store.createCase({ kind: 'policy', title: 'Checks', templateId: 'release-authorization' });
  store.addRun(c.id, 1, JSON.stringify(runRequest(c.input)), 'first');
  const mismatch = copy(store.exportCase(c.id)); mismatch.records.find(r => r.type === 'revision').data.input.policy.id = 'changed'; refreshManifest(mismatch);
  assert.throws(() => store.importCase(mismatch), hasCode('BUNDLE_LINKAGE'));
  const verdict = copy(store.exportCase(c.id)); verdict.records.find(r => r.type === 'run').data.result = { verdict: 'ALLOW' }; refreshManifest(verdict);
  assert.throws(() => store.importCase(verdict), hasCode('BUNDLE_LINKAGE'));
  const absent = copy(store.exportCase(c.id)); absent.records = absent.records.filter(r => r.type !== 'revision'); refreshManifest(absent);
  assert.throws(() => store.importCase(absent), hasCode('INVALID_BUNDLE'));
  assert.equal(store.listCases().length, 1);
});

test('workspace backup restores all entities and blobs; malformed restore never destroys active data', t => {
  const { store } = fixture(t); const c = store.createCase({ kind: 'policy', title: 'Durable' });
  store.addAttachment(c.id, { bytes: Buffer.from('keep'), name: 'keep.txt', type: 'text/plain' });
  store.saveTemplate({ name: 'My policy', caseId: c.id }); store.addNote(c.id, { text: 'Keep this note' });
  store.addVerification('invalid receipt', undefined, { valid: false, integrity: 'NOT_CHECKED', replay: 'NOT_RUN', anchoring: 'UNANCHORED', reason: 'Invalid JSON' });
  const backup = store.backup(); const counts = store.stats();
  store.createCase({ kind: 'discovery', title: 'After backup' });
  const bad = copy(backup); bad.blobs = []; refreshManifest(bad);
  assert.throws(() => store.restore(bad), hasCode('MISSING_BLOB')); assert.equal(store.listCases().length, 2);
  const restored = store.restore(backup); assert.equal(restored.restored, true); assert.deepEqual(store.stats(), counts);
  assert.equal(store.listTemplates().filter(t => !t.synthetic).length, 1); assert.equal(store.getCase(c.id).notes.length, 1);
  assert.equal(store.listVerifications().length, 1);
});

test('a failure after staging and workspace swap rolls back the original database and blobs', t => {
  const { store } = fixture(t); const before = store.createCase({ kind: 'policy', title: 'Before backup' });
  const backup = store.backup();
  const live = store.createCase({ kind: 'policy', title: 'Must survive failed restore' });
  const { attachment } = store.addAttachment(live.id, { name: 'live.txt', type: 'text/plain', bytes: Buffer.from('live evidence') });
  const originalCheck = store._checkAll;
  store._checkAll = function () { throw new Error('Injected post-swap validation failure'); };
  assert.throws(() => store.restore(backup), /Injected post-swap/);
  store._checkAll = originalCheck; store._checkAll();
  assert.equal(store.getCase(before.id).case.title, 'Before backup');
  assert.equal(store.getCase(live.id).case.title, 'Must survive failed restore');
  assert.deepEqual(store.getAttachment(attachment.id).bytes, Buffer.from('live evidence'));
});

test('user templates retain supporting files and human assertion metadata without sharing case identities', t => {
  const { store } = fixture(t); const c = store.createCase({ kind: 'policy', title: 'Original' });
  const added = store.addAttachment(c.id, { name: 'support.txt', type: 'text/plain', bytes: Buffer.from('source') });
  store.saveCase(c.id, { expectedRevision: 2, input: added.case.input, sourceNotes: { [added.source.id]: { excerpt: 'source', locator: 'line 1', assertion: 'Entered by operator' } } });
  const template = store.saveTemplate({ name: 'Supporting records', caseId: c.id });
  const next = store.createCase({ kind: 'policy', title: 'From template', templateId: template.id });
  assert.equal(next.attachments.length, 1); assert.notEqual(next.attachments[0].id, added.attachment.id);
  assert.equal(next.sourceNotes[added.source.id].locator, 'line 1');
  assert.deepEqual(store.getAttachment(next.attachments[0].id).bytes, Buffer.from('source'));
  assert.doesNotThrow(() => store.importCase(store.exportCase(next.id)));
  const backup = store.backup(); assert.doesNotThrow(() => store.restore(backup));
});

test('local record/index tampering fails relative to audit history; blob symlinks refuse', t => {
  const { store, dir } = fixture(t); const c = store.createCase({ kind: 'policy', title: 'Bound history' });
  const added = store.addAttachment(c.id, { bytes: Buffer.from('safe'), name: 'a.txt', type: 'text/plain' });
  const row = store.db.prepare("SELECT * FROM records WHERE type='revision' LIMIT 1").get();
  const parsed = JSON.parse(row.json); parsed.data.title = 'False title'; const modified = JSON.stringify(parsed);
  store.db.prepare('UPDATE records SET json=?, hash=? WHERE type=? AND id=?').run(modified, createHash('sha256').update(modified).digest('hex'), row.type, row.id);
  assert.throws(() => store.backup(), hasCode('AUDIT_INTEGRITY'));
  const blob = path.join(dir, 'workspace', 'blobs', added.attachment.sha256); rmSync(blob); const target = path.join(dir, 'outside'); writeFileSync(target, 'safe'); symlinkSync(target, blob);
  assert.throws(() => store.getAttachment(added.attachment.id), hasCode('UNSAFE_PATH'));
});

test('strict application fields reject coercion and unsupported capability kinds', t => {
  const { store } = fixture(t);
  assert.throws(() => store.createCase({ kind: 'causal', title: 'Private capability' }), hasCode('INVALID_KIND'));
  assert.throws(() => store.createCase({ kind: 'policy', title: 42 }), hasCode('INVALID_FIELD'));
  const c = store.createCase({ kind: 'policy', title: 'Fields' });
  assert.throws(() => store.saveCase(c.id, { expectedRevision: '1', input: c.input }), hasCode('INVALID_FIELD'));
  assert.throws(() => store.archiveCase(c.id, 'false'), hasCode('INVALID_FIELD'));
  const unsafe = copy(c.input); unsafe.evidence.facts.push({ id: 'n', sourceId: 'source', value: 9007199254740992 });
  assert.throws(() => store.saveCase(c.id, { expectedRevision: 1, input: unsafe }), hasCode('INVALID_JSON'));
  assert.equal(store.listTemplates().filter(t => t.synthetic).length, 5);
});
