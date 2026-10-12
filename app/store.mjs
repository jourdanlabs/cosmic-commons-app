// Copyright 2026 Leland Jourdan II / JourdanLabs
// SPDX-License-Identifier: Apache-2.0
// Application records and persistence. Computation remains in the frozen engine.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256, parseStrictJson, timestamp } from '../vendor/commons/dist/src/index.js';
import { listExamples } from '../vendor/commons/dist/src/examples.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = ['revision', 'run', 'attachment', 'note', 'template', 'verification'];
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
export const LIMITS = Object.freeze({ jsonBytes: 2_000_000, bundleBytes: 64 * 1024 * 1024, attachmentBytes: 10 * 1024 * 1024, workspaceBytes: 250 * 1024 * 1024, attachmentCount: 200, records: 100_000 });
export class StoreError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new StoreError(code, message, status); }
function bytesHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function plain(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_FIELD', `${name} must be an object`); return value; }
function text(value, name, max = 1000, empty = true) { if (typeof value !== 'string' || !value.isWellFormed() || value.length > max || (!empty && !value.trim())) fail('INVALID_FIELD', `${name} must be ${empty ? '' : 'nonempty '}text of at most ${max} characters`); return value; }
function identifier(value, name = 'ID') { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ID', `${name} is invalid`); return value; }
function integer(value, name, min = 0) { if (!Number.isSafeInteger(value) || value < min) fail('INVALID_FIELD', `${name} must be an integer at least ${min}`); return value; }
function boolean(value, name) { if (typeof value !== 'boolean') fail('INVALID_FIELD', `${name} must be a boolean`); return value; }
function instant(value, name) { try { timestamp(value, name); } catch (error) { fail('INVALID_FIELD', error.message); } return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function json(value, name = 'JSON', max = LIMITS.jsonBytes) {
  try { const encoded = canonicalize(value); if (Buffer.byteLength(encoded) > max) fail('SIZE_LIMIT', `${name} exceeds its size limit`, 413); return parseStrictJson(encoded); }
  catch (error) { if (error instanceof StoreError) throw error; fail('INVALID_JSON', `${name}: ${error.message}`); }
}
// App bundles may contain many independently bounded engine JSON documents.
// This canonical app envelope is never substituted for engine canonicalization.
export function bundleHash(value) {
  let nodes = 0;
  const visit = (v, depth) => {
    if (++nodes > 1_000_000 || depth > 110) fail('BUNDLE_LIMIT', 'Bundle nesting/node limit exceeded', 413);
    if (v === null || ['string', 'boolean', 'number'].includes(typeof v)) {
      if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0) || (Number.isInteger(v) && !Number.isSafeInteger(v)))) fail('INVALID_JSON', 'Invalid bundle number');
      if (typeof v === 'string' && !v.isWellFormed()) fail('INVALID_JSON', 'Invalid bundle Unicode');
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map(x => visit(x, depth + 1)).join(',')}]`;
    plain(v, 'Bundle value');
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${visit(v[k], depth + 1)}`).join(',')}}`;
  };
  const encoded = visit(value, 0);
  if (Buffer.byteLength(encoded) > LIMITS.bundleBytes) fail('BUNDLE_LIMIT', 'Bundle exceeds 64 MiB encoded', 413);
  return bytesHash(encoded);
}
function safePath(filename) {
  const absolute = path.resolve(filename);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('UNSAFE_PATH', 'Symlinks are not allowed in workspace paths', 403); }
  return absolute;
}
function now() { return new Date().toISOString(); }
function metadata(data, existing = {}) {
  plain(data, 'Case metadata');
  const out = {};
  for (const [key, max] of [['title', 200], ['question', 2000], ['description', 10_000]]) out[key] = text(Object.hasOwn(data, key) ? data[key] : existing[key] ?? (key === 'title' ? 'Untitled case' : ''), key, max, key !== 'title');
  const tags = Object.hasOwn(data, 'tags') ? data.tags : existing.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 30) fail('INVALID_FIELD', 'tags must be an array of at most 30 entries');
  out.tags = tags.map(t => text(t, 'tag', 80, false));
  out.sourceNotes = json(Object.hasOwn(data, 'sourceNotes') ? data.sourceNotes : existing.sourceNotes ?? {}, 'Source notes', 250_000);
  plain(out.sourceNotes, 'Source notes');
  return out;
}
function inputCopy(input, kind) {
  const copy = json(input, 'Engine input');
  plain(copy, 'Input');
  if (!['policy', 'discovery'].includes(copy.kind) || (kind && copy.kind !== kind)) fail('INVALID_KIND', 'Input kind must match the case');
  if (copy.kind === 'policy') { plain(copy.policy, 'Policy'); plain(copy.evidence, 'Evidence'); if (!Array.isArray(copy.policy.rules) || !Array.isArray(copy.evidence.sources) || !Array.isArray(copy.evidence.facts)) fail('INVALID_INPUT', 'Policy requires rule, source, and fact arrays'); text(copy.asOf, 'Evaluation time', 40, false); }
  else { plain(copy.definition, 'Definition'); if (!Array.isArray(copy.observations)) fail('INVALID_INPUT', 'Investigation requires observations'); }
  return copy;
}
function parseReceipt(rawText) {
  text(rawText, 'Receipt', LIMITS.jsonBytes, false);
  if (Buffer.byteLength(rawText) > LIMITS.jsonBytes) fail('SIZE_LIMIT', 'Receipt exceeds 2 MB', 413);
  let receipt;
  try { receipt = parseStrictJson(rawText); } catch (error) { fail('INVALID_RECEIPT', error.message); }
  plain(receipt, 'Receipt');
  const allowed = ['schemaVersion', 'kind', 'input', 'result', 'runtime', 'digest'];
  if (Object.keys(receipt).some(k => !allowed.includes(k)) || allowed.some(k => !Object.hasOwn(receipt, k)) || receipt.schemaVersion !== 1 || !HEX.test(receipt.digest)) fail('INVALID_RECEIPT', 'Unsupported integrated receipt');
  const { digest, ...payload } = receipt;
  if (sha256(payload) !== digest) fail('RECEIPT_INTEGRITY', 'Receipt payload digest differs');
  inputCopy(receipt.input, receipt.kind);
  return receipt;
}
export function receiptTexts(envelope) { return (envelope?.records ?? []).filter(r => r.type === 'run').map(r => r.data.receiptText); }
function blankInput(kind) {
  if (kind === 'policy') return { kind, asOf: now(), policy: { id: 'policy', version: '1.0.0', rules: [] }, evidence: { sources: [], facts: [] } };
  return { kind, definition: { modelId: 'investigation', observationAssumption: 'conditionally-independent-given-hypothesis-and-experiment', budget: 10, hypotheses: [{ id: 'hypothesis-a', prior: 0.5 }, { id: 'hypothesis-b', prior: 0.5 }], experiments: [{ id: 'measurement', cost: 1, outcomes: ['positive', 'negative'], likelihoods: { 'hypothesis-a': { positive: 0.8, negative: 0.2 }, 'hypothesis-b': { positive: 0.2, negative: 0.8 } } }] }, observations: [], adequacy: { alpha: 0.05, epochId: `epoch-${randomUUID()}` } };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = safePath(dataDir); mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.workspace = path.join(this.dataDir, 'workspace');
    const rollback = path.join(this.dataDir, 'workspace.rollback');
    if (!existsSync(this.workspace) && existsSync(rollback)) renameSync(safePath(rollback), this.workspace);
    this._open(); try { this._checkAll(); } catch (error) { this.close(); throw error; }
  }
  _open() {
    safePath(this.workspace); mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
    this.blobDir = safePath(path.join(this.workspace, 'blobs')); mkdirSync(this.blobDir, { mode: 0o700, recursive: true });
    const filename = safePath(path.join(this.workspace, 'commons.sqlite'));
    this.db = new DatabaseSync(filename); this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) fail('UNSUPPORTED_DATABASE', 'Workspace database is from a newer application');
    this.db.exec(readFileSync(path.join(ROOT, 'migrations/001-workspace.sql'), 'utf8'));
  }
  close() { if (this.db) { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); this.db = null; } }
  _rows(type, caseId) {
    const rows = caseId === undefined ? this.db.prepare('SELECT * FROM records WHERE type=? ORDER BY revision, rowid').all(type) : this.db.prepare('SELECT * FROM records WHERE type=? AND case_id=? ORDER BY revision, rowid').all(type, caseId);
    return rows.map(row => this._decode(row));
  }
  _decode(row) {
    if (!row) return null;
    if (bytesHash(row.json) !== row.hash) fail('STORAGE_INTEGRITY', 'A stored record hash differs', 409);
    const envelope = JSON.parse(row.json), data = envelope.data;
    if (envelope.recordType !== row.type || data.id !== row.id || (data.caseId ?? null) !== row.case_id || (row.type === 'revision' ? data.revision : null) !== row.revision) fail('STORAGE_INTEGRITY', 'Stored index does not match the committed record', 409);
    if (!this._checking) {
      const key = `${row.type}:${row.id}`, known = this._committedHashes?.get(key);
      if (known !== undefined && known !== row.hash) fail('STORAGE_INTEGRITY', 'Stored record changed relative to the loaded audit checkpoint', 409);
      if (known === undefined) {
        const eventRow = this.db.prepare("SELECT a.* FROM audit a, json_each(a.json, '$.records') ref WHERE json_extract(ref.value, '$.type')=? AND json_extract(ref.value, '$.id')=? AND json_extract(ref.value, '$.hash')=? LIMIT 1").get(row.type, row.id, row.hash);
        if (!eventRow || bytesHash(eventRow.json) !== eventRow.hash) fail('AUDIT_INTEGRITY', 'Record is absent from its committed audit event', 409);
        this._committedHashes ??= new Map(); this._committedHashes.set(key, row.hash);
      }
    }
    return data;
  }
  _read(type, id) { return this._decode(this.db.prepare('SELECT * FROM records WHERE type=? AND id=?').get(type, id)); }
  _write(type, data) {
    if (!TYPES.includes(type)) fail('INVALID_RECORD', 'Unknown record type');
    if (this.db.prepare('SELECT COUNT(*) AS n FROM records').get().n >= LIMITS.records) fail('STORAGE_LIMIT', 'Workspace record count reached', 413);
    const encoded = JSON.stringify({ recordType: type, data });
    const hash = bytesHash(encoded);
    this.db.prepare('INSERT INTO records(type,id,case_id,revision,json,hash) VALUES(?,?,?,?,?,?)').run(type, data.id, data.caseId ?? null, type === 'revision' ? data.revision : null, encoded, hash);
    this._pending.push({ type, id: data.id, hash }); return data;
  }
  _transaction(action, fn) {
    this.db.exec('BEGIN IMMEDIATE'); this._pending = [];
    try {
      const result = fn();
      const prev = this.db.prepare('SELECT seq,hash FROM audit ORDER BY seq DESC LIMIT 1').get();
      const event = { seq: (prev?.seq ?? 0) + 1, at: now(), action, previous: prev?.hash ?? null, records: this._pending };
      const encoded = JSON.stringify(event), hash = bytesHash(encoded);
      this.db.prepare('INSERT INTO audit(seq,json,hash) VALUES(?,?,?)').run(event.seq, encoded, hash);
      this.db.exec('COMMIT');
      this._committedHashes ??= new Map(); for (const ref of this._pending) this._committedHashes.set(`${ref.type}:${ref.id}`, ref.hash);
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { this._pending = null; }
  }
  _current(id) {
    identifier(id); const rows = this._rows('revision', id);
    if (!rows.length) fail('NOT_FOUND', 'Case not found', 404);
    return rows.at(-1);
  }
  _snapshot(id, revision) { integer(revision, 'Revision', 1); const r = this._read('revision', `${id}:${revision}`); if (!r) fail('NOT_FOUND', 'Revision not found', 404); return r; }
  _case(snapshot) {
    const runs = this._rows('run', snapshot.caseId).sort((a, b) => a.revision - b.revision || a.createdAt.localeCompare(b.createdAt));
    const latestRun = runs.at(-1);
    return { ...snapshot, id: snapshot.caseId, latestRun: latestRun ? this._runView(latestRun, snapshot.revision) : null, notes: this._rows('note', snapshot.caseId) };
  }
  _runView(run, revision = this._current(run.caseId).revision) { const receipt = parseReceipt(run.receiptText); if (receipt.digest !== run.digest || canonicalize(receipt.input) !== canonicalize(run.input)) fail('STORAGE_INTEGRITY', 'Stored run linkage differs', 409); return { ...run, receipt, result: receipt.result, current: run.revision === revision }; }
  listCases(query = {}) {
    const latest = new Map();
    for (const r of this._rows('revision')) if (!latest.has(r.caseId) || latest.get(r.caseId).revision < r.revision) latest.set(r.caseId, r);
    const search = text(query.search ?? '', 'Search', 500).toLowerCase();
    if (query.kind !== undefined && !['', 'policy', 'discovery'].includes(query.kind)) fail('INVALID_KIND', 'Unknown case filter');
    if (query.archived !== undefined && !['', 'true', 'false', true, false].includes(query.archived)) fail('INVALID_FIELD', 'Archived filter must be true or false');
    return [...latest.values()].filter(r => (!query.kind || r.kind === query.kind) && (query.archived === undefined || query.archived === '' || r.archived === (query.archived === true || query.archived === 'true')) && (!search || [r.title, r.question, r.description, ...r.tags].join(' ').toLowerCase().includes(search))).map(r => this._case(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  getCase(id) {
    const current = this._current(id);
    return { case: this._case(current), history: this._rows('revision', id).map(r => ({ ...r, id, savedAt: r.updatedAt })), runs: this._rows('run', id).map(r => this._runView(r, current.revision)), notes: this._rows('note', id) };
  }
  createCase(data) {
    plain(data, 'Case'); if (!['policy', 'discovery'].includes(data.kind)) fail('INVALID_KIND', 'Choose policy or discovery');
    let input = data.input, template;
    if (data.templateId !== undefined) { template = this.listTemplates().find(t => t.id === data.templateId); if (!template) fail('NOT_FOUND', 'Template not found', 404); if (template.kind !== data.kind) fail('INVALID_KIND', 'Template type differs'); input = template.input; }
    input = inputCopy(input === undefined ? blankInput(data.kind) : input, data.kind);
    const id = randomUUID(), date = now();
    const attachments = (template?.attachments ?? []).map(a => ({ ...a, id: randomUUID(), caseId: id, originalId: a.originalId ?? a.id }));
    if (this._rows('attachment').length + attachments.length > LIMITS.attachmentCount) fail('STORAGE_LIMIT', 'New case exceeds attachment count', 413);
    const snapshot = { id: `${id}:1`, caseId: id, kind: data.kind, ...metadata(data, { sourceNotes: template?.sourceNotes ?? {} }), revision: 1, input, attachments, archived: false, createdAt: date, updatedAt: date };
    if (data.origin) snapshot.origin = json(data.origin, 'Origin', 5000);
    this._transaction('case.created', () => { for (const a of attachments) { this._readBlob(a.sha256); this._write('attachment', a); } this._write('revision', snapshot); }); return this._case(snapshot);
  }
  saveCase(id, data) {
    plain(data, 'Save'); const current = this._current(id);
    integer(data.expectedRevision, 'Expected revision', 1);
    if (current.revision !== data.expectedRevision) fail('REVISION_CONFLICT', 'Case changed; reload before saving', 409);
    const input = inputCopy(data.input, current.kind);
    if (current.kind === 'discovery' && current.input.observations.length) {
      const model = v => ({ definition: v.definition, adequacy: v.adequacy ?? null, actions: v.actions ?? null });
      if (canonicalize(model(input)) !== canonicalize(model(current.input)) || canonicalize(input.observations.slice(0, current.input.observations.length)) !== canonicalize(current.input.observations)) fail('MODEL_FORK_REQUIRED', 'Observed investigation models and recorded observations are frozen; fork a new epoch', 409);
    }
    const snapshot = { ...current, ...metadata(data, current), id: `${id}:${current.revision + 1}`, revision: current.revision + 1, input, updatedAt: now() };
    this._transaction('case.saved', () => { if (this._current(id).revision !== data.expectedRevision) fail('REVISION_CONFLICT', 'Case changed; reload before saving', 409); this._write('revision', snapshot); }); return this._case(snapshot);
  }
  archiveCase(id, archived) {
    boolean(archived, 'Archived'); const current = this._current(id);
    const snapshot = { ...current, id: `${id}:${current.revision + 1}`, revision: current.revision + 1, archived, updatedAt: now() };
    this._transaction('case.archived', () => this._write('revision', snapshot)); return this._case(snapshot);
  }
  duplicateCase(id) { const original = this._current(id); const result = this._copyCase(original, original.input, `${original.title} (copy)`, 'duplicate'); return result; }
  forkCase(id, data = {}) {
    plain(data, 'Fork'); const original = this._current(id); if (original.kind !== 'discovery') fail('INVALID_KIND', 'Only investigations fork epochs');
    const input = inputCopy(data.input ?? original.input, 'discovery'); input.observations = [];
    if (input.adequacy) input.adequacy.epochId = `epoch-${randomUUID()}`;
    return this._copyCase(original, input, data.title ?? `${original.title} (new epoch)`, 'fork');
  }
  _copyCase(original, input, title, operation) {
    const id = randomUUID(), date = now();
    const snapshot = { ...original, id: `${id}:1`, caseId: id, title: text(title, 'Title', 200, false), input: clone(input), revision: 1, archived: false, createdAt: date, updatedAt: date, origin: { operation, caseId: original.caseId, revision: original.revision } };
    // Attachments have immutable byte identity; new app records preserve original
    // source projections rather than rewriting receipt-visible source content.
    const copies = original.attachments.map(a => ({ ...a, id: randomUUID(), caseId: id, originalId: a.originalId ?? a.id })); snapshot.attachments = copies;
    if (this._rows('attachment').length + copies.length > LIMITS.attachmentCount) fail('STORAGE_LIMIT', 'Copy exceeds attachment count', 413);
    this._transaction(`case.${operation}`, () => { for (const a of copies) this._write('attachment', a); this._write('revision', snapshot); }); return this._case(snapshot);
  }
  listTemplates() {
    return [...listExamples().map(e => ({ ...e, kind: e.input.kind, synthetic: true, version: 1 })), ...this._rows('template').map(t => ({ ...t, synthetic: false }))];
  }
  saveTemplate(data) {
    plain(data, 'Template'); const current = this._current(identifier(data.caseId));
    const same = this._rows('template').filter(t => t.name === data.name);
    const template = { id: randomUUID(), name: text(data.name, 'Template name', 200, false), description: text(data.description ?? '', 'Template description', 2000), synthetic: false, version: same.length + 1, kind: current.kind, input: clone(current.input), sourceNotes: clone(current.sourceNotes), attachments: clone(current.attachments), origin: { caseId: current.caseId, revision: current.revision }, createdAt: now() };
    this._transaction('template.saved', () => this._write('template', template)); return template;
  }
  addNote(id, data) {
    plain(data, 'Note'); const current = this._current(id);
    if (data.runId !== undefined && this.getRun(data.runId).caseId !== id) fail('INVALID_RUN', 'Note run belongs to another case');
    const note = { id: randomUUID(), caseId: id, revision: current.revision, text: text(data.text, 'Note', 10_000, false), createdAt: now(), ...(data.runId === undefined ? {} : { runId: data.runId }) };
    this._transaction('note.created', () => this._write('note', note)); return note;
  }
  _blob(sha) { if (!HEX.test(sha)) fail('INVALID_BLOB', 'Invalid file hash'); return safePath(path.join(this.blobDir, sha)); }
  _readBlob(sha) { const filename = this._blob(sha); if (!existsSync(filename) || !lstatSync(filename).isFile()) fail('MISSING_BLOB', 'Referenced attachment is missing', 409); const bytes = readFileSync(filename); if (bytesHash(bytes) !== sha) fail('BLOB_INTEGRITY', 'Attachment byte hash differs', 409); return bytes; }
  _putBlob(bytes, sha = bytesHash(bytes)) {
    const filename = this._blob(sha);
    if (existsSync(filename)) { this._readBlob(sha); return; }
    const temporary = path.join(this.blobDir, `.upload-${randomUUID()}`);
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, filename);
  }
  addAttachment(id, data) {
    plain(data, 'Attachment'); const current = this._current(id); if (current.kind !== 'policy') fail('INVALID_KIND', 'Evidence attachments belong to Decide cases');
    if (!Buffer.isBuffer(data.bytes) && !(data.bytes instanceof Uint8Array)) fail('INVALID_FILE', 'Attachment bytes are required');
    const bytes = Buffer.from(data.bytes); if (bytes.length > LIMITS.attachmentBytes) fail('FILE_LIMIT', 'File exceeds 10 MiB', 413);
    const all = this._rows('attachment'); if (all.length >= LIMITS.attachmentCount) fail('STORAGE_LIMIT', 'Workspace attachment count reached', 413);
    const unique = new Map(all.map(a => [a.sha256, a.bytes])); const sha = bytesHash(bytes); if (!unique.has(sha)) unique.set(sha, bytes.length); if ([...unique.values()].reduce((sum, n) => sum + n, 0) > LIMITS.workspaceBytes) fail('STORAGE_LIMIT', 'Workspace attachment bytes exceeded', 413);
    const rawName = text(data.name ?? 'attachment', 'Filename', 250, false); const name = rawName.replace(/[\/\\\x00-\x1f\x7f]/g, '_');
    const type = text(data.type ?? 'application/octet-stream', 'Media type', 200, false); if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type)) fail('INVALID_FIELD', 'Media type must have type/subtype form');
    const attachment = { id: randomUUID(), caseId: id, name, type, bytes: bytes.length, sha256: sha, createdAt: now() };
    attachment.sourceId = `file-${attachment.id}`;
    const content = { fileSha256: sha, name, mediaType: type, appFileId: attachment.id };
    const source = { id: attachment.sourceId, content, digest: sha256(content) };
    const input = clone(current.input); input.evidence.sources.push(source); inputCopy(input, 'policy');
    const snapshot = { ...current, id: `${id}:${current.revision + 1}`, revision: current.revision + 1, input, attachments: [...current.attachments, attachment], updatedAt: now() };
    this._putBlob(bytes, sha);
    this._transaction('attachment.added', () => { if (this._current(id).revision !== current.revision) fail('REVISION_CONFLICT', 'Case changed during upload', 409); this._write('attachment', attachment); this._write('revision', snapshot); });
    return { attachment, source, case: this._case(snapshot) };
  }
  getAttachment(id) { identifier(id); const attachment = this._read('attachment', id); if (!attachment) fail('NOT_FOUND', 'Attachment not found', 404); return { ...attachment, bytes: this._readBlob(attachment.sha256), byteCount: attachment.bytes }; }
  getSnapshot(id, revision) { return clone(this._snapshot(identifier(id), revision).input); }
  addRun(id, revision, receiptText, idempotencyKey) {
    identifier(id); integer(revision, 'Revision', 1); identifier(idempotencyKey, 'Idempotency key');
    const previous = this.findRun(idempotencyKey, id); if (previous) { if (previous.revision !== revision) fail('IDEMPOTENCY_CONFLICT', 'Key already used for another revision', 409); return previous; }
    const snapshot = this._snapshot(id, revision), receipt = parseReceipt(receiptText);
    if (canonicalize(snapshot.input) !== canonicalize(receipt.input)) fail('RUN_INPUT_MISMATCH', 'Receipt does not match saved input revision', 409);
    const run = { id: randomUUID(), caseId: id, revision, input: clone(receipt.input), receiptText, digest: receipt.digest, idempotencyKey, createdAt: now() };
    this._transaction('run.recorded', () => this._write('run', run)); return this._runView(run);
  }
  findRun(idempotencyKey, caseId) { identifier(idempotencyKey, 'Idempotency key'); identifier(caseId); const run = this._rows('run', caseId).find(r => r.idempotencyKey === idempotencyKey); return run ? this._runView(run) : null; }
  getRun(id) { identifier(id); const run = this._read('run', id); if (!run) fail('NOT_FOUND', 'Run not found', 404); return this._runView(run); }
  addVerification(rawText, expected, verification) {
    text(rawText, 'Receipt text', LIMITS.jsonBytes, false); if (Buffer.byteLength(rawText) > LIMITS.jsonBytes) fail('SIZE_LIMIT', 'Receipt too large', 413);
    if (expected !== undefined && !HEX.test(expected)) fail('INVALID_ANCHOR', 'Trusted digest must be 64 lowercase hexadecimal characters');
    const record = { id: randomUUID(), rawText, rawSha256: bytesHash(rawText), expected: expected ?? null, verification: json(verification, 'Verification'), createdAt: now() };
    this._transaction('receipt.verified', () => this._write('verification', record)); return record;
  }
  listVerifications() { return this._rows('verification').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  stats() { return { cases: this.listCases().length, runs: this._rows('run').length, attachments: this._rows('attachment').length, attachmentBytes: [...new Map(this._rows('attachment').map(a => [a.sha256, a.bytes])).values()].reduce((s, n) => s + n, 0), verifications: this._rows('verification').length, auditEvents: this.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n }; }
  _audit() { return this.db.prepare('SELECT * FROM audit ORDER BY seq').all().map(r => ({ ...JSON.parse(r.json), hash: r.hash })); }
  _checkAll() {
    const rows = this.db.prepare('SELECT * FROM records').all(); if (rows.length > LIMITS.records) fail('STORAGE_LIMIT', 'Workspace record count exceeded', 413);
    let indexed;
    this._checking = true;
    try { indexed = new Map(rows.map(r => { this._decode(r); return [`${r.type}:${r.id}`, r.hash]; })); }
    finally { this._checking = false; }
    const committed = new Set(); let previous = null, seq = 0;
    for (const event of this._audit()) {
      const { hash, ...payload } = event;
      if (event.seq !== ++seq || event.previous !== previous || bytesHash(JSON.stringify(payload)) !== hash) fail('AUDIT_INTEGRITY', 'Application audit chain differs', 409);
      for (const ref of event.records) { if (indexed.get(`${ref.type}:${ref.id}`) !== ref.hash) fail('AUDIT_INTEGRITY', 'Audit reference differs from stored record', 409); committed.add(`${ref.type}:${ref.id}`); }
      previous = hash;
    }
    if (committed.size !== indexed.size) fail('AUDIT_INTEGRITY', 'Stored record lacks its audit event', 409);
    this._committedHashes = indexed;
  }
  _engine() { const lock = JSON.parse(readFileSync(path.join(ROOT, 'engine/engine-lock.json'), 'utf8')); return { version: lock.version, archiveSha256: lock.archiveSha256, mode: lock.mode }; }
  _envelope(format, records, audit = []) {
    const shaSet = new Set(records.filter(r => r.type === 'attachment').map(r => r.data.sha256));
    const blobs = [...shaSet].sort().map(sha => { const bytes = this._readBlob(sha); return { sha256: sha, bytes: bytes.length, base64: bytes.toString('base64') }; });
    const manifest = { records: records.map(r => ({ type: r.type, id: r.id, sha256: bundleHash(r) })), blobs: blobs.map(({ sha256, bytes }) => ({ sha256, bytes })), auditSha256: bundleHash(audit) };
    const payload = { format, version: 1, engine: this._engine(), exportedAt: now(), records, blobs, audit, manifest };
    return { ...payload, digest: bundleHash(payload) };
  }
  _exportRows(caseId) {
    const rows = caseId === undefined ? this.db.prepare('SELECT * FROM records ORDER BY type,id').all() : this.db.prepare('SELECT * FROM records WHERE case_id=? ORDER BY type,id').all(caseId);
    return rows.map(r => ({ type: r.type, id: r.id, caseId: r.case_id, revision: r.revision, data: this._decode(r) }));
  }
  exportCase(id) { this._current(id); this._checkAll(); return this._envelope('commons-case', this._exportRows(id)); }
  backup() { this._checkAll(); return this._envelope('commons-backup', this._exportRows(), this._audit()); }
  _validateEnvelope(value, format) {
    plain(value, 'Bundle');
    if (value.format !== format || value.version !== 1 || !HEX.test(value.digest)) fail('INVALID_BUNDLE', 'Unsupported bundle format/version');
    if (Object.keys(value).some(k => !['format', 'version', 'engine', 'exportedAt', 'records', 'blobs', 'audit', 'manifest', 'digest'].includes(k))) fail('INVALID_BUNDLE', 'Unknown bundle fields');
    const { digest, ...payload } = value; if (bundleHash(payload) !== digest) fail('BUNDLE_INTEGRITY', 'Bundle manifest commitment differs');
    if (bundleHash(value.engine) !== bundleHash(this._engine())) fail('ENGINE_MISMATCH', 'Bundle references a different selected engine release');
    if (!Array.isArray(value.records) || value.records.length > LIMITS.records || !Array.isArray(value.blobs) || value.blobs.length > LIMITS.attachmentCount || !Array.isArray(value.audit)) fail('INVALID_BUNDLE', 'Malformed bundle arrays');
    plain(value.manifest, 'Manifest');
    const rows = new Map(), blobs = new Map();
    for (const record of value.records) {
      plain(record, 'Record'); if (!TYPES.includes(record.type)) fail('INVALID_BUNDLE', 'Unsupported record type'); identifier(record.id);
      const key = `${record.type}:${record.id}`; if (rows.has(key)) fail('INVALID_BUNDLE', 'Duplicate record ID'); rows.set(key, record);
      plain(record.data, 'Record data');
      if (record.data.id !== record.id || (record.data.caseId ?? null) !== record.caseId || (record.type === 'revision' ? record.data.revision : null) !== record.revision) fail('BUNDLE_LINKAGE', 'Record index differs from data');
      instant(record.data.createdAt, 'Record creation time');
      if (record.type === 'revision') instant(record.data.updatedAt, 'Revision update time');
      if (record.type === 'revision') { inputCopy(record.data.input, record.data.kind); metadata(record.data); integer(record.data.revision, 'Revision', 1); identifier(record.data.caseId); boolean(record.data.archived, 'Archived'); if (!Array.isArray(record.data.attachments)) fail('INVALID_BUNDLE', 'Missing revision attachments'); }
      if (record.type === 'run') {
        const receipt = parseReceipt(record.data.receiptText);
        if (receipt.digest !== record.data.digest || canonicalize(receipt.input) !== canonicalize(record.data.input)) fail('BUNDLE_LINKAGE', 'Run differs from its exact receipt');
        if (Object.hasOwn(record.data, 'result') || Object.hasOwn(record.data, 'receipt') || Object.hasOwn(record.data, 'current')) fail('BUNDLE_LINKAGE', 'Run contains an independently supplied verdict/index');
      }
      if (record.type === 'attachment') { text(record.data.name, 'Attachment name', 250, false); text(record.data.type, 'Attachment media type', 200, false); integer(record.data.bytes, 'Attachment bytes'); if (record.data.bytes > LIMITS.attachmentBytes || !HEX.test(record.data.sha256)) fail('INVALID_BUNDLE', 'Invalid attachment bound/hash'); }
      if (record.type === 'note') text(record.data.text, 'Note', 10_000, false);
      if (record.type === 'template') { text(record.data.name, 'Template name', 200, false); integer(record.data.version, 'Template version', 1); inputCopy(record.data.input, record.data.kind); if (record.data.attachments !== undefined && !Array.isArray(record.data.attachments)) fail('INVALID_BUNDLE', 'Template attachments must be an array'); }
      if (record.type === 'verification') { text(record.data.rawText, 'Verification raw text', LIMITS.jsonBytes); if (Buffer.byteLength(record.data.rawText) > LIMITS.jsonBytes || bytesHash(record.data.rawText) !== record.data.rawSha256) fail('BUNDLE_LINKAGE', 'Verification raw hash/bound differs'); if (record.data.expected !== null && !HEX.test(record.data.expected)) fail('INVALID_ANCHOR', 'Invalid recorded trusted digest'); json(record.data.verification, 'Verification'); boolean(record.data.verification.valid, 'Verification valid'); }
    }
    let total = 0;
    for (const blob of value.blobs) {
      plain(blob, 'Blob'); if (!HEX.test(blob.sha256) || blobs.has(blob.sha256) || typeof blob.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob.base64)) fail('INVALID_BLOB', 'Invalid blob encoding');
      const bytes = Buffer.from(blob.base64, 'base64'); if (bytes.length !== blob.bytes || bytes.length > LIMITS.attachmentBytes || bytesHash(bytes) !== blob.sha256) fail('BLOB_INTEGRITY', 'Exported attachment bytes differ'); total += bytes.length; blobs.set(blob.sha256, bytes);
    }
    if (total > LIMITS.workspaceBytes) fail('STORAGE_LIMIT', 'Backup exceeds workspace limit', 413);
    const expectedManifest = { records: value.records.map(r => ({ type: r.type, id: r.id, sha256: bundleHash(r) })), blobs: value.blobs.map(({ sha256, bytes }) => ({ sha256, bytes })), auditSha256: bundleHash(value.audit) };
    if (bundleHash(expectedManifest) !== bundleHash(value.manifest)) fail('BUNDLE_INTEGRITY', 'Manifest references differ');
    const cases = new Set(value.records.filter(r => r.type === 'revision').map(r => r.data.caseId));
    if (format === 'commons-case' && cases.size !== 1) fail('INVALID_BUNDLE', 'Case export must contain exactly one case');
    const revisions = new Map();
    for (const record of value.records.filter(r => r.type === 'revision')) {
      const s = record.data, key = `${s.caseId}:${s.revision}`;
      if (s.id !== key || revisions.has(key)) fail('BUNDLE_LINKAGE', 'Revision key differs'); revisions.set(key, s);
      for (const a of s.attachments) {
        const attached = rows.get(`attachment:${a.id}`)?.data;
        if (!attached || bundleHash(attached) !== bundleHash(a)) fail('BUNDLE_LINKAGE', 'Revision attachment metadata differs');
        if (s.kind === 'policy') {
          const source = s.input.evidence.sources.find(source => source.id === a.sourceId);
          // Removing a source is allowed in a later revision, but retained
          // source projections must bind this exported attachment's exact bytes.
          if (source && (!source.content || source.content.fileSha256 !== a.sha256 || source.content.name !== a.name || source.content.mediaType !== a.type || ![a.id, a.originalId].includes(source.content.appFileId) || source.digest !== sha256(source.content))) fail('BUNDLE_LINKAGE', 'Attachment source projection differs');
        }
      }
    }
    for (const caseId of cases) { const sorted = [...revisions.values()].filter(r => r.caseId === caseId).sort((a,b) => a.revision-b.revision); if (sorted.some((r, i) => r.revision !== i + 1 || r.kind !== sorted[0].kind)) fail('BUNDLE_LINKAGE', 'Revision history must be contiguous and keep its type'); }
    const runKeys = new Set();
    for (const record of value.records) {
      const r = record.data;
      if (record.caseId !== null && !cases.has(record.caseId)) fail('BUNDLE_LINKAGE', 'Record refers to a missing case');
      if (record.type === 'run') { const snapshot = revisions.get(`${r.caseId}:${r.revision}`); if (!snapshot || canonicalize(snapshot.input) !== canonicalize(r.input)) fail('BUNDLE_LINKAGE', 'Run does not match its saved revision'); identifier(r.idempotencyKey, 'Run key'); const key = `${r.caseId}:${r.idempotencyKey}`; if (runKeys.has(key)) fail('BUNDLE_LINKAGE', 'Run idempotency key repeated'); runKeys.add(key); }
      if (record.type === 'attachment') { const bytes = blobs.get(r.sha256); if (!bytes || bytes.length !== r.bytes) fail('MISSING_BLOB', 'Referenced attachment bytes are missing'); }
      if (record.type === 'note' && (!revisions.has(`${r.caseId}:${r.revision}`) || (r.runId && rows.get(`run:${r.runId}`)?.caseId !== r.caseId))) fail('BUNDLE_LINKAGE', 'Note refers to missing revision/run');
      if (record.type === 'template') for (const attachment of r.attachments ?? []) { const linked = rows.get(`attachment:${attachment.id}`)?.data; if (!linked || bundleHash(linked) !== bundleHash(attachment)) fail('BUNDLE_LINKAGE', 'Template attachment commitment differs'); }
    }
    if (blobs.size !== new Set(value.records.filter(r => r.type === 'attachment').map(r => r.data.sha256)).size) fail('BUNDLE_LINKAGE', 'Bundle contains unreferenced blobs');
    if (format === 'commons-backup') {
      let previous = null, seq = 0; const covered = new Set();
      for (const event of value.audit) {
        plain(event, 'Audit event'); instant(event.at, 'Audit time'); text(event.action, 'Audit action', 100, false); if (!Array.isArray(event.records)) fail('AUDIT_INTEGRITY', 'Audit references must be an array');
        const { hash, ...p } = event;
        if (event.seq !== ++seq || event.previous !== previous || bytesHash(JSON.stringify(p)) !== hash) fail('AUDIT_INTEGRITY', 'Backup audit chain differs');
        for (const ref of event.records) { const r = rows.get(`${ref.type}:${ref.id}`); if (!r || bytesHash(JSON.stringify({ recordType: r.type, data: r.data })) !== ref.hash) fail('AUDIT_INTEGRITY', 'Backup audit linkage differs'); covered.add(`${ref.type}:${ref.id}`); }
        previous = hash;
      }
      if (covered.size !== rows.size) fail('AUDIT_INTEGRITY', 'Backup records lack audit events');
    } else if (value.audit.length) fail('INVALID_BUNDLE', 'Case bundles do not contain a workspace audit chain');
    return { rows: value.records, blobs, cases };
  }
  importCase(envelope) {
    const valid = this._validateEnvelope(envelope, 'commons-case'); const originalCaseId = [...valid.cases][0], newId = randomUUID();
    const attachmentMap = new Map(valid.rows.filter(r => r.type === 'attachment').map(r => [r.id, randomUUID()]));
    const runMap = new Map(valid.rows.filter(r => r.type === 'run').map(r => [r.id, randomUUID()]));
    const current = this.stats(); if (current.attachments + attachmentMap.size > LIMITS.attachmentCount) fail('STORAGE_LIMIT', 'Import exceeds attachment count', 413);
    const existing = new Map(this._rows('attachment').map(a => [a.sha256, a.bytes])); for (const [sha, bytes] of valid.blobs) existing.set(sha, bytes.length); if ([...existing.values()].reduce((sum, n) => sum + n, 0) > LIMITS.workspaceBytes) fail('STORAGE_LIMIT', 'Import exceeds workspace bytes', 413);
    for (const [sha, bytes] of valid.blobs) this._putBlob(bytes, sha);
    const attachmentData = new Map(valid.rows.filter(r => r.type === 'attachment').map(r => [r.id, { ...r.data, id: attachmentMap.get(r.id), caseId: newId, originalId: r.data.originalId ?? r.id }]));
    this._transaction('case.imported', () => {
      for (const record of valid.rows) {
        const data = clone(record.data); data.caseId = newId;
        if (record.type === 'revision') { data.id = `${newId}:${data.revision}`; data.attachments = data.attachments.map(a => attachmentData.get(a.id)); data.origin = { operation: 'import', caseId: originalCaseId, bundleDigest: envelope.digest, importedAt: now() }; }
        else if (record.type === 'attachment') Object.assign(data, attachmentData.get(record.id));
        else if (record.type === 'run') { data.id = runMap.get(record.id); data.idempotencyKey = `import-${data.id}`; data.originalId = record.id; }
        else if (record.type === 'note') { data.id = randomUUID(); if (data.runId) data.runId = runMap.get(data.runId); data.originalId = record.id; }
        else fail('INVALID_BUNDLE', 'Case export contains workspace-only records');
        this._write(record.type, data);
      }
    });
    return { case: this.getCase(newId).case, checks: { manifest: 'MATCH', attachmentBytes: 'MATCH', receiptIntegrity: 'VALID', replay: 'NOT_CHECKED_BY_STORE', origin: 'UNANCHORED' } };
  }
  restore(envelope) {
    const valid = this._validateEnvelope(envelope, 'commons-backup');
    const staged = path.join(this.dataDir, `.restore-${randomUUID()}`), rollback = path.join(this.dataDir, 'workspace.rollback');
    mkdirSync(staged, { mode: 0o700 }); mkdirSync(path.join(staged, 'blobs'), { mode: 0o700 });
    let stagedDb;
    try {
      stagedDb = new DatabaseSync(path.join(staged, 'commons.sqlite')); stagedDb.exec(readFileSync(path.join(ROOT, 'migrations/001-workspace.sql'), 'utf8')); stagedDb.exec('BEGIN');
      for (const r of valid.rows) { const encoded = JSON.stringify({ recordType: r.type, data: r.data }); stagedDb.prepare('INSERT INTO records(type,id,case_id,revision,json,hash) VALUES(?,?,?,?,?,?)').run(r.type, r.id, r.caseId, r.revision, encoded, bytesHash(encoded)); }
      for (const event of envelope.audit) { const { hash, ...p } = event; stagedDb.prepare('INSERT INTO audit(seq,json,hash) VALUES(?,?,?)').run(event.seq, JSON.stringify(p), hash); }
      stagedDb.exec('COMMIT'); stagedDb.close(); stagedDb = null;
      for (const [sha, bytes] of valid.blobs) writeFileSync(path.join(staged, 'blobs', sha), bytes, { flag: 'wx', mode: 0o600 });
      safePath(rollback); if (existsSync(rollback)) rmSync(rollback, { recursive: true });
      this.close(); renameSync(this.workspace, rollback);
      try { renameSync(staged, this.workspace); this._open(); this._checkAll(); }
      catch (error) { this.close(); rmSync(this.workspace, { recursive: true, force: true }); renameSync(rollback, this.workspace); this._open(); throw error; }
      rmSync(rollback, { recursive: true }); return { restored: true, checks: { manifest: 'MATCH', attachmentBytes: 'MATCH', auditChain: 'MATCH' }, counts: this.stats() };
    } catch (error) { if (stagedDb) stagedDb.close(); rmSync(staged, { recursive: true, force: true }); if (!this.db) this._open(); throw error; }
  }
}
