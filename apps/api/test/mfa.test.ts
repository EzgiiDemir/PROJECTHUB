import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptFromString, totpCode } from '@projecthub/core';
import { users } from '@projecthub/database';
import { ADMIN, client, startHarness, type Harness } from './harness.js';

let h: Harness;
const api = client(() => h.base);

describe('two-step sign-in', () => {
  beforeAll(async () => {
    h = await startHarness();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('turns on the authenticator app only after a valid code and asks for it at every sign-in', async () => {
    // No second factor yet (and no SMTP here): the password signs in.
    expect((await api.post('/auth/login', ADMIN)).status).toBe(200);
    expect((await api.post('/auth/totp/setup', { password: 'yanlis-parola-1' })).status).toBe(400);
    const setup = await api.post('/auth/totp/setup', { password: ADMIN.password });
    expect(setup.status).toBe(200);
    const { secret, uri } = setup.data as { secret: string; uri: string };
    expect(uri).toContain(`secret=${secret}`);
    // The stored secret is encrypted, never the plain value.
    const row = (await h.server.handle.db.select().from(users).where(eq(users.email, ADMIN.email.toLowerCase())))[0]!;
    expect(row.totpSecret).not.toContain(secret);
    expect(decryptFromString(h.config.encryptionKey, row.totpSecret!)).toBe(secret);
    expect((await api.post('/auth/totp/enable', { code: '000000' })).status).toBe(400);
    const enabled = await api.post('/auth/totp/enable', { code: totpCode(secret) });
    expect(enabled.status).toBe(200);
    const { recoveryCodes } = enabled.data as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(((await api.get('/auth/security')).data as { totpEnabled: boolean; recoveryCodesLeft: number }).recoveryCodesLeft).toBe(10);
    await api.post('/auth/logout');

    // A correct password alone no longer opens a session.
    const fresh = client(() => h.base);
    const first = await fresh.post('/auth/login', ADMIN);
    expect(first.status).toBe(200);
    const step = first.data as { mfaRequired: boolean; ticket: string; methods: string[] };
    expect(step.mfaRequired).toBe(true);
    expect(step.methods).toEqual(['totp', 'recovery']);
    expect((await fresh.get('/auth/me')).status).toBe(401);
    expect((await fresh.post('/auth/mfa/verify', { ticket: step.ticket, method: 'totp', code: '123456' })).status).toBe(401);
    const ok = await fresh.post('/auth/mfa/verify', { ticket: step.ticket, method: 'totp', code: totpCode(secret) });
    expect(ok.status).toBe(200);
    expect((await fresh.get('/auth/me')).status).toBe(200);
    // The ticket is single-use.
    expect((await client(() => h.base).post('/auth/mfa/verify', { ticket: step.ticket, method: 'totp', code: totpCode(secret) })).status).toBe(401);

    // A recovery code works once.
    const other = client(() => h.base);
    const t2 = ((await other.post('/auth/login', ADMIN)).data as { ticket: string }).ticket;
    expect((await other.post('/auth/mfa/verify', { ticket: t2, method: 'recovery', code: recoveryCodes[0]!.toUpperCase() })).status).toBe(200);
    const third = client(() => h.base);
    const t3 = ((await third.post('/auth/login', ADMIN)).data as { ticket: string }).ticket;
    expect((await third.post('/auth/mfa/verify', { ticket: t3, method: 'recovery', code: recoveryCodes[0]! })).status).toBe(401);
    expect(((await other.get('/auth/security')).data as { recoveryCodesLeft: number }).recoveryCodesLeft).toBe(9);
  });

  it('locks the step after repeated wrong codes and offers passkey sign-in options', async () => {
    const c = client(() => h.base);
    const t = ((await c.post('/auth/login', ADMIN)).data as { ticket: string }).ticket;
    for (let i = 0; i < 5; i++) expect((await c.post('/auth/mfa/verify', { ticket: t, method: 'totp', code: '000000' })).status).toBe(401);
    const row = (await h.server.handle.db.select().from(users).where(eq(users.email, ADMIN.email.toLowerCase())))[0]!;
    const secret = decryptFromString(h.config.encryptionKey, row.totpSecret!);
    expect((await c.post('/auth/mfa/verify', { ticket: t, method: 'totp', code: totpCode(secret) })).status).toBe(401);

    const options = await c.post('/auth/passkey/options');
    expect(options.status).toBe(200);
    const o = options.data as { ticket: string; options: { challenge: string; rpId: string; userVerification: string } };
    expect(o.options.rpId).toBe('localhost');
    expect(o.options.userVerification).toBe('required');
    expect(o.options.challenge.length).toBeGreaterThan(20);
  });
});
