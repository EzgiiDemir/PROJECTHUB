/** Tests must not inherit live project settings or credentials. Explicit test.env is authoritative. */
export function testEnvironment(env: NodeJS.ProcessEnv, secretNames: Iterable<string>, testEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of secretNames) delete out[name];
  return { ...out, ...testEnv };
}
