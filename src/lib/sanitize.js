/**
 * HTML sanitiser for organizer-authored rich text (tournament rules).
 *
 * Rules are written by organizers and rendered to the public, so this runs on
 * the server and is an allowlist: anything not explicitly permitted is
 * dropped. Attributes are filtered per tag, URLs are scheme-checked, and every
 * tag is re-emitted from the parsed name rather than passed through, so no
 * raw markup from the input ever reaches the output.
 */

const ALLOWED = {
  p: [], br: [], strong: [], b: [], em: [], i: [], u: [], s: [],
  h1: [], h2: [], h3: [], h4: [],
  ul: [], ol: ['start'], li: [],
  blockquote: [], code: [], pre: [], hr: [],
  a: ['href', 'title'],
  table: [], thead: [], tbody: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
  span: [], div: [],
};

const VOID_TAGS = new Set(['br', 'hr']);
const SAFE_URL = /^(https?:\/\/|mailto:|\/)/i;

/**
 * Remove spaces and control characters, which are the classic way to hide
 * "java\tscript:" from a naive scheme check. Hyphens and dots are kept, so
 * ordinary URLs survive intact.
 */
function stripBlanks(value) {
  let out = "";
  for (const ch of String(value)) {
    if (ch.codePointAt(0) > 32) out += ch;
  }
  return out;
}

const escapeText = (text) => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * @param {string} html untrusted markup
 * @param {object} [opts]
 * @param {number} [opts.maxLength] hard cap on the output size
 * @returns {string} safe markup
 */
export function sanitizeHtml(html, { maxLength = 60_000 } = {}) {
  if (!html) return '';
  let input = String(html).slice(0, maxLength * 2);

  // Remove whole dangerous elements including their contents.
  input = input.replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '');
  input = input.replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*\/?>/gi, '');
  // Comments and doctypes.
  input = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<![^>]*>/g, '');

  const open = [];
  let out = '';
  let index = 0;

  const TAG = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\s*(\/?)>/g;
  let match;
  while ((match = TAG.exec(input)) !== null) {
    out += escapeText(input.slice(index, match.index));
    index = TAG.lastIndex;

    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrText = match[3] || '';
    const selfClosed = match[4] === '/';

    if (!Object.hasOwn(ALLOWED, tag)) continue;   // drop the tag, keep its text

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;                    // stray close tag
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }

    const attrs = filterAttributes(tag, attrText);
    if (VOID_TAGS.has(tag) || selfClosed) {
      out += `<${tag}${attrs}>`;
    } else {
      out += `<${tag}${attrs}>`;
      open.push(tag);
    }
  }

  out += escapeText(input.slice(index));
  while (open.length) out += `</${open.pop()}>`;

  return out.slice(0, maxLength);
}

function filterAttributes(tag, attrText) {
  const allowed = ALLOWED[tag];
  if (!allowed.length) return '';

  let out = '';
  const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = ATTR.exec(attrText)) !== null) {
    const name = match[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';

    if (name === 'href') {
      const cleaned = stripBlanks(value);
      if (!SAFE_URL.test(cleaned)) continue;
      out += ` href="${escapeText(cleaned)}" rel="noopener nofollow" target="_blank"`;
      continue;
    }
    if ((name === 'colspan' || name === 'rowspan' || name === 'start') && !/^\d{1,3}$/.test(value)) continue;
    out += ` ${name}="${escapeText(value)}"`;
  }
  return out;
}

/** Readable preview text for cards and search results. */
export function htmlToText(html, limit = 220) {
  const text = String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  // The ellipsis has to fit inside the limit, not be appended past it.
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...` : text;
}
