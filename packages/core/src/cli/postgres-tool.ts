/** libpq connection arguments must never carry the database password.
 * execFile errors include argv; process inspectors can also read argv.
 * PGPASSWORD is supplied only to the child, without changing process.env.
 */
export function postgresToolConnection(connectionString: string, inherited: NodeJS.ProcessEnv = process.env) {
  const url = new URL(connectionString);
  const queryPasswords = url.searchParams.getAll('password');
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(connectionString)?.[1] ?? '';
  const userInfo = authority.slice(0, Math.max(0, authority.lastIndexOf('@')));
  const hasPassword = queryPasswords.length > 0 || userInfo.includes(':');
  const password = queryPasswords.length ? queryPasswords.at(-1)! : decodeURIComponent(url.password);
  url.password = '';
  url.searchParams.delete('password');
  return {
    connectionString: url.href,
    env: { ...inherited, ...(hasPassword ? { PGPASSWORD: password } : {}) },
  };
}
