import { describe, expect, it } from 'vitest';
import { postgresToolConnection } from '../src/cli/postgres-tool.js';

describe('PostgreSQL tool credential boundary', () => {
  it('moves encoded userinfo credentials out of argv without losing connection options', () => {
    const value = ['generated', ':@/%', 'ş ü'].join('-');
    const input = `postgresql://operator:${encodeURIComponent(value)}@127.0.0.1:54329/isolated_test?sslmode=require`;
    const inherited = { PATH: 'trusted-tools', PGPASSWORD: 'inherited' };
    const output = postgresToolConnection(input, inherited);
    expect(output.connectionString).toBe('postgresql://operator@127.0.0.1:54329/isolated_test?sslmode=require');
    expect(output.connectionString).not.toContain(value);
    expect(output.connectionString).not.toContain(encodeURIComponent(value));
    expect(output.env.PGPASSWORD).toBe(value);
    expect(output.env.PATH).toBe('trusted-tools');
    expect(inherited.PGPASSWORD).toBe('inherited');
  });

  it('removes query passwords too, with the last query value taking precedence', () => {
    const output = postgresToolConnection('postgres://operator:old@localhost/isolated_test?password=first&application_name=drill&password=last%2Bvalue', {});
    expect(output.env.PGPASSWORD).toBe('last+value');
    expect(output.connectionString).toBe('postgres://operator@localhost/isolated_test?application_name=drill');
  });

  it('preserves inherited authentication when no password was specified', () => {
    expect(postgresToolConnection('postgres://operator@localhost/isolated_test', { PGPASSWORD: 'inherited' }).env.PGPASSWORD).toBe('inherited');
    expect(postgresToolConnection('postgres://operator@localhost/isolated_test', {}).env.PGPASSWORD).toBeUndefined();
  });

  it('does not mistake a percent-encoded colon in a username for a password', () => {
    const output = postgresToolConnection('postgres://service%3Abackup@localhost/isolated_test', {});
    expect(output.env.PGPASSWORD).toBeUndefined();
    expect(output.connectionString).toContain('service%3Abackup@');
  });

  it('handles IPv6 and an explicitly empty query password without changing the parent environment', () => {
    const inherited = { PGPASSWORD: 'inherited' };
    const output = postgresToolConnection('postgres://operator@[::1]:54329/isolated_test?password=', inherited);
    expect(output.env.PGPASSWORD).toBe('');
    expect(output.connectionString).toBe('postgres://operator@[::1]:54329/isolated_test');
    expect(inherited.PGPASSWORD).toBe('inherited');
  });
});
