import { describe, expect, it } from 'vitest';
import { manifestSchema } from '../src/manifest.js';

describe('manifest services and build variables', () => {
  it('accepts a frontend with its backend as a service and non-secret build variables', () => {
    const m = manifestSchema.parse({
      project: { name: 'Form' },
      build: { command: 'npm run build', env: { NEXT_PUBLIC_API_URL: '/api', NEXT_PUBLIC_BACKEND_URL: '' } },
      start: { command: 'cd frontend && npm start' },
      services: [{ name: 'api', command: 'cd backend && php artisan serve --port=$PORT', paths: ['/api', '/admin'], health: '/up', urlEnv: 'BACKEND_INTERNAL_URL' }],
    });
    expect(m.services[0]).toMatchObject({ name: 'api', paths: ['/api', '/admin'], health: '/up' });
    expect(m.build?.env).toEqual({ NEXT_PUBLIC_API_URL: '/api', NEXT_PUBLIC_BACKEND_URL: '' });
    expect(manifestSchema.parse({ project: { name: 'X' } }).services).toEqual([]);
  });

  it('rejects ambiguous or unsafe service definitions', () => {
    const base = { project: { name: 'X' } };
    const service = { name: 'api', command: 'node api.mjs', paths: ['/api'] };
    expect(manifestSchema.safeParse({ ...base, services: [service, service] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, services: [{ ...service, paths: ['api'] }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, services: [{ ...service, name: 'API' }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, build: { env: { 'not-valid': 'x' } } }).success).toBe(false);
  });
});
