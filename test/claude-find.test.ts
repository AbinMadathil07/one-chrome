import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankElements } from '../src/claude/find.js';

const TREE = [
  'navigation "Main"',
  '  link "Documentation" [ref_1]',
  '  link "Pricing" [ref_2]',
  'searchbox "Search docs" [ref_3]',
  'button "Search" [ref_4]',
  'heading "Shoes" [level=1] [ref_5]',
  'button "Add to cart" [ref_6]',
  'textbox "Email address" [ref_7]',
  'checkbox "Remember me" [ref_8]',
].join('\n');

describe('rankElements', () => {
  it('maps everyday words onto roles', () => {
    assert.equal(rankElements(TREE, 'search field')[0]?.line, 'searchbox "Search docs" [ref_3]');
    assert.equal(rankElements(TREE, 'add to cart button')[0]?.line, 'button "Add to cart" [ref_6]');
    assert.equal(rankElements(TREE, 'email input')[0]?.line, 'textbox "Email address" [ref_7]');
    assert.equal(rankElements(TREE, 'remember me checkbox')[0]?.line, 'checkbox "Remember me" [ref_8]');
  });

  it('only returns tagged elements and honours the limit', () => {
    const all = rankElements(TREE, 'search', 1);
    assert.equal(all.length, 1);
    assert.ok(rankElements(TREE, 'main').every((m) => m.line.includes('[ref_')));
    assert.deepEqual(rankElements(TREE, 'the a'), []);
    assert.deepEqual(rankElements(TREE, 'zebra'), []);
  });
});
