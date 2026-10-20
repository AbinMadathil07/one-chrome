const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'that', 'this', 'is',
  'element', 'elements', 'thing', 'item', 'please', 'find', 'me', 'my', 'which', 'where', 'it',
]);

/** Everyday words a model uses for a control, mapped to the roles our tree emits. */
const ROLE_SYNONYMS: Record<string, string[]> = {
  field: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  input: ['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio'],
  box: ['textbox', 'searchbox', 'checkbox', 'combobox'],
  textbox: ['textbox', 'searchbox'],
  textarea: ['textbox'],
  search: ['searchbox'],
  button: ['button'],
  btn: ['button'],
  link: ['link'],
  dropdown: ['combobox', 'listbox'],
  select: ['combobox', 'listbox'],
  menu: ['menu', 'menuitem', 'combobox', 'navigation'],
  checkbox: ['checkbox', 'switch'],
  toggle: ['switch', 'checkbox'],
  radio: ['radio'],
  tab: ['tab'],
  heading: ['heading'],
  title: ['heading'],
  image: ['img'],
  picture: ['img'],
  icon: ['img', 'button'],
  slider: ['slider'],
  nav: ['navigation'],
  navigation: ['navigation'],
  dialog: ['dialog'],
  modal: ['dialog'],
  table: ['table'],
  row: ['row'],
  form: ['form'],
  list: ['list', 'listbox'],
};

const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'clickable',
]);

export type FindMatch = { line: string; score: number };

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter((word) => word && !STOP_WORDS.has(word));
}

function roleOf(line: string): string {
  return line.trim().split(/[\s"]/)[0] ?? '';
}

function scoreLine(line: string, words: string[]): number {
  const lower = line.toLowerCase();
  const role = roleOf(lower);
  let score = 0;
  let matched = 0;
  for (const word of words) {
    const roles = ROLE_SYNONYMS[word];
    if (roles?.includes(role) || role === word) {
      score += 2;
      matched += 1;
    } else if (lower.includes(word)) {
      score += new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower) ? 3 : 1.5;
      matched += 1;
    }
  }
  if (matched === 0) return 0;
  if (INTERACTIVE_ROLES.has(role)) score += 0.5;
  return score * (matched / words.length);
}

/** Ranks `[ref_N]` tree lines against a natural-language description. */
export function rankElements(tree: string, query: string, limit = 20): FindMatch[] {
  const words = tokenize(query);
  if (words.length === 0) return [];
  return tree
    .split('\n')
    .filter((line) => /\[ref_\d+\]/.test(line))
    .map((line) => ({ line: line.trim(), score: scoreLine(line, words) }))
    .filter((match) => match.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
