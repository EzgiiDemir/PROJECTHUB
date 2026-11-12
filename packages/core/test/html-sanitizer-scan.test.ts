import { expect, it } from 'vitest';
import { scanCode } from '../src/scan/code.js';
const prefix = 'import DOMPurify from "isomorphic-dompurify";\n';
const scan = (source: string) => scanCode('src/view.tsx', source).filter((f) => f.ruleId === 'code/js-dangerous-html');
it('recognises a directly sanitised sink without flagging already fixed code repeatedly', () => {
  expect(scan(prefix + 'return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} />')).toEqual([]);
  expect(scan(prefix + 'editor.innerHTML = DOMPurify.sanitize(value);')).toEqual([]);
});
it('does not trust names, custom options, hooks, shadowed imports, concatenation or an adjacent unsafe sink', () => {
  for (const source of [
    '// ' + prefix + 'return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} />',
    '/*\n' + prefix + '*/\nreturn <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} />',
    'const spoof = `\n' + prefix + '`;\nreturn <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} />',
    'return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} />',
    prefix + 'return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value, {ADD_TAGS:["script"]}) }} />',
    prefix + 'DOMPurify.addHook("afterSanitizeAttributes", unsafe);\nreturn <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} />',
    prefix + 'function f(DOMPurify) { return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} /> }',
    prefix + 'editor.innerHTML = DOMPurify.sanitize(value) + unsafe;',
    prefix + 'return <><div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(value) }} /><div dangerouslySetInnerHTML={{ __html: unsafe }} /></>',
  ]) expect(scan(source), source).not.toHaveLength(0);
});
