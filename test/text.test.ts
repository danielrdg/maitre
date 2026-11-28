import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fencedData } from '../src/minutes.js';
import { shownText } from '../src/pending.js';

const INVISIBLE = ['​', '‌', '‍', '‎', '‏', '؜', ' ', ' '];

test('shown text replaces zero-width, bidi marks and line or paragraph separators', () => {
  for (const c of INVISIBLE) assert.equal(shownText(`a${c}b`, 10), 'a?b', JSON.stringify(c));
});

test('fenced data replaces the same characters, keeping tabs and newlines', () => {
  for (const c of INVISIBLE) assert.equal(fencedData('n', `a${c}b\tc\nd`), 'n\n```\na?b\tc\nd\n```', JSON.stringify(c));
});

test('shown text is never clipped in the middle of a surrogate pair', () => {
  assert.equal(shownText('\u{1F600}\u{1F600}', 2), '…');
  assert.equal(shownText('a\u{1F600}bc', 3), 'a…');
});

test('fenced data keeps CRLF line ends as line ends', () => {
  assert.equal(fencedData('n', 'a\r\nb\rc'), 'n\n```\na\nb\nc\n```');
});
