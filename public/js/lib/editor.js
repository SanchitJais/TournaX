/**
 * Small rich-text editor for tournament rules.
 *
 * contenteditable plus document.execCommand. The commands are deprecated but
 * still universally supported, and this needs no dependency for what is a
 * handful of formatting buttons. Whatever it produces is sanitised on the
 * server before storage, so the editor is a convenience, never a trust
 * boundary -- pasted markup is also stripped to plain text on the way in.
 */
import { esc } from './dom.js';

const BUTTONS = [
  ['bold', '<b>B</b>', 'Bold'],
  ['italic', '<i>I</i>', 'Italic'],
  ['underline', '<u>U</u>', 'Underline'],
  ['|'],
  ['formatBlock:<h2>', 'H2', 'Heading'],
  ['formatBlock:<h3>', 'H3', 'Sub-heading'],
  ['formatBlock:<p>', 'P', 'Paragraph'],
  ['|'],
  ['insertUnorderedList', '&bull; List', 'Bulleted list'],
  ['insertOrderedList', '1. List', 'Numbered list'],
  ['formatBlock:<blockquote>', '&ldquo;', 'Quote'],
  ['|'],
  ['createLink', 'Link', 'Insert link'],
  ['unlink', 'Unlink', 'Remove link'],
  ['removeFormat', 'Clear', 'Clear formatting'],
];

export function editorMarkup(id, html, placeholder = 'Write the tournament rules...') {
  const toolbar = BUTTONS.map(([command, label, title]) => (command === '|'
    ? '<span style="width:1px;background:var(--border);margin:2px 4px"></span>'
    : `<button type="button" data-cmd="${esc(command)}" title="${esc(title)}">${label}</button>`)).join('');

  return `
    <div class="editor" data-editor="${esc(id)}">
      <div class="editor-toolbar">${toolbar}</div>
      <div class="editor-body prose" contenteditable="true" id="${esc(id)}"
           data-placeholder="${esc(placeholder)}">${html || ''}</div>
    </div>`;
}

/** Activate an editor rendered by `editorMarkup`. Returns a getter for its HTML. */
export function bindEditor(root, id) {
  const container = (typeof root === 'string' ? document.querySelector(root) : root)
    ?.querySelector(`[data-editor="${id}"]`);
  if (!container) return () => '';

  const body = container.querySelector('.editor-body');

  container.querySelector('.editor-toolbar').addEventListener('click', (e) => {
    const button = e.target.closest('[data-cmd]');
    if (!button) return;
    e.preventDefault();
    body.focus();

    const [command, argument] = button.dataset.cmd.split(':');
    if (command === 'createLink') {
      const url = prompt('Link URL (https://...)');
      if (!url) return;
      if (!/^(https?:\/\/|mailto:|\/)/i.test(url)) {
        alert('Only http(s), mailto and site-relative links are allowed.');
        return;
      }
      document.execCommand('createLink', false, url);
      return;
    }
    document.execCommand(command, false, argument || null);
  });

  // Paste as plain text: keeps the markup predictable and matches what the
  // server sanitiser would keep anyway.
  body.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  return () => body.innerHTML.trim();
}
