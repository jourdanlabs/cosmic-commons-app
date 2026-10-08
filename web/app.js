// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
// Full local application shell, adapted from the public COMMONS workbench.
import { el, field, button, input, select, textArea, renderError } from './ui.js';
import { renderPolicy } from './policy.js';
import { renderInvestigation } from './investigate.js';
const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const json = value => JSON.stringify(value, null, 2);
const display = value => value === undefined ? '—' : typeof value === 'object' ? json(value) : String(value);
function append(node, ...children) { node.append(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)); }
const state = { token: null, detail: null, draft: null, dirty: false, generation: 0, saveTimer: null, saving: null, raw: null, tab: 'overview', form: null, formContainer: null, selectedRun: null, route: '', toastTimer: null, pendingRun: null, running: false, navigation: 0, pendingReceipt: null };
let sessionPromise;
function connection(ready) { $('connection').className = `connection ${ready ? 'connected' : 'disconnected'}`; $('connection-label').textContent = ready ? 'Local workspace ready' : 'Service unavailable'; }
function toast(message) { clearTimeout(state.toastTimer); $('toast').textContent = message; $('toast').hidden = false; state.toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function globalError(error) { $('global-error').replaceChildren(renderError(error)); $('global-error').hidden = false; }
function clearError() { $('global-error').hidden = true; $('global-error').replaceChildren(); }
async function session() {
  if (!sessionPromise) sessionPromise = fetch('/api/session', { credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('Could not open the local session.'); const data = await response.json(); state.token = data.token; return data;
  }).catch(error => { sessionPromise = null; throw error; });
  return sessionPromise;
}
export async function api(path, body, options = {}) {
  const mutation = body !== undefined;
  await session();
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(path, { method: mutation ? 'POST' : 'GET', credentials: 'same-origin', signal: controller.signal,
      headers: mutation ? { 'Content-Type': options.contentType || (options.raw ? 'application/octet-stream' : 'application/json'), 'x-commons-token': state.token } : {},
      body: mutation ? options.raw ? body : JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => null);
    connection(true);
    if (!response.ok) { const error = new Error(data?.error?.message || data?.error || `Request failed (${response.status}).`); error.code = data?.code || data?.error?.code; error.status = response.status; if (['SESSION_REQUIRED', 'CSRF_REFUSED'].includes(error.code)) { sessionPromise = null; state.token = null; } throw error; }
    if (data === null) throw new Error('The service returned an invalid response.');
    return data;
  } catch (error) { if (error.name === 'AbortError') throw new Error('The operation timed out. Your saved work is retained.'); if (error instanceof TypeError) connection(false); throw error; }
  finally { clearTimeout(timeout); }
}
function download(path, label, className = 'secondary-button') {
  let busy = false;
  return el('a', { href: path, className, download: '', onclick: async event => {
    event.preventDefault();
    if (busy) return;
    const control = event.currentTarget; busy = true; control.setAttribute('aria-busy', 'true'); control.classList.add('is-pending');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 65000);
    try {
      if (path.endsWith('/export') && state.detail) await save();
      await session();
      const response = await fetch(path, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) { const failure = await response.json().catch(() => null); throw new Error(failure?.error?.message || failure?.error || `Download refused (${response.status}).`); }
      const disposition = response.headers.get('Content-Disposition') || '';
      let filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || /filename=([^;]*)/i.exec(disposition)?.[1] || 'COMMONS-download';
      const encoded = /filename\*=UTF-8''([^;]*)/i.exec(disposition)?.[1];
      if (encoded) { try { filename = decodeURIComponent(encoded); } catch {} }
      filename = filename.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '') || 'COMMONS-download';
      const url = URL.createObjectURL(await response.blob());
      const link = el('a', { href: url, download: filename }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { globalError(error.name === 'AbortError' ? new Error('Download timed out. Your saved records are retained.') : error); }
    finally { clearTimeout(timer); busy = false; if (control.isConnected) { control.removeAttribute('aria-busy'); control.classList.remove('is-pending'); } }
  } }, label);
}
function badge(text, style = '') { return el('span', { className: `pill ${style}` }, text); }
function verdict(run) { return run?.result?.verdict || run?.result?.decisionStatus || run?.receipt?.result?.verdict || run?.receipt?.result?.decisionStatus || 'NOT RUN'; }
function verdictClass(value) { return ['ALLOW', 'AVAILABLE', 'VALID', 'MATCH'].includes(value) ? 'ready' : ['DENY', 'ERROR', 'INVALID', 'MISMATCH'].includes(value) ? 'invalid' : 'warning'; }
function heading(title, copy, actions = []) { return el('div', { className: 'page-heading' }, el('div', {}, el('h2', {}, title), copy ? el('p', { className: 'muted' }, copy) : null), el('div', { className: 'actions' }, actions)); }
function section(title, content, copy) { return el('section', { className: 'form-section' }, el('div', { className: 'section-heading' }, el('h3', {}, title), copy ? el('p', { className: 'help' }, copy) : null), content); }
function details(title, value) { return el('details', { className: 'json-details' }, el('summary', {}, title), el('pre', {}, typeof value === 'string' ? value : json(value))); }
function tableValue(value) {
  if (value !== null && typeof value === 'object') {
    const array = Array.isArray(value); const count = array ? value.length : Object.keys(value).length;
    return el('details', { className: 'table-value' }, el('summary', {}, `Show ${count} ${array ? count === 1 ? 'item' : 'items' : count === 1 ? 'field' : 'fields'}`), el('pre', {}, json(value)));
  }
  return display(value);
}
function table(title, rows, keys) {
  if (!rows?.length) return null;
  const records = rows.map(row => row && typeof row === 'object' ? row : { value: row });
  const columns = keys || [...new Set(records.flatMap(Object.keys))].slice(0, 7);
  return section(title, el('div', { className: 'data-table-wrap' }, el('table', { className: 'data-table' },
    el('thead', {}, el('tr', {}, columns.map(key => el('th', { scope: 'col' }, key)))),
    el('tbody', {}, records.map(row => el('tr', {}, columns.map(key => el('td', {}, tableValue(row[key])))))))));
}
function records(value, name = 'id') { return Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).map(([key, value]) => typeof value === 'object' && value !== null ? { [name]: key, ...value } : { [name]: key, value }) : []; }
async function copyDigest(digest) { try { await navigator.clipboard.writeText(digest); toast('Digest copied. Keep the trusted reference separately.'); } catch { await dialog('Receipt digest', el('div', {}, el('p', { className: 'help' }, 'Select and copy this exact digest.'), el('textarea', { rows: 3, readOnly: true, value: digest }))); } }
function dialog(title, body, actions = [{ label: 'Close', value: null }]) {
  return new Promise(resolve => {
    const modal = $('modal'); modal.replaceChildren(el('h2', { id: 'modal-title' }, title), body);
    const finish = value => { modal.close(); resolve(value); };
    modal.append(el('div', { className: 'dialog-actions' }, actions.map(action => button(action.label, () => finish(action.value), action.className || 'secondary-button'))));
    modal.oncancel = () => resolve(null); modal.showModal();
  });
}
async function confirmAction(title, message, label = 'Continue', danger = false) {
  return !!(await dialog(title, el('p', {}, message), [{ label: 'Cancel', value: false }, { label, value: true, className: danger ? 'danger-button' : 'primary-button' }]));
}
function validForm() {
  if (state.raw !== null) return true;
  const invalid = state.formContainer?.querySelector('input:invalid, textarea:invalid, select:invalid');
  if (invalid) { invalid.reportValidity(); return false; }
  if (state.formContainer?.dataset.invalid === 'true' || state.form?.validate?.() === false) return false;
  return true;
}
function status(message, bad = false) { const node = $('save-status'); if (node) { node.textContent = message; node.className = `save-status${bad ? ' save-error' : ''}`; } const stale = $('run-current'); if (stale && state.detail?.case.latestRun) stale.textContent = state.dirty ? 'INPUT CHANGED · PREVIOUS RESULT' : state.detail.case.latestRun.current ? 'CURRENT RESULT' : 'PREVIOUS REVISION'; }
function changed() { state.dirty = true; state.generation++; status('Unsaved changes'); clearTimeout(state.saveTimer); state.saveTimer = setTimeout(() => save().catch(globalError), 600); }
function inputChanged(value) { state.draft.input = clone(value); state.raw = null; changed(); }
async function save() {
  clearTimeout(state.saveTimer);
  if (state.saving) { await state.saving; if (state.dirty) return save(); return; }
  if (!state.dirty || !state.detail) return;
  if (!validForm()) { status('Input needs validation; changes retained', true); throw new Error('Resolve the highlighted input before saving or running.'); }
  const id = state.detail.case.id; const generation = state.generation; const submitted = clone(state.draft);
  const body = { expectedRevision: state.detail.case.revision, title: submitted.title, question: submitted.question, description: submitted.description, tags: submitted.tags, sourceNotes: submitted.sourceNotes || {} };
  const raw = state.raw;
  if (raw !== null) body.rawInput = raw; else body.input = submitted.input;
  status('Saving…');
  state.saving = (async () => {
    try {
      const response = await api(`/api/cases/${encodeURIComponent(id)}/${raw !== null ? 'save-text' : 'save'}`, body);
      if (state.detail?.case.id !== id) return;
      state.detail.case = response.case;
      state.form?.markSaved?.(response.case.input);
      if (state.generation === generation) { state.dirty = false; state.draft = clone(response.case); if (raw !== null) state.raw = raw; }
      status(state.dirty ? 'More changes waiting…' : `Saved · revision ${response.case.revision}`);
      if ($('case-title')) $('case-title').textContent = state.draft.title;
    } catch (error) {
      status('Save failed · your changes are retained', true);
      if (error.status === 409) showConflict(error);
      throw error;
    } finally { state.saving = null; }
  })();
  await state.saving;
  if (state.dirty && state.generation !== generation) return save();
}
function showConflict(error) {
  const node = $('conflict'); if (!node) return;
  node.replaceChildren(el('strong', {}, error.code === 'MODEL_FORK_REQUIRED' ? 'This investigation needs a fresh fork.' : 'A newer revision exists. Your edits are retained.'),
    el('p', {}, error.message), el('div', { className: 'actions' }, button('Reload saved revision', async () => {
      if (await confirmAction('Discard local edits?', 'Reload the saved case and discard only your unsaved browser edits.', 'Reload', true)) { state.dirty = false; await openCase(state.detail.case.id); }
    }), button('Preserve edits in a new case', async () => {
      const original = state.detail.case; const draft = clone(state.draft); const raw = state.raw;
      let response;
      if (original.kind === 'discovery') { if (raw !== null) throw new Error('Use guided inputs to create a fresh investigation fork; the invalid raw input remains available to copy.'); response = await api(`/api/cases/${original.id}/fork`, { input: draft.input, title: `${draft.title} — fork` }); }
      else { response = await api('/api/cases', { kind: 'policy', title: `${draft.title} — recovered edits` }); response = await api(`/api/cases/${response.case.id}/${raw !== null ? 'save-text' : 'save'}`, { title: `${draft.title} — recovered edits`, question: draft.question, description: draft.description, tags: draft.tags, sourceNotes: draft.sourceNotes, expectedRevision: response.case.revision, ...(raw !== null ? { rawInput: raw } : { input: draft.input }) }); }
      state.dirty = false; await navigate(`#case/${response.case.id}`);
    }))); node.hidden = false;
}
async function navigate(route) { await save(); if (!validForm()) throw new Error('Resolve the highlighted inputs before leaving this case.'); location.hash = route; if (location.hash === state.route) await renderRoute(); }
async function renderRoute() {
  const route = location.hash || '#cases';
  if (state.route && route !== state.route && !validForm()) { location.hash = state.route; globalError(new Error('Resolve the highlighted input before leaving this case. Your draft is retained.')); return; }
  if (state.route && route !== state.route && state.dirty) { try { await save(); } catch (error) { location.hash = state.route; globalError(error); return; } }
  if (route !== state.route) { state.form?.destroy?.(); state.detail = null; state.draft = null; state.raw = null; state.form = null; state.formContainer = null; state.selectedRun = null; state.tab = 'overview'; }
  state.route = route; clearError();
  const navigation = ++state.navigation;
  const page = route.startsWith('#case/') ? 'cases' : route.slice(1);
  document.querySelectorAll('[data-page]').forEach(node => { const active = node.dataset.page === page; node.classList.toggle('active', active); if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  $('view').replaceChildren(el('p', { className: 'loading-message' }, 'Loading…'));
  try {
    if (route.startsWith('#case/')) await openCase(decodeURIComponent(route.slice(6)), navigation);
    else if (page === 'templates') await renderTemplates(navigation);
    else if (page === 'receipts') { const raw = state.pendingReceipt; state.pendingReceipt = null; await renderVerifier(raw, navigation); }
    else if (page === 'settings') await renderSettings(navigation);
    else await renderCases(navigation);
  } catch (error) { if (navigation !== state.navigation) return; globalError(error); $('view').replaceChildren(el('div', { className: 'empty-state' }, el('h3', {}, 'Could not open this view'), el('p', {}, error.message), button('Try again', renderRoute))); }
}
async function createCase(template) {
  const title = input(template ? `${template.name} case` : '', () => {}, { placeholder: 'Give your question a name', required: true });
  const kind = select(template?.kind || 'policy', [{ value: 'policy', label: 'Decide — evidence and requirements' }, { value: 'discovery', label: 'Investigate — hypotheses and experiments' }], () => {});
  if (template) kind.disabled = true;
  const question = textArea('', () => {}, { placeholder: 'What do you want to decide or learn?' });
  const okay = await dialog(template ? `Use ${template.name}` : 'Start a case', el('div', { className: 'form-stack' },
    template?.synthetic ? el('p', { className: 'notice' }, 'This is a synthetic starter. Replace its assumptions and records with your own.') : null,
    field('Title', title), field('Case type', kind), field('Question', question)), [{ label: 'Cancel', value: false }, { label: 'Create case', value: true, className: 'primary-button' }]);
  if (!okay) return; if (!title.value.trim()) throw new Error('Enter a title to create the case.');
  const response = await api('/api/cases', { kind: kind.value, title: title.value, question: question.value, ...(template ? { templateId: template.id } : {}) }); await navigate(`#case/${response.case.id}`);
}
async function importCase(file) { if (!file) return; const response = await api('/api/import', await file.arrayBuffer(), { raw: true }); toast('Case imported with its saved versions and receipts.'); await navigate(`#case/${response.case.id}`); }
async function renderCases(navigation = state.navigation) {
  const templates = (await api('/api/templates')).templates;
  if (navigation !== state.navigation) return;
  const search = input('', () => {} , { placeholder: 'Search titles, questions, and tags', 'aria-label': 'Search cases', type: 'search' });
  const kind = select('', [{ value: '', label: 'All case types' }, { value: 'policy', label: 'Decide' }, { value: 'discovery', label: 'Investigate' }], load);
  kind.setAttribute('aria-label', 'Filter case type');
  const archived = select('false', [{ value: 'false', label: 'Active cases' }, { value: 'true', label: 'Archived cases' }, { value: 'all', label: 'All cases' }], load); archived.setAttribute('aria-label', 'Archive filter');
  const list = el('div', { className: 'cases-grid' }); const count = el('p', { className: 'help' });
  const importControl = el('input', { type: 'file', accept: '.commons,.json,.commons.json', 'aria-label': 'Import case', onchange: async event => { try { await importCase(event.target.files[0]); } catch (error) { globalError(error); } } });
  $('view').replaceChildren(heading('Your cases', 'Keep questions, evidence, assumptions, and results together.', [button('New case', () => createCase(), 'primary-button')]),
    el('div', { className: 'toolbar' }, search, kind, archived), count, list,
    section('Bring your work with you', field('Import a saved COMMONS case', importControl, 'Case imports preserve versions, receipts, and attached files. Imported receipts keep their original runtime identity.')));
  let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(globalError), 250); });
  let request = 0;
  async function load() { const current = ++request; const response = await api(`/api/cases?search=${encodeURIComponent(search.value)}&kind=${kind.value}&archived=${archived.value === 'all' ? '' : archived.value}`); if (current !== request || navigation !== state.navigation) return;
    count.textContent = `${response.cases.length} ${response.cases.length === 1 ? 'case' : 'cases'}`;
    if (!response.cases.length) { list.replaceChildren(el('div', { className: 'empty-state wide' }, el('span', { className: 'empty-symbol' }, '◈'), el('h3', {}, search.value ? 'No matching cases' : 'Give your next question a home.'), el('p', {}, 'Start a blank case or use a clearly labeled synthetic example.'), el('div', { className: 'actions' }, button('Blank case', () => createCase(), 'primary-button'), ...templates.slice(0, 2).map(template => button(template.name, () => createCase(template)))))); return; }
    list.replaceChildren(...response.cases.map(record => el('article', { className: 'case-card' },
      el('div', { className: 'card-top' }, badge(record.kind === 'policy' ? 'DECIDE' : 'INVESTIGATE'), record.archived ? badge('ARCHIVED') : null),
      el('a', { className: 'case-title', href: `#case/${record.id}` }, record.title), el('p', { className: 'case-question' }, record.question || record.description || 'A question ready to explore.'),
      el('div', { className: 'card-bottom' }, badge(verdict(record.latestRun), verdictClass(verdict(record.latestRun))), el('span', { className: 'help' }, record.latestRun && !record.latestRun.current ? 'Previous revision' : `Revision ${record.revision}`)),
      el('p', { className: 'timestamp' }, `Edited ${new Date(record.updatedAt).toLocaleString()}`), el('div', { className: 'tags' }, (record.tags || []).map(tag => badge(tag))))));
  }
  await load();
}
async function openCase(id, navigation = state.navigation) {
  const detail = await api(`/api/cases/${encodeURIComponent(id)}`); if (navigation !== state.navigation) return; state.detail = detail; state.draft = clone(detail.case); state.dirty = false; state.raw = null; state.generation++; renderCase();
}
function renderCase() {
  state.form?.destroy?.();
  const c = state.detail.case; const draft = state.draft;
  const tabs = ['overview', 'inputs', 'results', 'history'];
  const bar = el('div', { className: 'case-header' }, el('div', {}, el('a', { className: 'back-link', href: '#cases' }, '← All cases'), el('p', { className: 'eyebrow' }, `${c.kind === 'policy' ? 'DECIDE' : 'INVESTIGATE'} · REVISION ${c.revision}`), el('h2', { id: 'case-title' }, draft.title), el('span', { id: 'save-status', className: 'save-status', role: 'status' }, `Saved · revision ${c.revision}`)),
    el('div', { className: 'actions' }, button('Save now', save), button('Run reasoning', runCase, 'primary-button')));
  const content = el('div', { id: 'case-content' });
  const conflict = el('div', { id: 'conflict', className: 'notice', hidden: true });
  const tabbar = el('nav', { className: 'case-tabs', 'aria-label': 'Case sections' }, tabs.map(tab => button(tab.charAt(0).toUpperCase() + tab.slice(1), async () => {
    if (!validForm()) throw new Error('Resolve the highlighted values before leaving these inputs.'); await save(); state.tab = tab; renderCase();
  }, `case-tab${state.tab === tab ? ' active' : ''}`)));
  const more = el('details', { className: 'case-menu' }, el('summary', {}, 'Case actions'), el('div', { className: 'actions' },
    button(c.archived ? 'Unarchive' : 'Archive', async () => { await save(); await api(`/api/cases/${c.id}/archive`, { archived: !c.archived }); if (state.detail?.case.id === c.id) await openCase(c.id); }),
    button('Duplicate', async () => { await save(); const response = await api(`/api/cases/${c.id}/duplicate`, {}); await navigate(`#case/${response.case.id}`); }),
    button('Save as template', saveTemplate), download(`/api/cases/${c.id}/export`, 'Export complete case')));
  $('view').replaceChildren(bar, conflict, more, tabbar, content);
  state.form = null; state.formContainer = null;
  if (state.tab === 'overview') renderOverview(content);
  else if (state.tab === 'inputs') renderInputs(content);
  else if (state.tab === 'results') renderResults(content, state.selectedRun || c.latestRun);
  else renderHistory(content);
}
function renderOverview(container) {
  const draft = state.draft;
  const update = key => value => { state.draft[key] = value; changed(); };
  append(container, section('The question', el('div', { className: 'form-stack' }, field('Title', input(draft.title, update('title'), { required: true })), field('Question', textArea(draft.question, update('question'), { rows: 2 })), field('Description', textArea(draft.description, update('description'))), field('Tags', input((draft.tags || []).join(', '), value => { state.draft.tags = value.split(',').map(tag => tag.trim()).filter(Boolean); changed(); }), 'Separate tags with commas.'))),
    section('Latest computation', draft.latestRun ? el('div', {}, badge(verdict(draft.latestRun), verdictClass(verdict(draft.latestRun))), el('p', { className: 'help' }, draft.latestRun.current ? 'This result records the current saved revision.' : 'This result records an earlier revision. Run again to evaluate the current inputs.'), button('Inspect result', () => { state.tab = 'results'; renderCase(); })) : el('p', { className: 'muted' }, 'No run yet. Set up your inputs, then run reasoning.')),
    section('How this case works', el('p', {}, draft.kind === 'policy' ? 'State the requirements and provide evidence facts. COMMONS evaluates every requirement at your recorded time. ALLOW does not perform or authorize a real-world action.' : 'Declare a finite family of hypotheses and experiments. Record observations, then inspect conditional posterior weights, adequacy, budget, and expected-loss suggestions. A model family is an assumption, not an established truth.')),
    attachmentSection());
  if (draft.origin) append(container, details('Case origin', draft.origin));
}
function attachmentSection() {
  const c = state.detail.case;
  if (c.kind !== 'policy') return section('Observation records', el('p', { className: 'muted' }, 'Record ordered observations in Inputs. Each saved investigation preserves its declared model and observation sequence in history.'));
  const files = (c.attachments || []).map(file => el('div', { className: 'attachment-row' }, download(`/api/attachments/${file.id}`, file.name), el('code', {}, file.sha256 || file.fileSha256 || ''), el('span', { className: 'help' }, `${file.bytes ?? file.size ?? file.byteLength ?? 0} bytes`)));
  const upload = el('input', { type: 'file', 'aria-label': 'Attach a source file', onchange: async event => { try { await uploadAttachment(event.target.files[0]); } catch (error) { globalError(error); } } });
  return section('Attached sources', el('div', { className: 'form-stack' }, files.length ? files : el('p', { className: 'muted' }, 'No files attached.'), field('Attach a file', upload, 'Files stay local. The recorded hash commits to the bytes; facts extracted from a file remain your assertions. Maximum 10 MiB per file.')));
}
async function uploadAttachment(file) {
  if (!file) return; await save();
  const c = state.detail.case;
  const controls = [...document.querySelectorAll('#case-content input, #case-content select, #case-content textarea, #case-content button, .case-header button, .case-tabs button')].map(node => ({ node, disabled: node.disabled }));
  controls.forEach(({ node }) => node.disabled = true); status('Attaching source file…');
  try {
    const response = await api(`/api/cases/${c.id}/attachment?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || 'application/octet-stream')}`, await file.arrayBuffer(), { raw: true });
    if (state.detail?.case.id === c.id) { state.tab = 'inputs'; await openCase(c.id); }
    toast('File attached and source record added.'); return response;
  } finally { controls.forEach(({ node, disabled }) => { if (node.isConnected) node.disabled = disabled; }); }
}
function renderInputs(container) {
  const mode = el('div', { className: 'input-mode actions' }); const form = el('div', { id: 'guided-inputs' }); const advanced = el('div', { id: 'advanced-inputs', hidden: true });
  const guidedButton = button('Guided inputs', async () => {
    await save(); state.raw = null; renderInputsInto(form); form.hidden = false; advanced.hidden = true; guidedButton.classList.add('selected'); jsonButton.classList.remove('selected');
  });
  const jsonButton = button('Advanced JSON', async () => {
    if (!validForm()) throw new Error('Resolve guided input errors before switching to JSON.'); await save(); state.raw = json(state.draft.input); editor.value = state.raw; form.hidden = true; advanced.hidden = false; guidedButton.classList.remove('selected'); jsonButton.classList.add('selected');
  }); guidedButton.classList.add('selected'); mode.append(guidedButton, jsonButton);
  const editor = el('textarea', { className: 'json-editor', rows: 22, spellcheck: false, 'aria-label': 'Advanced case input JSON', value: json(state.draft.input) });
  editor.addEventListener('input', () => { state.raw = editor.value; changed(); });
  advanced.append(el('p', { className: 'notice' }, 'This is the same case input. Raw text goes directly to the strict server parser before saving; duplicate keys and lossy numbers are rejected.'), editor,
    el('div', { className: 'actions' }, button('Format JSON', async () => { const raw = editor.value; const response = await api('/api/format', raw, { raw: true, contentType: 'application/json' }); if (editor.value !== raw) { toast('New edits retained. Format again when ready.'); return; } editor.value = response.formatted; state.raw = response.formatted; changed(); }), button('Save JSON', save, 'primary-button')));
  append(container, mode, form, advanced); renderInputsInto(form);
}
function renderInputsInto(form) {
  state.form?.destroy?.();
  form.replaceChildren(); state.formContainer = form;
  const c = state.detail.case;
  if (c.kind === 'policy') state.form = renderPolicy(form, { input: clone(state.draft.input), onChange: inputChanged, api, caseId: c.id, attachments: c.attachments || [], sourceNotes: clone(state.draft.sourceNotes || {}), onSourceNotes: notes => { state.draft.sourceNotes = clone(notes); changed(); }, onUpload: uploadAttachment, download });
  else state.form = renderInvestigation(form, { input: clone(state.draft.input), onChange: inputChanged, api, onFork: forkInvestigation });
}
async function forkInvestigation(input) {
  if (!await confirmAction('Start a fresh investigation?', 'Your original case and observations stay intact. The new case begins with zero observations and a new adequacy epoch.', 'Create fork')) return;
  await save(); const response = await api(`/api/cases/${state.detail.case.id}/fork`, { input, title: `${state.draft.title} — fresh epoch` }); await navigate(`#case/${response.case.id}`);
}
async function runCase() {
  if (state.running) { toast('A computation is already in progress.'); return; }
  if (!validForm()) throw new Error('Resolve the highlighted values before running.');
  await save(); if (state.running || !state.detail) return; const c = state.detail.case; state.running = true; clearError(); const generation = state.generation; status('Computing saved revision…');
  if (state.pendingRun?.caseId !== c.id || state.pendingRun?.revision !== c.revision) state.pendingRun = { caseId: c.id, revision: c.revision, key: crypto.randomUUID() };
  try { const response = await api(`/api/cases/${c.id}/run`, { expectedRevision: c.revision, idempotencyKey: state.pendingRun.key });
    state.pendingRun = null;
    if (state.detail?.case.id !== c.id) { toast('Computation saved in the original case.'); return; }
    if (state.generation !== generation || !validForm()) {
      const refreshed = await api(`/api/cases/${c.id}`); if (state.detail?.case.id !== c.id) return; state.detail = refreshed;
      status(state.dirty ? 'Changes retained · run records earlier inputs' : 'Run records earlier inputs');
      toast('Computation saved. Your later edits are retained; inspect its recorded revision in Results.');
    } else { state.selectedRun = response.run; state.tab = 'results'; await openCase(c.id); toast('Computation saved with its receipt.'); }
  } catch (error) { if (state.detail?.case.id === c.id) status('Run failed · prior results retained', true); else toast(`Computation failed in ${c.title}. No new verdict was recorded.`); throw error; }
  finally { state.running = false; }
}
function resultCard(label, value, note) { return el('div', { className: 'summary-card' }, el('span', { className: 'summary-card-label' }, label), el('div', { className: `summary-card-value${String(value).length > 18 ? ' long' : ''}` }, display(value)), note ? el('span', { className: 'help' }, note) : null); }
function renderResults(container, run) {
  if (!run) { append(container, el('div', { className: 'empty-state' }, el('span', { className: 'empty-symbol' }, '◈'), el('h3', {}, 'Make the reasoning visible.'), el('p', {}, 'Fill in your inputs and run the saved revision to create a result and its receipt.'), button('Set up inputs', () => { state.tab = 'inputs'; renderCase(); }, 'primary-button'))); return; }
  const c = state.detail.case; const result = run.result || run.receipt?.result || {}; const historic = run.revision !== c.revision || state.dirty;
  append(container, el('div', { className: historic ? 'notice' : 'current-notice' }, el('strong', { id: 'run-current' }, historic ? 'PREVIOUS REVISION' : 'CURRENT RESULT'), el('p', {}, `Run ${run.id} · case revision ${run.revision} · ${new Date(run.createdAt).toLocaleString()}`), historic ? el('p', {}, 'This receipt is immutable. It does not evaluate the current case inputs.') : null, el('p', {}, 'This is the recorded computation. Use Verify this receipt to replay it against the current engine and runtime.')));
  if (c.kind === 'policy') {
    const decision = result.verdict; append(container, el('div', { className: 'summary-cards' }, resultCard('Verdict', decision), resultCard('Requirements', result.trace?.length || 0), resultCard('Evaluation time', result.asOf, 'Exact recorded instant')),
      el('p', { className: 'result-explanation' }, { ALLOW: 'All declared requirements are satisfied by the supplied evidence at this time. No real-world action has been performed.', DENY: 'At least one declared requirement failed. Inspect its trace and evidence below.', DEFER: 'Required evidence is unavailable or unresolved. Supply the missing records and evaluate a new revision.', ERROR: 'The declared input contains errors. No approval can be drawn from this result.' }[decision] || 'Inspect the full engine result.'),
      table('Requirement trace', result.trace, ['ruleId', 'factId', 'result', 'code', 'actual', 'expected', 'reasons']), table('Evidence availability', result.evidence?.facts, ['id', 'status', 'reasons']), table('Dependency lineage', result.evidence?.lineage), table('Evidence issues and conflicts', result.evidence?.issues), table('Policy errors', result.errors));
  } else {
    const snapshot = result.snapshot || {}; const adequacy = result.adequacy || {}; const deferred = result.decisionStatus !== 'AVAILABLE';
    append(container, el('div', { className: deferred ? 'decision-notice' : 'current-notice' }, el('strong', {}, deferred ? 'DEFER — no action suggestion' : 'Conditional decision available'), el('p', {}, adequacy.status === 'NOT_REJECTED' ? 'NOT_REJECTED means insufficient evidence against the declared family. It does not approve the model or authorize an action.' : `${adequacy.status || 'NOT_EVALUATED'}: ${adequacy.reason || 'The supplied model does not support an integrated action suggestion.'}`)),
      el('div', { className: 'summary-cards' }, resultCard('Decision status', result.decisionStatus), resultCard('Budget spent / remaining', `${display(snapshot.spent)} / ${display(snapshot.remainingBudget)}`, 'Declared cost units'), resultCard('Adequacy', adequacy.status || 'NOT_EVALUATED')),
      el('p', { className: 'result-explanation' }, snapshot.modelMismatch ? 'The contradicted observation has no supported posterior update. These values retain the last supported state.' : 'Posterior weights are conditional on your finite declared family, priors, and likelihoods. A large weight does not establish truth or override DEFER.'));
    const beliefs = section(snapshot.modelMismatch ? 'Last supported posterior weights' : 'Conditional posterior weights', el('div', {}, Object.entries(snapshot.posterior || {}).map(([id, weight]) => el('div', { className: 'belief-row' }, el('div', { className: 'belief-line' }, el('span', {}, id), el('strong', { title: 'Exact binary64 posterior weight' }, String(weight))), el('progress', { max: 1, value: weight, 'aria-label': `${id} posterior weight` })))));
    const actionSuggestion = !deferred && result.action ? section('Expected-loss action suggestion', el('div', { className: 'form-stack' },
      el('div', { className: 'summary-cards' }, resultCard('Suggested action', result.action.actionId), resultCard('Expected loss', result.action.expectedLoss, 'Your declared loss units')),
      el('p', { className: 'help' }, 'A conditional suggestion within your supplied model and losses. No external action is performed.'),
      table('Evaluated alternatives', (result.action.alternatives || [result.action]).map(action => ({ actionId: action.actionId, expectedLoss: action.expectedLoss, suggested: action.actionId === result.action.actionId })), ['actionId', 'expectedLoss', 'suggested']))) : null;
    append(container, beliefs, table('Next experiment / stopping reason', result.recommendation ? [result.recommendation] : []), actionSuggestion,
      table('Adequacy checks', Object.entries(adequacy).map(([check, value]) => ({ check, value }))), table('Recorded observations', snapshot.receipts, ['sequence', 'id', 'experimentId', 'outcome', 'cost', 'status']), table('Assumptions', result.assumptions));
  }
  const digest = run.digest || run.receipt?.digest;
  append(container, section('The receipt', el('div', { className: 'form-stack' }, el('span', { className: 'eyebrow' }, 'RECEIPT DIGEST · SHA-256'), el('code', { className: 'digest' }, digest), el('div', { className: 'actions' }, button('Copy digest', () => copyDigest(digest)), download(`/api/runs/${run.id}/receipt`, 'Download exact receipt'), button('Verify this receipt', async () => { state.pendingReceipt = run.receiptText; await navigate('#receipts'); })), el('p', { className: 'help' }, 'Hash-bound computation, not a signature or proof of the underlying facts. Keep an independently trusted digest to anchor later checks.'))), details('Full engine result', result), details('Recorded run input', run.input || run.receipt?.input), details('Complete receipt', run.receiptText || run.receipt), noteComposer(run.id));
}
function noteComposer(runId) {
  const editor = textArea('', () => {}, { placeholder: 'Add context, corrections, or your interpretation. Notes do not change engine results.', rows: 3 });
  const list = el('div', { className: 'notes-list' });
  const render = () => list.replaceChildren(...(state.detail.notes || state.detail.case.notes || []).filter(note => !runId || note.runId === runId).map(note => el('article', { className: 'note' }, el('p', {}, note.text), el('span', { className: 'timestamp' }, new Date(note.createdAt).toLocaleString())))); render();
  return section(runId ? 'Notes on this run' : 'Case notes', el('div', { className: 'form-stack' }, list, field('Your note', editor), button('Add note', async () => { if (!editor.value.trim()) throw new Error('Enter a note.'); const response = await api(`/api/cases/${state.detail.case.id}/note`, { text: editor.value, ...(runId ? { runId } : {}) }); state.detail.notes ||= []; state.detail.notes.push(response.note); editor.value = ''; render(); toast('Note saved separately from the verdict.'); })));
}
function diff(left, right, path = '', rows = []) {
  if (json(left) === json(right)) return rows;
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) { for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) diff(left[key], right[key], path ? `${path}.${key}` : key, rows); }
  else rows.push({ field: path || 'input', before: display(left), after: display(right) }); return rows;
}
function renderHistory(container) {
  const history = state.detail.history || []; const runs = state.detail.runs || [];
  append(container, section('Immutable revisions', el('div', { className: 'history-list' }, [...history].reverse().map((snapshot, index) => {
    const previous = history.find(row => row.revision === snapshot.revision - 1);
    return el('details', { className: 'revision' }, el('summary', {}, `Revision ${snapshot.revision} · ${snapshot.title} · ${new Date(snapshot.updatedAt || snapshot.createdAt).toLocaleString()}`),
      previous ? table('Changes from previous revision', diff({ title: previous.title, question: previous.question, description: previous.description, tags: previous.tags, input: previous.input, sourceNotes: previous.sourceNotes }, { title: snapshot.title, question: snapshot.question, description: snapshot.description, tags: snapshot.tags, input: snapshot.input, sourceNotes: snapshot.sourceNotes })) : el('p', { className: 'help' }, 'Initial saved revision.'), details('Full saved input', snapshot.input));
  }))), section('Recorded runs', runs.length ? el('div', { className: 'history-list' }, [...runs].reverse().map(run => el('div', { className: 'run-row' }, badge(verdict(run), verdictClass(verdict(run))), el('div', {}, el('strong', {}, `Revision ${run.revision}`), el('p', { className: 'help' }, `${new Date(run.createdAt).toLocaleString()} · ${run.current ? 'Current input' : 'Historical input'}`)), button('Inspect', () => { state.selectedRun = run; state.tab = 'results'; renderCase(); }), download(`/api/runs/${run.id}/receipt`, 'Receipt')))) : el('p', { className: 'muted' }, 'No computations recorded yet.')), noteComposer());
}
async function saveTemplate() {
  await save(); const name = input(state.draft.title, () => {}); const description = textArea(state.draft.description, () => {});
  if (!await dialog('Create a reusable template', el('div', { className: 'form-stack' }, field('Name', name), field('Description', description), el('p', { className: 'help' }, 'This captures the saved input. It does not copy a result or receipt.')), [{ label: 'Cancel', value: false }, { label: 'Save template', value: true, className: 'primary-button' }])) return;
  await api('/api/templates', { name: name.value, description: description.value, caseId: state.detail.case.id }); toast('Template saved.');
}
async function renderTemplates(navigation = state.navigation) {
  const { templates } = await api('/api/templates');
  if (navigation !== state.navigation) return;
  $('view').replaceChildren(heading('Start from a useful structure', 'Templates create independent cases. Synthetic examples are labeled; your saved work can become a reusable template.'), el('div', { className: 'templates-grid' }, templates.map(template => el('article', { className: 'template-card' }, el('div', { className: 'card-top' }, badge(template.kind === 'policy' ? 'DECIDE' : 'INVESTIGATE'), badge(template.synthetic ? 'SYNTHETIC' : 'YOUR TEMPLATE', template.synthetic ? 'warning' : '')), el('h3', {}, template.name), el('p', { className: 'muted' }, template.description), el('span', { className: 'help' }, `Version ${template.version}`), el('div', { className: 'actions' }, button('Use template', () => createCase(template), 'primary-button')), details('Inspect declared input', template.input)))));
}
async function renderVerifier(initialRaw, navigation = state.navigation) {
  if (navigation !== state.navigation) return;
  const imported = el('textarea', { className: 'json-editor receipt-editor', rows: 14, spellcheck: false, 'aria-label': 'Raw receipt JSON', placeholder: 'Paste the complete raw receipt JSON', value: initialRaw || '' });
  const anchor = input('', () => {}, { placeholder: '64 hexadecimal characters', pattern: '[a-fA-F0-9]{64}', 'aria-label': 'Independently trusted digest' });
  const output = el('div', { className: 'verification-output' }, el('div', { className: 'empty-state' }, el('h3', {}, 'Check the record, then replay it.'), el('p', {}, 'Integrity, replay, and trusted anchoring are separate checks.')));
  const reset = () => { output.replaceChildren(el('p', { className: 'notice' }, 'Receipt or trusted digest changed. Verify again; the prior result no longer applies.')); };
  imported.addEventListener('input', reset); anchor.addEventListener('input', reset);
  const file = el('input', { type: 'file', accept: '.json', 'aria-label': 'Upload raw receipt', onchange: async event => {
    try { const f = event.target.files[0]; if (!f) return; if (f.size > 2000000) throw new Error('Receipt files are limited to 2,000,000 bytes.'); imported.value = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer()); reset(); } catch (error) { globalError(error); }
  } });
  const run = button('Verify & replay', async () => {
    clearError(); anchor.value = anchor.value.trim().toLowerCase(); if (anchor.value && !anchor.checkValidity()) { anchor.reportValidity(); throw new Error('A trusted digest must be exactly 64 hexadecimal characters.'); }
    const raw = imported.value; const expect = anchor.value.trim(); output.replaceChildren(el('p', { className: 'loading-message' }, 'Checking integrity and replaying…'));
    try { const response = await api(`/api/verify${expect ? `?expect=${encodeURIComponent(expect)}` : ''}`, raw, { raw: true, contentType: 'application/json' });
      if (imported.value !== raw || anchor.value.trim() !== expect) { reset(); return; }
      renderVerification(output, response.verification); await loadHistory();
    } catch (error) { if (imported.value === raw && anchor.value.trim() === expect) output.replaceChildren(renderError(error)); else reset(); }
  }, 'primary-button');
  const history = el('div', {});
  $('view').replaceChildren(heading('Verify a receipt', 'Raw receipt text reaches the strict verifier before any parsing or rewriting in this browser.'), el('div', { className: 'work-grid' }, section('Your receipt', el('div', { className: 'form-stack' }, field('Choose a receipt file', file), imported, field('Trusted digest — optional', anchor, 'Use a digest retained independently. Copying the digest from an untrusted receipt does not provide an independent anchor.'), run)), section('Verification result', output)), section('Previous verification attempts', history));
  async function loadHistory() { const response = await api('/api/verifications'); history.replaceChildren(...(response.records || []).map(record => el('details', { className: 'revision' }, el('summary', {}, `${new Date(record.createdAt).toLocaleString()} · HISTORICAL CHECK · ${record.verification?.valid ? 'CONSISTENT THEN' : 'REFUSED THEN'} · ${record.expected ? 'Trusted anchor was supplied' : 'Unanchored'}`), el('p', { className: 'help' }, 'These saved checks describe the runtime used at the recorded time. Imported or restored checks are historical evidence; they have not been rerun by opening this workspace.'), details('Recorded checks', record.verification || record)))); }
  await loadHistory();
}
function renderVerification(container, verification) {
  const checks = [ ['Receipt integrity', verification.integrity, 'Does the raw receipt satisfy its format and commitment?'], ['Computation replay', verification.replay, 'Does this exact engine and runtime reproduce the computation?'], ['Trusted digest', verification.anchoring, 'Does it match the independent digest you supplied?'] ];
  const anchored = verification.anchoring === 'MATCH';
  container.replaceChildren(badge(verification.valid ? anchored ? 'CHECKS PASSED' : 'UNANCHORED' : 'CHECKS FAILED', verification.valid && anchored ? 'ready' : verification.valid ? 'warning' : 'invalid'),
    el('div', { className: 'verification-checks' }, checks.map(([label, value, explanation]) => el('div', { className: 'check-row' }, el('div', {}, el('h3', {}, label), el('p', { className: 'help' }, explanation)), badge(value || 'NOT_CHECKED', verdictClass(value))))),
    verification.reason ? el('p', { className: 'result-explanation' }, verification.reason) : null,
    el('p', { className: 'notice' }, anchored ? 'The checks agree with your supplied anchor. This verifies the recorded computation; it does not prove the source facts or reviewer identity.' : 'No matching independently trusted digest was established. Consistency and replay do not establish authenticity.'), details('Full verification', verification));
}
async function renderSettings(navigation = state.navigation) {
  const settings = await api('/api/settings'); const restoreFile = el('input', { type: 'file', accept: '.commons-backup,.json', 'aria-label': 'Choose workspace backup' });
  if (navigation !== state.navigation) return;
  $('view').replaceChildren(heading('Your workspace', 'Local storage, immutable engines, and portable records.'),
    el('div', { className: 'summary-cards' }, resultCard('Application', settings.appVersion), resultCard('Engine release', settings.engine?.version, settings.engine?.intact ? 'Original engine files intact' : 'Engine integrity requires attention'), resultCard('Runtime', settings.runtime?.node, `${settings.runtime?.platform} / ${settings.runtime?.arch || settings.runtime?.architecture}`)),
    section('Storage & recovery', el('div', { className: 'form-stack' }, el('p', {}, 'Your cases, revisions, notes, receipts, and attachments persist in the workspace data directory.'), el('code', { className: 'digest' }, settings.dataDir), table('Workspace counts', Object.entries(settings.counts || {}).map(([record, value]) => ({ record, value }))), download('/api/backup', 'Download full workspace backup', 'primary-button'),
      el('hr'), field('Restore from a backup', restoreFile, 'Restore replaces the complete current workspace after validation. Download a current backup first. An invalid backup leaves the workspace unchanged.'), button('Validate and restore workspace', async () => {
        const file = restoreFile.files[0]; if (!file) throw new Error('Choose a workspace backup.');
        const word = input('', () => {}, { placeholder: 'Type RESTORE', autocomplete: 'off' });
        const approved = await dialog('Replace this workspace?', el('div', { className: 'form-stack' }, el('p', { className: 'notice' }, 'This replaces all current cases and records with the selected backup. Validation happens before the atomic restore. Download a backup of the current workspace before continuing.'), field('Confirmation', word)), [{ label: 'Cancel', value: false }, { label: 'Restore backup', value: true, className: 'danger-button' }]);
        if (!approved) return; if (word.value !== 'RESTORE') throw new Error('Restore was not performed. Type RESTORE exactly to confirm.');
        await api('/api/restore', await file.arrayBuffer(), { raw: true }); toast('Workspace restored after complete validation.'); await renderSettings();
      }, 'danger-button'))),
    section('About COMMONS', el('div', { className: 'form-stack' }, el('h3', {}, 'A deliberately focused gift of COSMIC.'), el('p', {}, 'Created by Leland “TJ” Jourdan II. Public COMMONS provides explicit evidence policies and finite-family investigations, with strict inputs and replayable receipts.'), el('p', {}, 'Copyright 2026 Leland Jourdan II / C&L Strategy. Distributed under Apache-2.0. Engine source and its notices are retained unchanged; the separate application supplies persistence, forms, and record management.'), el('div', { className: 'actions' }, el('a', { href: '/LICENSE', className: 'secondary-button' }, 'Apache-2.0 license'), el('a', { href: '/NOTICE', className: 'secondary-button' }, 'Attribution notice')), el('p', { className: 'help' }, 'This is a local single-operator application. It does not claim source facts are true, identify reviewers, approve a model, or perform an action.'))),
    details('Engine provenance and immutable identity', settings.engine), details('Operational limits', settings.limits));
}
document.querySelectorAll('.workspace-nav a, .brand, footer a').forEach(link => link.addEventListener('click', event => { event.preventDefault(); navigate(link.getAttribute('href')).catch(globalError); }));
window.addEventListener('hashchange', () => renderRoute().catch(globalError));
window.addEventListener('beforeunload', event => { if (state.dirty || !validForm()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('keydown', event => { if (state.detail && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); runCase().catch(globalError); } });
async function start() {
  try { await session(); connection(true); await renderRoute(); }
  catch (error) { connection(false); globalError(error); $('view').replaceChildren(el('div', { className: 'empty-state' }, el('h3', {}, 'Your local workspace is unavailable'), el('p', {}, 'Start the COMMONS service, then retry. Saved work remains in the data directory.'), button('Retry connection', start, 'primary-button'))); }
}
await start();
