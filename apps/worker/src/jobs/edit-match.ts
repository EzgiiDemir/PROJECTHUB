export interface SnippetMatch {
  start: number;
  end: number;
  /** How many places matched at the strictest level that matched at all. */
  count: number;
  /** The file's line ending; replacement text is written with it. */
  eol: '\r\n' | '\n';
}

/** Recovery context only: never apply a fuzzy replacement or guess which occurrence the agent meant. */
export function snippetRecovery(text: string, snippet: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const anchors = snippet.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 12);
  let at = -1;
  for (const anchor of anchors) {
    const hits = lines.flatMap((line, i) => line.trim() === anchor ? [i] : []);
    if (hits.length === 1) { at = hits[0]!; break; }
  }
  if (at < 0 && lines.length > 40) return 'Eşsiz bağlam bulunamadı; search_code ile hedef satırı bul, read_file start_line ile yalnız o bölümü oku.';
  const from = Math.max(0, at - 3);
  const to = Math.min(lines.length, at < 0 ? 40 : at + 13);
  return `Güncel bölüm (${from + 1}-${to}):\n${lines.slice(from, to).map((line, i) => `${from + i + 1}\t${line}`).join('\n').slice(0, 5000)}\nSatır numaralarını kopyalama; yalnız değiştireceğin eşsiz kısa parçayı kullan.`;
}

/**
 * Finds the snippet a model quoted for an edit. Models quote what read_file showed them, not the bytes: CRLF files
 * come back with LF, trailing spaces get lost and indentation drifts. 27% of the agent's edits failed on exactly
 * that (Form: docker-compose.yml, package.json). Tried in order, the first level with a match wins: exact; with
 * the file's line endings; ignoring trailing whitespace per line; ignoring surrounding whitespace per line.
 */
export function locateSnippet(text: string, snippet: string): SnippetMatch | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const candidate of [snippet, snippet.replace(/\r?\n/g, eol)]) {
    const first = text.indexOf(candidate);
    if (first >= 0) return { start: first, end: first + candidate.length, count: text.split(candidate).length - 1, eol };
  }
  const lines: { start: number; end: number; text: string }[] = [];
  for (let at = 0; at <= text.length; ) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    lines.push({ start: at, end: end > at && text[end - 1] === '\r' ? end - 1 : end, text: text.slice(at, end).replace(/\r$/, '') });
    if (nl < 0) break;
    at = nl + 1;
  }
  const wanted = snippet.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  for (const norm of [(s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    const target = wanted.map(norm);
    if (!target.some((l) => l)) return null;
    const hits: number[] = [];
    for (let i = 0; i + target.length <= lines.length; i++) {
      if (target.every((l, k) => norm(lines[i + k]!.text) === l)) hits.push(i);
    }
    if (hits.length) {
      const first = hits[0]!;
      return { start: lines[first]!.start, end: lines[first + target.length - 1]!.end, count: hits.length, eol };
    }
  }
  return null;
}
