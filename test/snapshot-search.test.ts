import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchSnapshot } from '../src/browser/snapshot-search.js';

const SNAPSHOT = [
  '- banner [ref=e1]',
  '  - link "Home" [url=/] [ref=e2]',
  '  - button "Sign in" [ref=e3]',
  '- main [ref=e4]',
  '  - heading "Welcome back" [level=1] [ref=e5]',
  '  - textbox "Email" [ref=e6]',
  '  - button "Sign in with Google" [ref=e7]',
].join('\n');

describe('searchSnapshot', () => {
  it('matches all words case-insensitively and extracts refs', () => {
    const result = searchSnapshot(SNAPSHOT, 'sign BUTTON');
    assert.equal(result.total, 2);
    assert.deepEqual(result.matches.map((m) => m.ref), ['e3', 'e7']);
    assert.equal(result.truncated, false);
  });

  it('includes surrounding context lines', () => {
    const [match] = searchSnapshot(SNAPSHOT, 'email', { contextLines: 1 }).matches;
    assert.equal(match?.ref, 'e6');
    assert.deepEqual(match?.context, [
      '- heading "Welcome back" [level=1] [ref=e5]',
      '- button "Sign in with Google" [ref=e7]',
    ]);
  });

  it('supports regex and limits', () => {
    const result = searchSnapshot(SNAPSHOT, '^\\s*- button', { regex: true, limit: 1 });
    assert.equal(result.total, 2);
    assert.equal(result.matches.length, 1);
    assert.equal(result.truncated, true);
  });

  it('rejects invalid regex and empty queries', () => {
    assert.throws(() => searchSnapshot(SNAPSHOT, '(', { regex: true }), /Invalid regex/);
    assert.throws(() => searchSnapshot(SNAPSHOT, '   '), /must not be empty/);
  });
});
