import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommandText } from '../src/commandText.js';

test('normalization preserves meaningful arguments and emoji sequences', () => {
  assert.equal(normalizeCommandText('!я 👨‍👩‍👧‍👦 \u2063'), '!я 👨‍👩‍👧‍👦');
  assert.equal(normalizeCommandText('!я a\u200cb'), '!я a\u200cb');
  assert.equal(normalizeCommandText('!кликуха extra \u200b'), '!кликуха extra');
  assert.equal(normalizeCommandText('!я a\u2063b'), '!я a\u2063b');
});
