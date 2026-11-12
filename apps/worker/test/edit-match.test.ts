import { describe, expect, it } from 'vitest';
import { locateSnippet, snippetRecovery } from '../src/jobs/edit-match.js';

const apply = (text: string, oldText: string, newText: string) => {
  const m = locateSnippet(text, oldText);
  if (!m) return null;
  return text.slice(0, m.start) + newText.replace(/\r?\n/g, m.eol) + text.slice(m.end);
};

describe('locating the snippet a model quoted for an edit', () => {
  it('provides bounded current context without applying a guessed replacement', () => {
    const text = Array.from({ length: 1100 }, (_, i) => `const value${i} = ${i};`).join('\n');
    const snippet = 'const value477 = 477;\nthis line is stale';
    expect(locateSnippet(text, snippet)).toBeNull();
    const recovery = snippetRecovery(text, snippet);
    expect(recovery).toContain('478\tconst value477 = 477;');
    expect(recovery).not.toContain('const value0 =');
    expect(recovery.length).toBeLessThan(5100);
    expect(snippetRecovery(text, 'unknown stale line')).toContain('start_line');
    expect(snippetRecovery('{\n  "dependencies": {}\n}', 'stale json')).toContain('"dependencies": {}');
  });
  it('matches a CRLF file quoted with LF and writes the replacement with CRLF', () => {
    const file = 'services:\r\n  postgres:\r\n    ports:\r\n      - "5432:5432"\r\n';
    expect(apply(file, '    ports:\n      - "5432:5432"', '    ports:\n      - "127.0.0.1:5432:5432"')).toBe('services:\r\n  postgres:\r\n    ports:\r\n      - "127.0.0.1:5432:5432"\r\n');
  });

  it('tolerates lost trailing spaces and drifted indentation, but never guesses between several places', () => {
    const file = 'a = 1;   \n  if (x) {\n    run();\n  }\n';
    expect(apply(file, 'a = 1;\nif (x) {', 'a = 2;\nif (x) {')).toBe('a = 2;\nif (x) {\n    run();\n  }\n');
    expect(locateSnippet('run();\nrun();\n', 'run();')?.count).toBe(2);
    expect(locateSnippet('x\n', 'y')).toBeNull();
  });

  it('prefers the exact text when it exists', () => {
    const m = locateSnippet('alpha\nbeta\n', 'beta');
    expect(m).toMatchObject({ start: 6, end: 10, count: 1, eol: '\n' });
  });
});

describe('plain explanation items', () => {
  it('turns an HTML list a model wrote into plain items', async () => {
    const { plainItems } = await import('../src/jobs/ai.js');
    expect(plainItems(['<ul><li>cartTotal düzeltildi</li><li>kupon <b>yüzde</b> oldu</li></ul>', 'Testler geçti'])).toEqual(['cartTotal düzeltildi', 'kupon yüzde oldu', 'Testler geçti']);
  });
});
