import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  AppError,
  decryptFromString,
  encryptToString,
  generateRecoveryCodes,
  generateTotpSecret,
  invalid,
  notFound,
  randomToken,
  recoveryCodeHash,
  sha256,
  timingSafeEqualHex,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '@projecthub/core';
import { loginChallenges, users, webauthnCredentials } from '@projecthub/database';
import { Ctx } from '../../infra/context.js';
import { Mailer } from '../../infra/mailer.js';

export type SecondFactor = 'totp' | 'email' | 'passkey' | 'recovery';
type User = typeof users.$inferSelect;

const TICKET_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const EMAIL_RESEND_SECONDS = 30;

const expired = () => new AppError('UNAUTHENTICATED', 'Doğrulama adımının süresi doldu. Yeniden giriş yapın.');
const wrongCode = () => new AppError('UNAUTHENTICATED', 'Kod hatalı veya süresi dolmuş.');

/**
 * Second sign-in step and passkeys. After a correct password the session is not opened until one second factor
 * succeeds: an authenticator app code, a passkey (fingerprint / Face ID / Windows Hello / security key), a code
 * e-mailed to the account, or a one-time recovery code. Passkeys also sign in on their own (they already prove
 * possession of the device and the person's biometric or PIN).
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly ctx: Ctx,
    private readonly mailer: Mailer,
  ) {}

  private get rp() {
    const url = new URL(this.ctx.config.APP_URL);
    return { id: this.ctx.config.WEBAUTHN_RP_ID || url.hostname, origin: url.origin, name: 'Project Hub' };
  }

  private emailAvailable() {
    return this.ctx.config.AUTH_EMAIL_CODE === 'required' && !!this.ctx.config.SMTP_HOST;
  }

  /** The second factors this account can use; empty = the password alone signs in. */
  async methods(user: User): Promise<SecondFactor[]> {
    const passkeys = await this.ctx.db.select({ id: webauthnCredentials.id }).from(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id)).limit(1);
    const out: SecondFactor[] = [];
    if (passkeys.length) out.push('passkey');
    if (user.totpEnabledAt) out.push('totp');
    if (this.emailAvailable()) out.push('email');
    if (user.totpEnabledAt && user.recoveryCodes.length) out.push('recovery');
    return out;
  }

  /** Opens the second step after a correct password; null when the account has no second factor. */
  async begin(user: User) {
    const methods = await this.methods(user);
    if (!methods.length) return null;
    const ticket = await this.createTicket('mfa', user.id);
    // With nothing stronger set up, the e-mail code is the second factor: send it straight away.
    const emailSent = methods[0] === 'email' ? await this.sendEmailCode(ticket).then(() => true) : false;
    return { mfaRequired: true as const, ticket, methods, emailSent, email: maskEmail(user.email) };
  }

  async sendEmailCode(ticket: string) {
    const c = await this.challenge(ticket, 'mfa');
    if (!this.emailAvailable()) throw invalid('E-posta ile doğrulama bu kurulumda kapalı.');
    if (c.emailSentAt && Date.now() - c.emailSentAt.getTime() < EMAIL_RESEND_SECONDS * 1000) throw new AppError('RATE_LIMITED', `Yeni kod için ${EMAIL_RESEND_SECONDS} saniye bekleyin.`);
    const user = await this.user(c.userId!);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.ctx.db.update(loginChallenges).set({ emailCodeHash: sha256(`${c.id}:${code}`), emailSentAt: new Date() }).where(eq(loginChallenges.id, c.id));
    const sent = await this.mailer.send(
      user.email,
      `Project Hub giriş kodu: ${code}`,
      `Merhaba ${user.displayName},\n\nProject Hub giriş kodunuz: ${code}\n\nKod ${TICKET_MINUTES} dakika geçerlidir. Bu girişi siz yapmadıysanız şifrenizi hemen değiştirin.\n`,
    );
    if (!sent) throw new AppError('INTERNAL_ERROR', 'Doğrulama e-postası gönderilemedi. SMTP ayarlarını kontrol edin.');
    return { sent: true, email: maskEmail(user.email) };
  }

  /** Checks the second factor; returns the user id and consumes the ticket on success. */
  async verify(ticket: string, method: Exclude<SecondFactor, 'passkey'>, code: string): Promise<{ userId: string; method: SecondFactor }> {
    const c = await this.challenge(ticket, 'mfa');
    const user = await this.user(c.userId!);
    let ok = false;
    if (method === 'totp' && user.totpEnabledAt && user.totpSecret) ok = verifyTotp(decryptFromString(this.ctx.config.encryptionKey, user.totpSecret), code);
    if (method === 'email' && c.emailCodeHash && c.emailSentAt) ok = timingSafeEqualHex(c.emailCodeHash, sha256(`${c.id}:${code.replace(/\s/g, '')}`));
    if (method === 'recovery' && user.totpEnabledAt) {
      const hash = recoveryCodeHash(code);
      if (user.recoveryCodes.includes(hash)) {
        ok = true;
        await this.ctx.db.update(users).set({ recoveryCodes: user.recoveryCodes.filter((h) => h !== hash) }).where(eq(users.id, user.id));
      }
    }
    if (!ok) {
      await this.failedAttempt(c);
      throw wrongCode();
    }
    await this.consume(c.id);
    return { userId: user.id, method };
  }

  /** Passkey as the second factor after the password. */
  async mfaPasskeyOptions(ticket: string) {
    const c = await this.challenge(ticket, 'mfa');
    const creds = await this.ctx.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, c.userId!));
    if (!creds.length) throw invalid('Bu hesapta kayıtlı passkey yok.');
    const options = await generateAuthenticationOptions({ rpID: this.rp.id, userVerification: 'required', allowCredentials: creds.map((k) => ({ id: k.credentialId, transports: k.transports })) });
    await this.ctx.db.update(loginChallenges).set({ challenge: options.challenge }).where(eq(loginChallenges.id, c.id));
    return options;
  }

  async mfaPasskeyVerify(ticket: string, response: AuthenticationResponseJSON) {
    const c = await this.challenge(ticket, 'mfa');
    const userId = await this.checkAssertion(c, response, c.userId!);
    await this.consume(c.id);
    return { userId, method: 'passkey' as const };
  }

  /** Passwordless sign-in with a passkey: the browser offers the passkeys it holds for this site. */
  async passkeyLoginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rp.id, userVerification: 'required' });
    const ticket = await this.createTicket('passkey', null, options.challenge);
    return { ticket, options };
  }

  async passkeyLoginVerify(ticket: string, response: AuthenticationResponseJSON) {
    const c = await this.challenge(ticket, 'passkey');
    const userId = await this.checkAssertion(c, response, null);
    await this.consume(c.id);
    return { userId, method: 'passkey' as const };
  }

  /* ---------------- account security (signed in) ---------------- */

  async summary(userId: string) {
    const user = await this.user(userId);
    const passkeys = await this.ctx.db
      .select({ id: webauthnCredentials.id, name: webauthnCredentials.name, deviceType: webauthnCredentials.deviceType, backedUp: webauthnCredentials.backedUp, createdAt: webauthnCredentials.createdAt, lastUsedAt: webauthnCredentials.lastUsedAt })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId))
      .orderBy(desc(webauthnCredentials.createdAt));
    return {
      totpEnabled: !!user.totpEnabledAt,
      totpEnabledAt: user.totpEnabledAt,
      recoveryCodesLeft: user.totpEnabledAt ? user.recoveryCodes.length : 0,
      emailCode: this.emailAvailable(),
      passkeys,
      rpId: this.rp.id,
    };
  }

  /** Starts authenticator app setup: a fresh secret that only becomes active after a valid code. */
  async totpSetup(userId: string, password: string) {
    const user = await this.user(userId);
    await this.requirePassword(user, password);
    const secret = generateTotpSecret();
    await this.ctx.db.update(users).set({ totpSecret: encryptToString(this.ctx.config.encryptionKey, secret), totpEnabledAt: null }).where(eq(users.id, userId));
    return { secret, uri: totpUri(secret, user.email) };
  }

  async totpEnable(userId: string, code: string) {
    const user = await this.user(userId);
    if (!user.totpSecret) throw invalid('Önce doğrulayıcı uygulama kurulumunu başlatın.');
    if (!verifyTotp(decryptFromString(this.ctx.config.encryptionKey, user.totpSecret), code)) throw invalid('Kod doğrulanamadı. Uygulamadaki güncel 6 haneli kodu girin.');
    const recovery = generateRecoveryCodes();
    await this.ctx.db.update(users).set({ totpEnabledAt: new Date(), recoveryCodes: recovery.hashes }).where(eq(users.id, userId));
    return { recoveryCodes: recovery.codes };
  }

  async totpDisable(userId: string, password: string) {
    const user = await this.user(userId);
    await this.requirePassword(user, password);
    await this.ctx.db.update(users).set({ totpSecret: null, totpEnabledAt: null, recoveryCodes: [] }).where(eq(users.id, userId));
  }

  async regenerateRecoveryCodes(userId: string, password: string) {
    const user = await this.user(userId);
    await this.requirePassword(user, password);
    if (!user.totpEnabledAt) throw invalid('Kurtarma kodları doğrulayıcı uygulama ile birlikte kullanılır.');
    const recovery = generateRecoveryCodes();
    await this.ctx.db.update(users).set({ recoveryCodes: recovery.hashes }).where(eq(users.id, userId));
    return { recoveryCodes: recovery.codes };
  }

  async passkeyRegisterOptions(userId: string) {
    const user = await this.user(userId);
    const existing = await this.ctx.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId));
    const options = await generateRegistrationOptions({
      rpName: this.rp.name,
      rpID: this.rp.id,
      userName: user.email,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.credentialId, transports: k.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const ticket = await this.createTicket('passkey_register', userId, options.challenge);
    return { ticket, options };
  }

  async passkeyRegister(userId: string, ticket: string, response: RegistrationResponseJSON, name: string) {
    const c = await this.challenge(ticket, 'passkey_register');
    if (c.userId !== userId) throw expired();
    const result = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge!, expectedOrigin: this.rp.origin, expectedRPID: this.rp.id, requireUserVerification: true }).catch((e: Error) => {
      throw invalid(`Passkey doğrulanamadı: ${e.message}`);
    });
    if (!result.verified) throw invalid('Passkey doğrulanamadı.');
    await this.consume(c.id);
    const cred = result.registrationInfo.credential;
    const row = (
      await this.ctx.db
        .insert(webauthnCredentials)
        .values({
          userId,
          credentialId: cred.id,
          publicKey: Buffer.from(cred.publicKey).toString('base64url'),
          counter: cred.counter,
          transports: cred.transports ?? [],
          deviceType: result.registrationInfo.credentialDeviceType,
          backedUp: result.registrationInfo.credentialBackedUp,
          name: name.trim().slice(0, 100) || 'Passkey',
        })
        .returning({ id: webauthnCredentials.id, name: webauthnCredentials.name })
    )[0]!;
    return row;
  }

  async deletePasskey(userId: string, id: string, password: string) {
    const user = await this.user(userId);
    await this.requirePassword(user, password);
    const deleted = await this.ctx.db.delete(webauthnCredentials).where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, userId))).returning({ id: webauthnCredentials.id });
    if (!deleted.length) throw notFound('Passkey');
  }

  /* ---------------- internals ---------------- */

  private async checkAssertion(c: typeof loginChallenges.$inferSelect, response: AuthenticationResponseJSON, expectedUser: string | null) {
    const cred = (await this.ctx.db.select().from(webauthnCredentials).where(eq(webauthnCredentials.credentialId, response.id)))[0];
    if (!cred || (expectedUser && cred.userId !== expectedUser) || !c.challenge) {
      await this.failedAttempt(c);
      throw new AppError('UNAUTHENTICATED', 'Bu passkey bu hesapta kayıtlı değil.');
    }
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: this.rp.origin,
      expectedRPID: this.rp.id,
      requireUserVerification: true,
      credential: { id: cred.credentialId, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: cred.counter, transports: cred.transports },
    }).catch(() => ({ verified: false as const, authenticationInfo: null }));
    if (!result.verified || !result.authenticationInfo) {
      await this.failedAttempt(c);
      throw new AppError('UNAUTHENTICATED', 'Passkey doğrulanamadı.');
    }
    await this.ctx.db.update(webauthnCredentials).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() }).where(eq(webauthnCredentials.id, cred.id));
    return cred.userId;
  }

  private async createTicket(kind: 'mfa' | 'passkey' | 'passkey_register', userId: string | null, challenge?: string) {
    const raw = randomToken(32);
    await this.ctx.db.delete(loginChallenges).where(or(lt(loginChallenges.expiresAt, new Date()), and(eq(loginChallenges.kind, kind), userId ? eq(loginChallenges.userId, userId) : isNull(loginChallenges.id))));
    await this.ctx.db.insert(loginChallenges).values({ userId, kind, ticketHash: sha256(raw), challenge: challenge ?? null, expiresAt: new Date(Date.now() + TICKET_MINUTES * 60_000) });
    return raw;
  }

  private async challenge(ticket: string, kind: 'mfa' | 'passkey' | 'passkey_register') {
    const c = (await this.ctx.db.select().from(loginChallenges).where(and(eq(loginChallenges.ticketHash, sha256(ticket)), eq(loginChallenges.kind, kind), isNull(loginChallenges.consumedAt), gt(loginChallenges.expiresAt, new Date()))))[0];
    if (!c || c.attempts >= MAX_ATTEMPTS) throw expired();
    return c;
  }

  private async failedAttempt(c: typeof loginChallenges.$inferSelect) {
    await this.ctx.db.update(loginChallenges).set({ attempts: c.attempts + 1 }).where(eq(loginChallenges.id, c.id));
  }

  private async consume(id: string) {
    const done = await this.ctx.db.update(loginChallenges).set({ consumedAt: new Date() }).where(and(eq(loginChallenges.id, id), isNull(loginChallenges.consumedAt))).returning({ id: loginChallenges.id });
    if (!done.length) throw expired();
  }

  private async user(id: string) {
    const u = (await this.ctx.db.select().from(users).where(eq(users.id, id)))[0];
    if (!u || u.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Hesabınız aktif değil.');
    return u;
  }

  private async requirePassword(user: User, password: string) {
    if (!(await verifyPassword(user.passwordHash, password))) throw invalid('Mevcut şifre hatalı.');
  }
}

/** e***@arucad.edu.tr: enough to recognise the address, not enough to harvest it. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name!.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, name!.length - 1)))}@${domain}`;
}
