// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
// Application forms only. All verdicts and evidence inspection remain in the frozen engine.
import { el, field, button } from './ui.js';

const OPERATORS = [
  { value: 'exists', label: 'exists · available evidence is present' },
  { value: 'eq', label: 'eq · equals exactly' },
  { value: 'ne', label: 'ne · differs exactly' },
  { value: 'gt', label: 'gt · greater than' },
  { value: 'gte', label: 'gte · at least' },
  { value: 'lt', label: 'lt · less than' },
  { value: 'lte', label: 'lte · at most' },
  { value: 'in', label: 'in · one of the declared values' },
];
const ORDERED = new Set(['gt', 'gte', 'lt', 'lte']);
const copy = (value) => structuredClone(value);
const display = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const typeOf = (value) => value === null ? 'null' : typeof value === 'object' ? 'json' : typeof value;

function identifier(value, name) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256) {
    throw new Error(`${name} needs 1–256 characters, with no surrounding spaces.`);
  }
}

function instant(value, name, optional = false) {
  if (optional && !value) return;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(`${name} must be UTC: YYYY-MM-DDTHH:mm:ssZ, optionally with .sss milliseconds.`);
  }
  const parsed = Date.parse(value);
  const expanded = value.length === 20 ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== expanded) {
    throw new Error(`${name} is not a valid calendar instant.`);
  }
}

/** Guided policy inputs. The caller saves snapshots; this module never computes a verdict. */
export function renderPolicy(container, options) {
  const { onChange, api, onSourceNotes, onUpload, download } = options;
  const model = copy(options.input);
  // Source IDs are arbitrary strings, including JSON keys such as __proto__.
  // A null-prototype map keeps those IDs as data rather than object setters.
  let notes = Object.assign(Object.create(null), copy(options.sourceNotes || {}));
  let active = true;
  const invalidControls = new Set();
  const sourcePickers = new Set();
  const factPickers = new Set();
  const statusRefreshers = new Set();
  const namespace = `policy-${crypto.randomUUID()}`;
  const sourceListId = `${namespace}-sources`;
  const factListId = `${namespace}-facts`;
  const sourceList = el('datalist', { id: sourceListId });
  const factList = el('datalist', { id: factListId });
  const overallError = el('div', { role: 'alert', className: 'help' });
  const sourcesArea = el('div', { className: 'record-list' });
  const factsArea = el('div', { className: 'record-list' });
  const rulesArea = el('div', { className: 'record-list' });

  function mark(control, message = '') {
    control.setCustomValidity(message);
    control.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) invalidControls.add(control); else invalidControls.delete(control);
    syncInvalid();
  }
  function syncInvalid() {
    for (const control of invalidControls) if (!container.contains(control)) invalidControls.delete(control);
    container.dataset.invalid = invalidControls.size ? 'true' : 'false';
  }
  function emit() {
    if (!active || !container.isConnected) return;
    refreshReferences();
    onChange(copy(model));
  }
  function emitNotes() {
    if (active && container.isConnected && onSourceNotes) onSourceNotes(copy(notes));
  }
  function nextId(prefix, rows) {
    let index = rows.length + 1;
    while (rows.some((item) => item.id === `${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
  }
  function refreshReferences() {
    sourceList.replaceChildren(...model.evidence.sources.map((source) => el('option', { value: source.id })));
    factList.replaceChildren(...model.evidence.facts.map((fact) => el('option', { value: fact.id })));
    for (const updater of statusRefreshers) {
      if (updater.node && !container.contains(updater.node)) statusRefreshers.delete(updater);
      else updater();
    }
    for (const picker of [...sourcePickers, ...factPickers]) if (!container.contains(picker)) {
      sourcePickers.delete(picker); factPickers.delete(picker);
    }
  }
  function message(error) {
    overallError.className = 'error-banner';
    overallError.textContent = error instanceof Error ? error.message : String(error);
  }
  function safely(fn) {
    return async () => {
      overallError.textContent = ''; overallError.className = 'help';
      try { await fn(); } catch (error) { message(error); }
    };
  }
  function requireCheckedDraft(ignore = null) {
    syncInvalid();
    const pending = [...container.querySelectorAll('input:invalid, textarea:invalid, select:invalid')]
      .find((control) => !ignore?.contains(control));
    if (pending) {
      pending.focus(); pending.reportValidity();
      throw new Error('Finish checking or correcting the edited field before changing this list. Your entered draft has been retained.');
    }
  }
  function removeRecord(rows, item, redraw) {
    const card = [...container.querySelectorAll('.record-card')].find((node) => node.dataset.recordKey === item.id && node.dataset.recordKind ===
      (rows === model.evidence.sources ? 'source' : rows === model.evidence.facts ? 'fact' : 'rule'));
    requireCheckedDraft(card);
    const index = rows.indexOf(item);
    if (index >= 0) rows.splice(index, 1);
    redraw(); emit(); syncInvalid();
  }

  // Keep invalid text in the control and the prior typed value in the draft.
  // The shell must validate() before Run so it cannot compute from a hidden old value.
  function textField(label, value, callback, settings = {}) {
    // Native text inputs strip CR/LF. An imported multiline string needs a
    // textarea to display and edit its exact value, even for an ID or locator.
    const multilineValue = typeof value === 'string' && /[\r\n]/.test(value);
    const multiline = settings.multiline || multilineValue;
    const control = el(multiline ? 'textarea' : 'input', {
      ...(multiline ? { rows: settings.rows || 3 } : { type: 'text' }),
      value: value ?? '', autocomplete: 'off',
      ...(settings.list ? { list: settings.list } : {}),
      ...(settings.placeholder ? { placeholder: settings.placeholder } : {}),
      ...(settings.required ? { required: true } : {}),
      ...(settings.maxlength ? { maxlength: settings.maxlength } : {}),
    });
    const error = el('span', { className: 'help field-error', role: 'status' });
    control.addEventListener('input', () => {
      // A control that was invalid stays invalid until its replacement is checked.
      if (invalidControls.has(control)) error.textContent = 'Edit retained; finish this field to validate it.';
    });
    control.addEventListener('change', () => {
      try {
        if (settings.validate) settings.validate(control.value);
        callback(control.value);
        mark(control); error.textContent = '';
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        mark(control, msg); error.textContent = msg;
      }
    });
    const wrapper = field(label, el('div', {}, control, error), settings.help);
    return { wrapper, control, error };
  }

  function choiceField(label, value, choices, callback, help) {
    const select = el('select', {}, choices.map((item) => {
      const option = typeof item === 'string' ? { value: item, label: item } : item;
      return el('option', { value: option.value, selected: value === option.value }, option.label);
    }));
    select.value = value;
    select.addEventListener('change', () => callback(select.value));
    return { wrapper: field(label, select, help), control: select };
  }

  function typedField(label, value, callback, settings = {}) {
    let current = copy(value);
    let currentType = settings.onlyType || typeOf(current);
    let request = 0;
    const raw = el('textarea', { rows: currentType === 'json' ? 4 : 2, value: display(current) ?? '' });
    const error = el('span', { className: 'help field-error', role: 'status' });
    const typeChoices = settings.onlyType ? [settings.onlyType] : [
      { value: 'string', label: 'String · entered text' },
      { value: 'number', label: 'Number · numeric value' },
      { value: 'boolean', label: 'Boolean · true or false' },
      { value: 'null', label: 'Null · explicit empty value' },
      { value: 'json', label: 'JSON · structured value' },
    ];
    const type = choiceField('Value type', currentType, typeChoices, async (selected) => {
      currentType = selected;
      raw.rows = selected === 'json' ? 4 : 2;
      raw.value = selected === 'string' ? '' : selected === 'number' ? '0' : selected === 'boolean' ? 'false'
        : selected === 'null' ? 'null' : settings.nonemptyArray ? '[""]' : '{}';
      raw.focus();
      await applyValue();
    });
    async function applyValue() {
      const version = ++request;
      mark(raw, 'This typed value is being checked.'); error.textContent = 'Checking value…';
      try {
        const { value: parsed } = await api('/api/value', { type: currentType, text: raw.value });
        if (!active || version !== request || !raw.isConnected || !container.contains(raw)) return;
        if (settings.onlyType === 'number' && typeof parsed !== 'number') throw new Error('This comparison requires a numeric threshold.');
        if (settings.nonemptyArray && (!Array.isArray(parsed) || !parsed.length)) throw new Error('One-of comparison needs a nonempty JSON array, for example ["approved", "waived"].');
        current = copy(parsed); callback(copy(current)); mark(raw); error.textContent = '';
      } catch (cause) {
        if (!active || version !== request || !raw.isConnected || !container.contains(raw)) return;
        const msg = cause instanceof Error ? cause.message : String(cause);
        mark(raw, msg); error.textContent = msg;
      }
    }
    raw.addEventListener('input', () => {
      request += 1;
      mark(raw, 'Finish editing this value so the server can validate it.');
      error.textContent = 'Draft value; finish editing to check its exact JSON type.';
    });
    raw.addEventListener('change', applyValue);
    return el('div', { className: 'typed-value' }, type.wrapper,
      field(label, el('div', {}, raw, error), settings.help ||
        'JSON types stay distinct: the string "true" is different from boolean true; "2" is different from number 2. Numbers and JSON are checked on the server before saving.'));
  }

  function uniqueId(rows, item, value, label) {
    identifier(value, label);
    if (rows.some((row) => row !== item && row.id === value)) throw new Error(`Another ${label.toLowerCase()} already uses “${value}”.`);
  }
  function idField(label, item, rows, callback) {
    return textField(label, item.id, (value) => {
      const previous = item.id; item.id = value;
      if (callback) callback(previous, value);
      emit();
    }, { validate: (value) => uniqueId(rows, item, value, label), required: true, maxlength: 256,
      help: 'Use a stable unique ID. Renaming it leaves other records’ references unchanged so you can review those links explicitly.' });
  }
  function optionalField(label, item, key, settings = {}) {
    return textField(label, item[key] || '', (value) => {
      if (value) item[key] = value; else delete item[key]; emit();
    }, settings);
  }
  function sourceNoteFields(source) {
    const update = (key, value) => {
      notes[source.id] = { ...(notes[source.id] || {}), humanAssertion: true };
      if (value) notes[source.id][key] = value; else delete notes[source.id][key];
      emitNotes();
    };
    const note = notes[source.id] || {};
    return el('details', {}, el('summary', {}, 'Extraction notes · human assertions'),
      el('p', { className: 'help' }, 'Link your manually entered facts to a passage or location. These notes stay with the case; they are not additional engine fields or independent proof.'),
      textField('Locator', note.locator || '', (value) => update('locator', value), { help: 'For example: page 4, cell D12, or section 2.3.' }).wrapper,
      textField('Source excerpt', note.excerpt || '', (value) => update('excerpt', value), { multiline: true }).wrapper,
      textField('Human assertion notes', note.assertionNotes || '', (value) => update('assertionNotes', value), { multiline: true,
        help: 'Who read the source and how the claimed fact was extracted. COMMONS does not automatically read or authenticate attachments.' }).wrapper);
  }

  function drawSources() {
    sourcesArea.replaceChildren();
    if (!model.evidence.sources.length) sourcesArea.append(el('p', { className: 'muted' }, 'No source records yet. Add a record or upload the file you will cite.'));
    for (const source of model.evidence.sources) {
      const card = el('article', { className: 'record-card', dataset: { recordKey: source.id, recordKind: 'source' } });
      const heading = el('h3', {}, source.id);
      const sourceBody = el('div', {});
      const file = (options.attachments || []).find((attachment) =>
        attachment.sourceId === source.id || source.content && typeof source.content === 'object' &&
        [source.content.attachmentId, source.content.fileId, source.content.appFileId].includes(attachment.id));
      let sourceType = file ? 'file' : Object.hasOwn(source, 'content') ? typeof source.content === 'string' ? 'text' : 'json' : 'reference';
      const choices = file ? [{ value: 'file', label: 'Uploaded file projection' }] :
        [{ value: 'text', label: 'Entered text' }, { value: 'json', label: 'Structured JSON' }, { value: 'reference', label: 'Reference only' }];
      const sourceChoice = choiceField('Source record type', sourceType, choices, (value) => {
        sourceType = value;
        if (value === 'reference') { delete source.content; delete source.digest; }
        else if (value === 'text') { source.content = ''; delete source.digest; }
        else if (value === 'json') { source.content = {}; delete source.digest; }
        else if (file) {
          const original = options.input.evidence.sources.find((item) => item.id === source.id);
          if (original) { source.content = copy(original.content); if (original.digest) source.digest = original.digest; }
        }
        drawSourceBody(); emit(); syncInvalid();
      }, 'Reference-only records are not fetched. A source commitment binds supplied content, not whether it is true.');
      const sourceId = idField('Source ID', source, model.evidence.sources, (previous, value) => {
        heading.textContent = value;
        card.dataset.recordKey = value;
        if (Object.hasOwn(notes, previous)) { notes[value] = notes[previous]; delete notes[previous]; emitNotes(); }
      });
      if (file) { sourceId.control.readOnly = true; sourceChoice.control.disabled = true; }
      function drawSourceBody() {
        sourceBody.replaceChildren();
        if (sourceType === 'text') sourceBody.append(textField('Source text', typeof source.content === 'string' ? source.content : '', (value) => {
          source.content = value; emit();
        }, { multiline: true, rows: 4 }).wrapper);
        else if (sourceType === 'json') sourceBody.append(typedField('Source JSON', source.content ?? {}, (value) => {
          source.content = value; emit();
        }, { onlyType: 'json', help: 'Enter raw JSON. Duplicate keys, unsafe integers, and unsupported precision are rejected before any browser JSON parsing.' }));
        else if (sourceType === 'file') {
          sourceBody.append(el('p', { className: 'help' }, 'This JSON projection identifies an uploaded file. Its byte hash commits the original file; the engine commits this projection separately.'),
            el('pre', { className: 'json-preview' }, JSON.stringify(source.content, null, 2)));
          if (file) {
            const path = `/api/attachments/${encodeURIComponent(file.id)}`;
            const label = `Download ${file.name || 'original file'}`;
            sourceBody.append(download ? download(path, label) : el('a', { href: path, className: 'secondary-button', download: '' }, label));
          }
        } else sourceBody.append(el('p', { className: 'help' }, 'This record points to a reference. The app does not retrieve the URI or claim its content was inspected.'));
        const digest = optionalField('Trusted canonical source digest (optional)', source, 'digest', {
          validate: (value) => { if (value && !/^[0-9a-f]{64}$/.test(value)) throw new Error('Use exactly 64 lowercase hexadecimal characters.'); },
          help: file ? 'Computed by the engine over this exact file projection. Upload a new file to create a new record; the original projection stays unchanged.'
            : 'Use the engine’s canonical-JSON source digest from a trusted record. A raw file SHA-256 is different and must not be pasted here.' });
        if (file) digest.control.readOnly = true;
        sourceBody.append(optionalField('Reference URI (optional)', source, 'uri', {
          validate: (value) => { if (value && !value.trim()) throw new Error('Reference URI cannot contain only spaces.'); },
          help: 'For your records only; COMMONS never fetches this address.' }).wrapper,
        digest.wrapper);
      }
      drawSourceBody();
      card.append(el('div', { className: 'form-row' }, heading,
        button('Remove source', safely(() => {
          requireCheckedDraft(card);
          delete notes[source.id]; emitNotes(); removeRecord(model.evidence.sources, source, drawSources);
        }), 'danger-button')), sourceId.wrapper, sourceChoice.wrapper, sourceBody, sourceNoteFields(source));
      sourcesArea.append(card);
    }
    syncInvalid();
  }

  function factReference(label, value, callback, source = false, help) {
    const reference = textField(label, value, callback, { list: source ? sourceListId : factListId,
      required: true, maxlength: 256, validate: (text) => identifier(text, label), help });
    (source ? sourcePickers : factPickers).add(reference.control);
    return reference;
  }
  function drawFacts() {
    factsArea.replaceChildren();
    if (!model.evidence.facts.length) factsArea.append(el('p', { className: 'muted' }, 'No facts yet. Enter typed assertions and link each one to a source record.'));
    for (const fact of model.evidence.facts) {
      const heading = el('h3', {}, fact.id);
      const linkage = el('p', { className: 'help' });
      const updateStatus = () => {
        if (!container.contains(linkage)) return;
        const present = model.evidence.sources.some((source) => source.id === fact.sourceId);
        linkage.textContent = present ? `Source: ${fact.sourceId} · manually entered assertion`
          : `Missing source “${fact.sourceId}”. Its unavailability will be inspected by the engine.`;
        linkage.className = present ? 'help' : 'help warning-text';
      };
      updateStatus.node = linkage;
      statusRefreshers.add(updateStatus);
      const dependencies = el('div', { className: 'dependency-list' });
      const dependencyInput = el('input', { type: 'text', list: factListId, autocomplete: 'off', placeholder: 'Fact ID, including a missing one' });
      const dependencyError = el('span', { className: 'help field-error', role: 'status' });
      function drawDependencies() {
        dependencies.replaceChildren();
        for (const id of fact.dependsOn || []) {
          dependencies.append(el('div', { className: 'form-row' }, el('code', {}, id),
            button(`Remove ${id}`, safely(() => {
              fact.dependsOn = fact.dependsOn.filter((entry) => entry !== id);
              if (!fact.dependsOn.length) delete fact.dependsOn;
              drawDependencies(); emit();
            }), 'text-button')));
        }
      }
      const addDependency = button('Add dependency', async () => {
        try {
          identifier(dependencyInput.value, 'Dependency fact ID');
          if ((fact.dependsOn || []).includes(dependencyInput.value)) throw new Error('This dependency is already listed.');
          fact.dependsOn = [...(fact.dependsOn || []), dependencyInput.value];
          dependencyInput.value = ''; dependencyError.textContent = ''; mark(dependencyInput);
          drawDependencies(); emit();
        } catch (cause) {
          dependencyError.textContent = cause instanceof Error ? cause.message : String(cause);
          mark(dependencyInput, dependencyError.textContent);
        }
      });
      dependencyInput.addEventListener('input', () => {
        // An unsubmitted dependency is a new-row draft, not part of this fact.
        mark(dependencyInput); dependencyError.textContent = '';
      });
      drawDependencies();
      const observed = optionalField('Observed at (UTC, optional)', fact, 'observedAt', {
        placeholder: '2026-10-08T04:00:00Z', validate: (value) => instant(value, 'Observed at', true),
        help: 'Future observations are unavailable at an earlier evaluation instant.' });
      const expires = optionalField('Expires at (UTC, optional)', fact, 'expiresAt', {
        placeholder: '2026-10-09T04:00:00Z', validate: (value) => instant(value, 'Expires at', true),
        help: 'At or after this instant the fact is expired. Expiry must follow the observed time.' });
      const card = el('article', { className: 'record-card', dataset: { recordKey: fact.id, recordKind: 'fact' } },
        el('div', { className: 'form-row' }, heading,
          button('Remove fact', safely(() => removeRecord(model.evidence.facts, fact, drawFacts)), 'danger-button')),
        el('div', { className: 'form-grid' }, idField('Fact ID', fact, model.evidence.facts, (_previous, value) => { heading.textContent = value; card.dataset.recordKey = value; }).wrapper,
          factReference('Source ID', fact.sourceId, (value) => { fact.sourceId = value; emit(); }, true,
            'Choose an existing source ID or explicitly enter a missing reference.').wrapper),
        linkage, typedField('Fact value', fact.value, (value) => { fact.value = value; emit(); }),
        el('div', { className: 'form-grid' },
          optionalField('Claim ID (optional)', fact, 'claimId', { validate: (value) => { if (value) identifier(value, 'Claim ID'); },
            help: 'Use the same claim ID for independent records asserting the same thing. Conflicting values or units stay visible to the engine.' }).wrapper,
          optionalField('Unit (optional)', fact, 'unit', { validate: (value) => { if (value) identifier(value, 'Unit'); }, help: 'For example USD, hours, or count. No implicit unit conversion.' }).wrapper,
          observed.wrapper, expires.wrapper),
        el('details', {}, el('summary', {}, 'Dependencies'),
          el('p', { className: 'help' }, 'This fact depends on each listed fact being available. Missing references and cycles are evaluated by the engine; they are not silently repaired.'),
          dependencies, field('Dependency fact ID', el('div', {}, dependencyInput, dependencyError)), addDependency));
      factsArea.append(card);
    }
    syncInvalid();
  }

  function drawRules() {
    rulesArea.replaceChildren();
    if (!model.policy.rules.length) rulesArea.append(el('p', { className: 'muted' }, 'Add at least one requirement. Every listed requirement must pass.'));
    for (const rule of model.policy.rules) {
      const heading = el('h3', {}, rule.id);
      const linkage = el('p', { className: 'help' });
      const expected = el('div', {});
      const updateStatus = () => {
        if (!container.contains(linkage)) return;
        const present = model.evidence.facts.some((fact) => fact.id === rule.factId);
        linkage.textContent = present ? `Requirement uses fact “${rule.factId}”.`
          : `Required fact “${rule.factId}” is missing. Keep the requirement; missing evidence is not a passing value.`;
        linkage.className = present ? 'help' : 'help warning-text';
      };
      updateStatus.node = linkage;
      statusRefreshers.add(updateStatus);
      function drawExpected() {
        expected.replaceChildren();
        if (rule.op === 'exists') {
          expected.append(el('p', { className: 'help' }, 'exists checks whether evidence is AVAILABLE, not whether its value is true. Boolean false and null can both satisfy exists.'));
          return;
        }
        expected.append(typedField(rule.op === 'in' ? 'Allowed values (JSON array)' : ORDERED.has(rule.op) ? 'Numeric threshold' : 'Expected value',
          rule.value, (value) => { rule.value = value; emit(); }, {
            ...(ORDERED.has(rule.op) ? { onlyType: 'number' } : rule.op === 'in' ? { onlyType: 'json', nonemptyArray: true } : {}),
            help: rule.op === 'in' ? 'Enter a nonempty JSON array such as ["approved", "waived"]. Each member is compared with its exact JSON type.'
              : ORDERED.has(rule.op) ? 'Both the fact and threshold must be numbers. Numeric strings are not converted.'
                : 'Exact JSON equality: strings, numbers, booleans, null, arrays, and objects retain their types.',
          }));
      }
      const operator = choiceField('Requirement operator', rule.op, OPERATORS, (value) => {
        rule.op = value;
        if (value === 'exists') delete rule.value;
        else if (ORDERED.has(value)) { if (typeof rule.value !== 'number') rule.value = 0; }
        else if (value === 'in') { if (!Array.isArray(rule.value) || !rule.value.length) rule.value = ['']; }
        else if (!Object.hasOwn(rule, 'value')) rule.value = true;
        drawExpected(); emit(); syncInvalid();
      });
      drawExpected();
      const card = el('article', { className: 'record-card', dataset: { recordKey: rule.id, recordKind: 'rule' } },
        el('div', { className: 'form-row' }, heading,
          button('Remove requirement', safely(() => removeRecord(model.policy.rules, rule, drawRules)), 'danger-button')),
        el('div', { className: 'form-grid' }, idField('Requirement ID', rule, model.policy.rules, (_previous, value) => { heading.textContent = value; card.dataset.recordKey = value; }).wrapper,
          factReference('Required fact ID', rule.factId, (value) => { rule.factId = value; emit(); }, false,
            'Choose a recorded fact or enter the exact ID of evidence still required.').wrapper),
        linkage, operator.wrapper, expected);
      rulesArea.append(card);
    }
    syncInvalid();
  }

  const asOf = textField('Evaluate as of (UTC)', model.asOf, (value) => { model.asOf = value; emit(); }, {
    required: true, validate: (value) => instant(value, 'Evaluation time'),
    help: 'This exact instant is saved and replayed. A run does not silently replace it with today’s time.' });
  const captureTime = button('Use current time', safely(() => {
    model.asOf = new Date().toISOString(); asOf.control.value = model.asOf; mark(asOf.control); asOf.error.textContent = ''; emit();
  }));
  const uploadInput = el('input', { type: 'file' });
  const uploadStatus = el('p', { role: 'status', className: 'help' });
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    uploadInput.disabled = true; uploadStatus.textContent = `Saving ${file.name}…`;
    try {
      if (!onUpload) throw new Error('File upload is unavailable in this view.');
      await onUpload(file);
      uploadStatus.textContent = 'File saved. A separate byte hash identifies the original file.';
      uploadInput.value = '';
    } catch (cause) {
      uploadStatus.textContent = cause instanceof Error ? cause.message : String(cause);
      uploadStatus.className = 'error-banner';
    } finally { uploadInput.disabled = false; }
  });
  const upload = field('Upload supporting file', el('div', {}, uploadInput, uploadStatus),
    'Original bytes stay local. Files are not executed, rendered inline, or automatically interpreted. Enter your facts manually and cite a locator/excerpt. Maximum file size: 10 MiB.');
  const addSource = button('Add source record', safely(() => {
    requireCheckedDraft();
    if (model.evidence.sources.length >= 1000) throw new Error('The engine supports at most 1,000 source records.');
    model.evidence.sources.push({ id: nextId('source', model.evidence.sources), content: '' }); drawSources(); emit();
  }));
  const addFact = button('Add fact', safely(() => {
    requireCheckedDraft();
    if (model.evidence.facts.length >= 1000) throw new Error('The engine supports at most 1,000 facts.');
    const sourceId = model.evidence.sources[0]?.id || 'source-required';
    model.evidence.facts.push({ id: nextId('fact', model.evidence.facts), sourceId, value: '' });
    notes[sourceId] = { ...(notes[sourceId] || {}), humanAssertion: true }; emitNotes();
    drawFacts(); emit();
  }));
  const addRule = button('Add requirement', safely(() => {
    requireCheckedDraft();
    if (model.policy.rules.length >= 1000) throw new Error('The engine supports at most 1,000 requirements.');
    model.policy.rules.push({ id: nextId('requirement', model.policy.rules), factId: model.evidence.facts[0]?.id || 'fact-required', op: 'exists' });
    drawRules(); emit();
  }));
  container.replaceChildren(overallError, sourceList, factList,
    el('section', { className: 'form-section' }, el('h2', {}, 'Decision policy'),
      el('p', { className: 'help' }, 'Describe the evidence and requirements explicitly. ALLOW means this policy’s requirements were satisfied by available evidence at the saved instant; it performs no real-world action.'),
      el('div', { className: 'form-grid' },
        textField('Policy ID', model.policy.id, (value) => { model.policy.id = value; emit(); }, { required: true, maxlength: 256, validate: (value) => identifier(value, 'Policy ID') }).wrapper,
        textField('Policy version', model.policy.version, (value) => { model.policy.version = value; emit(); }, { required: true, maxlength: 256, validate: (value) => identifier(value, 'Policy version'),
          help: 'An explicit policy label; saved case revisions preserve changes independently.' }).wrapper),
      asOf.wrapper, captureTime),
    el('section', { className: 'form-section' }, el('h2', {}, '1. Source records'),
      el('p', { className: 'help' }, 'Keep sources separate from the assertions you draw from them. Hashes bind supplied content; they do not authenticate its author or establish its truth.'), sourcesArea, addSource, upload),
    el('section', { className: 'form-section' }, el('h2', {}, '2. Typed facts'),
      el('p', { className: 'help' }, 'Keep independent conflicting records instead of quietly selecting one. Facts sharing a claim ID all reach the engine.'), factsArea, addFact),
    el('section', { className: 'form-section' }, el('h2', {}, '3. Requirements'),
      el('p', { className: 'help' }, 'All requirements are conjunctive. ERROR takes precedence over DENY, then DEFER, then ALLOW. A failed requirement can deny even when another fact is missing.'), rulesArea, addRule));
  drawSources(); drawFacts(); drawRules(); refreshReferences();
  return {
    getInput: () => copy(model),
    validate() {
      syncInvalid();
      const invalid = container.querySelector('input:invalid, textarea:invalid, select:invalid');
      if (invalid) { invalid.reportValidity(); invalid.focus(); return false; }
      return !invalidControls.size;
    },
    destroy() { active = false; invalidControls.clear(); statusRefreshers.clear(); },
  };
}
