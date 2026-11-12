import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../src/dotenv.js';

describe('.env import parser', () => {
  it('handles Laravel style files: comments, quotes, references, inline comments and literal $', () => {
    const text = [
      '﻿APP_NAME="SEM Akademi"',
      'APP_ENV=local',
      'APP_KEY=base64:abc+/=',
      '# comment',
      '',
      'export DB_PASSWORD=p$ss#word',
      'MAIL_FROM_NAME="${APP_NAME}"',
      'VITE_APP_NAME="${APP_NAME}"',
      "SINGLE='keep ${APP_NAME} \\n literally'",
      'WITH_COMMENT=value # trailing note',
      'ESCAPED="line1\\nline2 \\"q\\""',
      'MULTI="-----BEGIN KEY-----',
      'abc',
      '-----END KEY-----"',
      'FALLBACK=${MISSING:-default}',
      'REDIS_PASSWORD=null',
      'EMPTY=',
      'APP_ENV=production',
      'not a key line',
    ].join('\r\n');
    const { entries, issues } = parseDotenv(text);
    const v = Object.fromEntries(entries.map((e) => [e.name, e.value]));
    expect(v).toEqual({
      APP_NAME: 'SEM Akademi',
      APP_ENV: 'production',
      APP_KEY: 'base64:abc+/=',
      DB_PASSWORD: 'p$ss#word',
      MAIL_FROM_NAME: 'SEM Akademi',
      VITE_APP_NAME: 'SEM Akademi',
      SINGLE: 'keep ${APP_NAME} \\n literally',
      WITH_COMMENT: 'value',
      ESCAPED: 'line1\nline2 "q"',
      MULTI: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      FALLBACK: 'default',
      REDIS_PASSWORD: 'null',
    });
    expect(issues.map((i) => i.reason)).toEqual(
      expect.arrayContaining(['Satır ANAHTAR=değer biçiminde değil, atlandı', 'Değer boş, atlandı', 'Birden fazla tanım var; sonuncusu kullanıldı']),
    );
    // Issues never contain values.
    expect(JSON.stringify(issues)).not.toContain('p$ss');
  });

  it('reports an unclosed quote instead of swallowing the rest of the file', () => {
    const { entries, issues } = parseDotenv('A="open\nB=1');
    expect(entries).toEqual([{ name: 'B', value: '1', line: 2 }]);
    expect(issues[0]).toMatchObject({ name: 'A', reason: 'Tırnak kapanmamış, atlandı' });
  });
});
