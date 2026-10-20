import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseKeyCombo } from '../extension/lib/keys.js';

describe('parseKeyCombo', () => {
  it('parses named keys with text', () => {
    const parsed = parseKeyCombo('Enter');
    assert.equal(parsed.bitmask, 0);
    assert.equal(parsed.key.code, 'Enter');
    assert.equal(parsed.key.keyCode, 13);
    assert.equal(parsed.key.text, '\r');
  });

  it('parses modifier chords and suppresses text', () => {
    const parsed = parseKeyCombo('Meta+Shift+k');
    assert.equal(parsed.bitmask, 4 | 8);
    assert.deepEqual(parsed.modifiers.map((m: { name: string }) => m.name), ['Meta', 'Shift']);
    assert.equal(parsed.key.code, 'KeyK');
    assert.equal(parsed.key.text, undefined);
  });

  it('accepts aliases and plus as a key', () => {
    assert.equal(parseKeyCombo('ctrl+a').bitmask, 2);
    assert.equal(parseKeyCombo('esc').key.code, 'Escape');
    assert.equal(parseKeyCombo('Control++').key.key, '+');
  });

  it('accepts xdotool-style names case-insensitively', () => {
    assert.equal(parseKeyCombo('Return').key.code, 'Enter');
    assert.equal(parseKeyCombo('Page_Down').key.code, 'PageDown');
    assert.equal(parseKeyCombo('backspace').key.code, 'Backspace');
    assert.equal(parseKeyCombo('space').key.text, ' ');
    assert.equal(parseKeyCombo('super+l').bitmask, 4);
  });

  it('treats a bare modifier as the key itself', () => {
    const parsed = parseKeyCombo('shift');
    assert.equal(parsed.key.code, 'ShiftLeft');
    assert.equal(parsed.bitmask, 8);
    assert.equal(parsed.modifiers.length, 0);
  });

  it('rejects unknown keys and modifiers', () => {
    assert.throws(() => parseKeyCombo('Hyper+a'), /Unknown modifier/);
    assert.throws(() => parseKeyCombo('NotAKey'), /Unknown key/);
  });
});
