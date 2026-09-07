import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTablePdf } from '../src/lib/pdf.js';

const columns = [
  { label: '#', key: 'rank', align: 'right', max: 40 },
  { label: 'Team', key: 'team', bold: true },
  { label: 'Played', key: 'played', align: 'right' },
  { label: 'Kills', key: 'kills', align: 'right' },
  { label: 'Points', key: 'points', align: 'right' },
];

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  rank: i + 1,
  team: `Team (Number ${i + 1}) \\ "Elite" & Co`,
  played: 6,
  kills: 60 - i,
  points: 120 - i * 2,
}));

test('pdf has a valid header, trailer and xref table', () => {
  const buf = renderTablePdf({
    title: 'BGMI Pro Series 2026',
    subtitle: 'Overall Leaderboard',
    meta: ['Stage: Group Stage', '16 teams'],
    columns,
    rows: rows(10),
  });
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'), 'starts with the PDF magic');
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /startxref\n\d+/);

  // Every offset in the xref table must point at its "N 0 obj" declaration.
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const xrefAt = Number(/startxref\n(\d+)/.exec(text)[1]);
  // lines: "xref", "0 N", the free entry, then one row per object.
  const lines = text.slice(xrefAt).split('\n');
  for (let i = 1; i < size; i++) {
    const offset = Number(lines[i + 2].slice(0, 10));
    assert.ok(text.startsWith(`${i} 0 obj`, offset), `object ${i} offset is wrong`);
  }
});

test('pdf paginates long tables and numbers every page', () => {
  const buf = renderTablePdf({ title: 'Big', subtitle: 'Many rows', columns, rows: rows(120) });
  const text = buf.toString('latin1');
  const count = Number(/\/Count (\d+)/.exec(text)[1]);
  assert.ok(count > 1, 'should span several pages');
  assert.ok(text.includes(`Page 1 of ${count}`));
  assert.ok(text.includes(`Page ${count} of ${count}`));
});

test('pdf escapes parentheses and backslashes in content strings', () => {
  const buf = renderTablePdf({
    title: 'Escapes',
    columns: [{ label: 'Name', key: 'n' }],
    rows: [{ n: 'A (b) \\ c' }],
  });
  assert.ok(buf.toString('latin1').includes('A \\(b\\) \\\\ c'));
});

test('pdf renders with zero rows', () => {
  const buf = renderTablePdf({ title: 'Empty', columns, rows: [] });
  assert.ok(buf.toString('latin1').includes('No records yet.'));
});
