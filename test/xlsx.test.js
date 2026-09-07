import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, readXlsx, readXlsxObjects } from '../src/lib/xlsx.js';
import { normaliseHeader, parseCsvObjects, toCsv } from '../src/lib/csv.js';

test('xlsx round-trips values, quotes and XML-special characters', () => {
  const buf = buildXlsx([
    {
      name: 'Teams',
      headers: ['Team Name', 'Team ID', 'Captain', 'Group', 'Points'],
      rows: [
        ['Soul "Godlike"', 'T-001', 'Mortal', 'A', 128],
        ['Team & Xspark <TX>', 'T-002', 'Scout', 'B', 96.5],
        ['GodLike Esports', 'T-003', 'Jonathan', 'A', 0],
      ],
    },
    { name: 'Schedule', headers: ['Match', 'Time'], rows: [['Match 1', 'Sept 10, 7:00 PM']] },
  ]);

  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'should be a ZIP container');

  const rows = readXlsx(buf);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], ['Team Name', 'Team ID', 'Captain', 'Group', 'Points']);
  assert.equal(rows[1][0], 'Soul "Godlike"');
  assert.equal(rows[2][0], 'Team & Xspark <TX>');
  assert.equal(rows[1][4], '128');
  assert.equal(rows[2][4], '96.5');
});

test('xlsx reads into objects with normalised headers', () => {
  const buf = buildXlsx([{
    name: 'Teams',
    headers: ['Team Name', 'Captain Name', 'Player 1'],
    rows: [['Soul', 'Mortal', 'Owais']],
  }]);
  const objs = readXlsxObjects(buf, normaliseHeader);
  assert.deepEqual(objs, [{ team_name: 'Soul', captain_name: 'Mortal', player_1: 'Owais' }]);
});

test('xlsx tolerates a zero-row sheet', () => {
  const buf = buildXlsx([{ name: 'Empty', headers: ['A', 'B'], rows: [] }]);
  assert.deepEqual(readXlsx(buf), [['A', 'B']]);
});

test('csv parses quoted fields, embedded commas and newlines', () => {
  const csv = 'Team Name,Captain,Notes\r\n"Soul, Esports",Mortal,"said ""gg"""\r\nGodLike,Jonathan,\r\n';
  assert.deepEqual(parseCsvObjects(csv), [
    { team_name: 'Soul, Esports', captain: 'Mortal', notes: 'said "gg"' },
    { team_name: 'GodLike', captain: 'Jonathan', notes: '' },
  ]);
});

test('csv escapes values that would otherwise break the row', () => {
  const out = toCsv([['a,b', 'c"d', 'e\nf']]);
  assert.ok(out.includes('"a,b"'));
  assert.ok(out.includes('"c""d"'));
});
