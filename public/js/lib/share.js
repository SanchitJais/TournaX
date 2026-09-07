/** Shareable links: a copy-to-clipboard field plus the native share sheet. */
import { esc } from './dom.js';
import { icon } from './icons.js';
import { toast } from './ui.js';

export const absoluteUrl = (path) => new URL(path, location.origin).href;

/** Renders a copy field plus (where supported) a native Share button. */
export function shareBox(path, { label = 'Share this page' } = {}) {
  const url = absoluteUrl(path);
  return `
    <div>
      <div class="label mb-1">${esc(label)}</div>
      <div class="share-row">
        <div class="copy-field"><span title="${esc(url)}">${esc(url)}</span>
          <button class="btn btn-sm" data-share-copy="${esc(url)}">${icon('copy', 13)} Copy</button>
        </div>
        <button class="btn btn-sm" data-share-native="${esc(url)}" hidden>${icon('external', 13)} Share</button>
      </div>
    </div>`;
}

/** Compact icon-only button for card headers. */
export const shareButton = (path, title = 'Copy link') =>
  `<button class="btn btn-ghost btn-icon" data-share-copy="${esc(absoluteUrl(path))}" title="${esc(title)}">
     ${icon('copy', 14)}
   </button>`;

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    field.remove();
    return ok;
  }
}

/**
 * Wire every share control inside `root`. Safe to call after each render --
 * it binds one delegated listener on the container.
 */
export function bindShare(root) {
  const node = typeof root === 'string' ? document.querySelector(root) : root;
  if (!node || node.dataset.shareBound === '1') return;
  node.dataset.shareBound = '1';

  if (navigator.share) {
    node.querySelectorAll('[data-share-native]').forEach((el) => { el.hidden = false; });
  }

  node.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-share-copy]');
    if (copyBtn) {
      e.preventDefault();
      const ok = await copy(copyBtn.dataset.shareCopy);
      toast(ok ? 'Link copied to your clipboard.' : 'Could not copy — select the link and copy it manually.', {
        type: ok ? 'success' : 'error',
      });
      return;
    }
    const shareBtn = e.target.closest('[data-share-native]');
    if (shareBtn && navigator.share) {
      e.preventDefault();
      try {
        await navigator.share({ title: document.title, url: shareBtn.dataset.shareNative });
      } catch { /* the user dismissed the sheet */ }
    }
  });
}
