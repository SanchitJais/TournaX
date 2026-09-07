import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, sanitizeHtml } from '../src/lib/sanitize.js';

const clean = (html) => sanitizeHtml(html);

test('keeps the formatting organizers actually use', () => {
  const input = '<h2>Rules</h2><p>Be <strong>on time</strong>.</p><ul><li>No emulators</li><li>4 players</li></ul>';
  assert.equal(clean(input), input);
});

test('drops script tags and their contents', () => {
  const out = clean('<p>Hi</p><script>alert(document.cookie)</script><p>Bye</p>');
  assert.equal(out, '<p>Hi</p><p>Bye</p>');
  assert.ok(!out.includes('alert'));
});

test('strips event handler attributes', () => {
  const out = clean('<p onclick="steal()" onmouseover="x()">Text</p>');
  assert.equal(out, '<p>Text</p>');
});

test('blocks javascript: and data: URLs, including obfuscated ones', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
  ]) {
    const out = clean(`<a href="${href}">click</a>`);
    assert.ok(!/javascript|vbscript|data:/i.test(out), `leaked through: ${href} -> ${out}`);
    assert.equal(out, '<a>click</a>');
  }
});

test('allows safe links and hardens them', () => {
  const out = clean('<a href="https://my-site.example.com/rules?a=1">rules</a>');
  assert.ok(out.includes('href="https://my-site.example.com/rules?a=1"'), out);
  assert.ok(out.includes('rel="noopener nofollow"'));
  assert.ok(out.includes('target="_blank"'));
});

test('escapes text that looks like markup', () => {
  const out = clean('<p>Use <not-a-tag> carefully & wisely</p>');
  assert.ok(out.includes('&amp;'));
  assert.ok(!out.includes('<not-a-tag>'));
});

test('closes unbalanced tags rather than leaking them', () => {
  const out = clean('<p><strong>bold');
  assert.equal(out, '<p><strong>bold</strong></p>');
});

test('ignores stray closing tags', () => {
  assert.equal(clean('text</div></p>'), 'text');
});

test('drops iframes, objects, svg and style blocks', () => {
  const out = clean('<iframe src="evil"></iframe><svg onload="x"></svg><style>body{display:none}</style><p>ok</p>');
  assert.equal(out, '<p>ok</p>');
});

test('img is not allowed (no remote pixel loading from rules)', () => {
  assert.equal(clean('<img src="https://tracker/x.gif">caption'), 'caption');
});

test('numeric attributes must be numeric', () => {
  assert.equal(clean('<td colspan="2">a</td>'), '<td colspan="2">a</td>');
  assert.equal(clean('<td colspan="x(1)">a</td>'), '<td>a</td>');
});

test('respects the length cap', () => {
  const out = sanitizeHtml(`<p>${'a'.repeat(5000)}</p>`, { maxLength: 100 });
  assert.ok(out.length <= 100);
});

test('handles empty and null input', () => {
  assert.equal(clean(''), '');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});

test('htmlToText produces a readable preview', () => {
  assert.equal(
    htmlToText('<h2>Rules</h2><p>Be   <strong>on time</strong>&amp; ready</p>'),
    'Rules Be on time & ready',
  );
  assert.equal(htmlToText('<p>' + 'x'.repeat(500) + '</p>', 20).length, 20);
});
