const NAMED_KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Insert: { code: 'Insert', keyCode: 45 },
  F1: { code: 'F1', keyCode: 112 },
  F2: { code: 'F2', keyCode: 113 },
  F3: { code: 'F3', keyCode: 114 },
  F4: { code: 'F4', keyCode: 115 },
  F5: { code: 'F5', keyCode: 116 },
  F6: { code: 'F6', keyCode: 117 },
  F7: { code: 'F7', keyCode: 118 },
  F8: { code: 'F8', keyCode: 119 },
  F9: { code: 'F9', keyCode: 120 },
  F10: { code: 'F10', keyCode: 121 },
  F11: { code: 'F11', keyCode: 122 },
  F12: { code: 'F12', keyCode: 123 },
};

const MODIFIERS = {
  Alt: { bit: 1, code: 'AltLeft', keyCode: 18 },
  Control: { bit: 2, code: 'ControlLeft', keyCode: 17 },
  Meta: { bit: 4, code: 'MetaLeft', keyCode: 91 },
  Shift: { bit: 8, code: 'ShiftLeft', keyCode: 16 },
};

const MODIFIER_ALIASES = {
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta',
  win: 'Meta', windows: 'Meta', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
};

const KEY_ALIASES = {
  esc: 'Escape', return: 'Enter', kp_enter: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', ' ': 'Space', page_up: 'PageUp', prior: 'PageUp',
  page_down: 'PageDown', next: 'PageDown', pgup: 'PageUp', pgdn: 'PageDown', ins: 'Insert',
};

const NAMED_BY_LOWER = Object.fromEntries(Object.keys(NAMED_KEYS).map((name) => [name.toLowerCase(), name]));

function canonicalKeyName(part) {
  const lower = part.toLowerCase();
  return KEY_ALIASES[lower] || NAMED_BY_LOWER[lower] || part;
}

function describeChar(char, shift) {
  const upper = char.toUpperCase();
  if (/^[a-z]$/i.test(char)) {
    const value = shift ? upper : char;
    return { key: value, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: value };
  }
  if (/^[0-9]$/.test(char)) {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  }
  return { key: char, code: '', keyCode: 0, text: char };
}

/** Converts a chord such as "ctrl+shift" into the CDP modifier bitmask. */
export function parseModifierChord(chord) {
  if (!chord) return 0;
  return String(chord)
    .split('+')
    .filter(Boolean)
    .reduce((acc, part) => {
      const name = MODIFIER_ALIASES[part.toLowerCase()];
      if (!name) {
        throw new Error(`Unknown modifier "${part}" in "${chord}". Use ctrl, shift, alt, or meta.`);
      }
      return acc | MODIFIERS[name].bit;
    }, 0);
}

/** Parses "Enter", "Control+A", "Meta+Shift+K" into CDP key event descriptors. */
export function parseKeyCombo(combo) {
  const raw = String(combo);
  const parts = raw === '+' ? ['+'] : raw.split('+').filter((p, i, all) => p !== '' || i === all.length - 1);
  const keyPart = parts.pop() || '+';
  const modifiers = parts.map((part) => {
    const name = MODIFIER_ALIASES[part.toLowerCase()] || part;
    if (!MODIFIERS[name]) {
      throw new Error(`Unknown modifier "${part}" in "${raw}". Use Control, Shift, Alt, or Meta.`);
    }
    return name;
  });

  const bitmask = modifiers.reduce((acc, name) => acc | MODIFIERS[name].bit, 0);
  const modifierAsKey = keyPart.length > 1 ? MODIFIER_ALIASES[keyPart.toLowerCase()] : undefined;
  if (modifierAsKey) {
    const mod = MODIFIERS[modifierAsKey];
    return {
      modifiers: modifiers.map((name) => ({ name, ...MODIFIERS[name] })),
      bitmask: bitmask | mod.bit,
      key: { key: modifierAsKey, code: mod.code, keyCode: mod.keyCode, text: undefined },
    };
  }
  const keyName = canonicalKeyName(keyPart);
  const named = NAMED_KEYS[keyName];
  const shift = modifiers.includes('Shift');
  const desc = named
    ? { key: named.key || keyName, code: named.code, keyCode: named.keyCode, text: named.text }
    : keyPart.length === 1
      ? describeChar(keyPart, shift)
      : null;

  if (!desc) {
    throw new Error(`Unknown key "${keyPart}". Use a single character or a name like Enter, Tab, ArrowDown.`);
  }

  const suppressText = modifiers.includes('Control') || modifiers.includes('Meta') || modifiers.includes('Alt');
  return {
    modifiers: modifiers.map((name) => ({ name, ...MODIFIERS[name] })),
    bitmask,
    key: { ...desc, text: suppressText ? undefined : desc.text },
  };
}
