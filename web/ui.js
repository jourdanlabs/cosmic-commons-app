// Copyright 2026 Leland Jourdan II / JourdanLabs
// SPDX-License-Identifier: Apache-2.0
// Application helpers. The immutable engine owns all input parsing and computation.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className' || key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'multiple' || key === 'readOnly') node[key] = !!value;
    else if (key === 'value') continue;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  // Select options must exist before assigning their selected value.
  if (Object.hasOwn(attrs || {}, 'value') && attrs.value !== undefined && attrs.value !== null) node.value = attrs.value;
  return node;
}
export function renderError(error) { return el('div', { className: 'error-banner', role: 'alert' }, error?.message || String(error)); }
export function field(label, control, help) {
  return el('label', { className: 'field' }, el('span', { className: 'field-label' }, label), control, help ? el('span', { className: 'help' }, help) : null);
}
export function button(label, fn, className = 'secondary-button') {
  let busy = false;
  return el('button', { type: 'button', className, onclick: async (event) => {
    const node = event.currentTarget;
    if (node.disabled || busy) return;
    busy = true; node.setAttribute('aria-busy', 'true'); node.classList.add('is-pending');
    node.parentNode?.querySelector(':scope > .action-error')?.remove();
    try { await fn(event); }
    catch (error) {
      const old = node.parentNode?.querySelector(':scope > .action-error'); old?.remove();
      const message = renderError(error); message.classList.add('action-error'); node.parentNode?.append(message);
    } finally { busy = false; if (node.isConnected) { node.removeAttribute('aria-busy'); node.classList.remove('is-pending'); } }
  } }, label);
}
export function input(value, fn, attrs = {}) {
  return el('input', { type: 'text', ...attrs, value: value ?? '', onchange: async (event) => {
    try { await fn(event.currentTarget.value); event.target.removeAttribute('aria-invalid'); }
    catch (error) { event.target.setAttribute('aria-invalid', 'true'); event.target.parentNode?.append(renderError(error)); }
  } });
}
export function textArea(value, fn, attrs = {}) {
  return el('textarea', { rows: 3, ...attrs, value: value ?? '', onchange: async (event) => {
    try { await fn(event.currentTarget.value); event.target.removeAttribute('aria-invalid'); }
    catch (error) { event.target.setAttribute('aria-invalid', 'true'); event.target.parentNode?.append(renderError(error)); }
  } });
}
export function select(value, choices, fn) {
  return el('select', { value, onchange: async (event) => { try { await fn(event.target.value); } catch (error) { event.target.parentNode?.append(renderError(error)); } } },
    choices.map(choice => { const item = typeof choice === 'string' ? { value: choice, label: choice } : choice;
      return el('option', { value: item.value, selected: item.value === value }, item.label); }));
}
export function numericInput(value, callback, api, attrs = {}) {
  const control = el('input', { type: 'text', inputmode: 'decimal', ...attrs, value: value ?? '' });
  const wrapper = el('span', { className: 'typed-control' }, control);
  let version = 0;
  control.addEventListener('input', () => { version++; control.removeAttribute('aria-busy'); control.setCustomValidity('Leave this field to validate the new number.'); control.setAttribute('aria-invalid', 'true'); });
  control.addEventListener('change', async () => {
    wrapper.querySelector('.error-banner')?.remove();
    const submitted = control.value; const request = ++version;
    control.setCustomValidity('The server is checking this number.'); control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-busy', 'true');
    try {
      const response = await api('/api/value', { type: 'number', text: submitted });
      if (!control.isConnected || version !== request || control.value !== submitted) return;
      control.setCustomValidity(''); await callback(response.value); if (version === request) control.removeAttribute('aria-invalid');
    } catch (error) { if (control.isConnected && version === request && control.value === submitted) { control.setCustomValidity(error.message); control.setAttribute('aria-invalid', 'true'); wrapper.append(renderError(error)); } }
    finally { if (version === request) control.removeAttribute('aria-busy'); }
  });
  return wrapper;
}
export function valueEditor(value, callback, api) {
  const type = value === null ? 'null' : ['number', 'boolean', 'string'].includes(typeof value) ? typeof value : 'json';
  let currentType = type;
  let version = 0;
  const editor = el('textarea', { rows: type === 'json' ? 3 : 1, 'aria-label': 'Typed value', value: type === 'string' ? value : JSON.stringify(value) });
  const wrapper = el('div', { className: 'value-editor' });
  const validateValue = async () => {
    wrapper.querySelector('.error-banner')?.remove(); const raw = editor.value; const submittedType = currentType; const request = ++version;
    editor.setCustomValidity('The server is checking this typed value.'); editor.setAttribute('aria-invalid', 'true'); editor.setAttribute('aria-busy', 'true');
    try {
      const response = await api('/api/value', { type: submittedType, text: raw });
      if (!editor.isConnected || version !== request || editor.value !== raw || currentType !== submittedType) return;
      editor.setCustomValidity(''); await callback(response.value); if (version === request) editor.removeAttribute('aria-invalid');
    } catch (error) { if (editor.isConnected && version === request && editor.value === raw && currentType === submittedType) { editor.setCustomValidity(error.message); editor.setAttribute('aria-invalid', 'true'); wrapper.append(renderError(error)); } }
    finally { if (version === request) editor.removeAttribute('aria-busy'); }
  };
  const kinds = select(type, ['string', 'number', 'boolean', 'null', 'json'], async value => { currentType = value; editor.rows = value === 'json' ? 3 : 1; await validateValue(); });
  kinds.setAttribute('aria-label', 'Value type');
  editor.addEventListener('input', () => { version++; editor.removeAttribute('aria-busy'); editor.setCustomValidity('Leave this field to validate the new typed value.'); editor.setAttribute('aria-invalid', 'true'); });
  editor.addEventListener('change', validateValue);
  wrapper.append(kinds, editor, el('span', { className: 'help' }, 'Choose a type, enter its value, then leave the field to validate. JSON arrays and objects use JSON type.'));
  return wrapper;
}
