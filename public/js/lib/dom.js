/**
 * Tiny DOM layer: an escaping template tag plus event delegation.
 * Interpolated values are escaped by default, so team names and other
 * user-supplied text can never inject markup.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Mark a string as already-safe HTML. */
export const raw = (value) => ({ __raw: true, value: value ?? '' });

function interpolate(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value && value.__raw) return value.value;
  return esc(value);
}

export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += interpolate(values[i]);
  }
  return out;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function mount(target, markup) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = markup;
  return node;
}

/**
 * Delegated listener. `handlers` maps a data-act value to a callback that
 * receives (element, event) -- so re-rendering never orphans a binding.
 */
export function delegate(root, handlers, { event = 'click', attribute = 'data-act' } = {}) {
  const node = typeof root === 'string' ? $(root) : root;
  if (!node) return () => {};
  const listener = (e) => {
    const el = e.target.closest(`[${attribute}]`);
    if (!el || !node.contains(el)) return;
    const handler = handlers[el.getAttribute(attribute)];
    if (!handler) return;
    if (event === 'click') e.preventDefault();
    handler(el, e);
  };
  node.addEventListener(event, listener);
  return () => node.removeEventListener(event, listener);
}

/** Collect a form's fields into a plain object, unchecked boxes included. */
export function formData(form) {
  const node = typeof form === 'string' ? $(form) : form;
  const out = {};
  if (!node) return out;
  for (const field of node.elements) {
    if (!field.name || field.disabled) continue;
    if (field.type === 'checkbox') out[field.name] = field.checked;
    else if (field.type === 'radio') { if (field.checked) out[field.name] = field.value; }
    else if (field.type === 'number') out[field.name] = field.value === '' ? null : Number(field.value);
    else out[field.name] = field.value;
  }
  return out;
}

/** Read a picked image as a data URL, which the server stores to disk. */
export function readImage(input, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const file = input?.files?.[0];
  if (!file) return Promise.resolve(null);
  if (file.size > maxBytes) return Promise.reject(new Error('Image must be under 4 MB.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

export const debounce = (fn, wait = 220) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

/** Deterministic accent colour from a name, for logo placeholders. */
export function initials(name) {
  const words = String(name || '?').trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
