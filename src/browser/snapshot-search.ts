export type SnapshotMatch = {
  line: number;
  ref: string | null;
  match: string;
  context: string[];
};

export type SnapshotSearchResult = {
  total: number;
  matches: SnapshotMatch[];
  truncated: boolean;
};

const REF_PATTERN = /\[ref=(e\d+)\]/;

function buildMatcher(query: string, regex: boolean): (line: string) => boolean {
  if (regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, 'i');
    } catch (error) {
      throw new Error(`Invalid regex "${query}": ${error instanceof Error ? error.message : String(error)}`);
    }
    return (line) => pattern.test(line);
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (line) => {
    const lower = line.toLowerCase();
    return terms.every((term) => lower.includes(term));
  };
}

/**
 * Finds snapshot lines matching a query and returns them with surrounding context,
 * which is far cheaper for a model than reading a whole page snapshot.
 */
export function searchSnapshot(
  snapshot: string,
  query: string,
  options: { regex?: boolean; limit?: number; contextLines?: number } = {},
): SnapshotSearchResult {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('query must not be empty');
  }
  const limit = options.limit ?? 20;
  const contextLines = options.contextLines ?? 1;
  const matches = buildMatcher(trimmed, Boolean(options.regex));
  const lines = snapshot.split('\n');

  const found: SnapshotMatch[] = [];
  let total = 0;
  lines.forEach((line, index) => {
    if (!matches(line)) return;
    total += 1;
    if (found.length >= limit) return;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length, index + contextLines + 1);
    found.push({
      line: index + 1,
      ref: line.match(REF_PATTERN)?.[1] ?? null,
      match: line.trim(),
      context: lines.slice(start, end).filter((_, i) => start + i !== index).map((l) => l.trim()),
    });
  });

  return { total, matches: found, truncated: total > found.length };
}
