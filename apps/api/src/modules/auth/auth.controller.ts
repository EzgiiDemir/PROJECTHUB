import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  acceptInviteSchema,
  changePasswordSchema,
  createApiTokenSchema,
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  notificationPreferencesSchema,
  updateProfileSchema,
} from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import { AuthGuard, SESSION_COOKIE } from '../../infra/auth.guard.js';
import { clientIp, type AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse, Public, RateLimiter } from '../../infra/http.js';
import { Mailer } from '../../infra/mailer.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';

const loginLimiter = new RateLimiter(20, 15 * 60_000);
const mfaLimiter = new RateLimiter(30, 15 * 60_000);
const ticketSchema = z.string().min(20).max(100);
const passwordConfirm = z.object({ password: z.string().min(1).max(256) });
/** WebAuthn JSON from the browser; the library verifies its content and signature. */
const webauthnResponse = z.looseObject({ id: z.string().min(1).max(1024), rawId: z.string().max(1024), type: z.literal('public-key'), response: z.record(z.string(), z.unknown()) });
const resetLimiter = new RateLimiter(5, 60 * 60_000);

const meta = (req: Request) => ({ ip: clientIp(req), userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly guard: AuthGuard,
    private readonly mailer: Mailer,
    private readonly mfa: MfaService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    loginLimiter.check(`${clientIp(req)}|${input.email.toLowerCase()}`);
    const user = await this.auth.checkPassword(input.email, input.password, meta(req));
    // A correct password alone does not sign in when the account has a second factor.
    const step = await this.mfa.begin(user);
    if (step) return step;
    return this.signIn(user.id, 'password', req, res);
  }

  /** Second step after the password: authenticator code, e-mailed code or recovery code. */
  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async mfaVerify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ ticket: ticketSchema, method: z.enum(['totp', 'email', 'recovery']), code: z.string().trim().min(6).max(40) }), body);
    mfaLimiter.check(clientIp(req) ?? 'unknown');
    const { userId, method } = await this.mfa.verify(input.ticket, input.method, input.code);
    return this.signIn(userId, `password+${method}`, req, res);
  }

  @Public()
  @Post('mfa/email')
  @HttpCode(200)
  mfaEmail(@Body() body: unknown, @Req() req: Request) {
    mfaLimiter.check(clientIp(req) ?? 'unknown');
    return this.mfa.sendEmailCode(parse(z.object({ ticket: ticketSchema }), body).ticket);
  }

  @Public()
  @Post('mfa/passkey/options')
  @HttpCode(200)
  mfaPasskeyOptions(@Body() body: unknown) {
    return this.mfa.mfaPasskeyOptions(parse(z.object({ ticket: ticketSchema }), body).ticket);
  }

  @Public()
  @Post('mfa/passkey/verify')
  @HttpCode(200)
  async mfaPasskeyVerify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ ticket: ticketSchema, response: webauthnResponse }), body);
    mfaLimiter.check(clientIp(req) ?? 'unknown');
    const { userId } = await this.mfa.mfaPasskeyVerify(input.ticket, input.response as never);
    return this.signIn(userId, 'password+passkey', req, res);
  }

  /** Passwordless sign-in with a passkey (fingerprint, Face ID, Windows Hello, security key). */
  @Public()
  @Post('passkey/options')
  @HttpCode(200)
  passkeyOptions(@Req() req: Request) {
    mfaLimiter.check(clientIp(req) ?? 'unknown');
    return this.mfa.passkeyLoginOptions();
  }

  @Public()
  @Post('passkey/verify')
  @HttpCode(200)
  async passkeyVerify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ ticket: ticketSchema, response: webauthnResponse }), body);
    mfaLimiter.check(clientIp(req) ?? 'unknown');
    const { userId } = await this.mfa.passkeyLoginVerify(input.ticket, input.response as never);
    return this.signIn(userId, 'passkey', req, res);
  }

  private async signIn(userId: string, method: string, req: Request, res: Response) {
    const session = await this.auth.completeLogin(userId, meta(req), method);
    res.cookie(SESSION_COOKIE, session.raw, this.guard.cookieOptions(session.expiresAt));
    const authInfo = await this.guard.fromSession(session.raw);
    return this.auth.me(authInfo!);
  }

  /* ---------------- account security (signed in) ---------------- */

  @Get('security')
  security(@Auth() a: AuthInfo) {
    return this.mfa.summary(a.user.id);
  }

  @Post('totp/setup')
  @HttpCode(200)
  totpSetup(@Auth() a: AuthInfo, @Body() body: unknown) {
    return this.mfa.totpSetup(a.user.id, parse(passwordConfirm, body).password);
  }

  @Post('totp/enable')
  @HttpCode(200)
  async totpEnable(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    const out = await this.mfa.totpEnable(a.user.id, parse(z.object({ code: z.string().trim().min(6).max(10) }), body).code);
    await this.auth.securityAudit(a, actor, 'auth.totp_enabled');
    return out;
  }

  @Post('totp/disable')
  @HttpCode(200)
  async totpDisable(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    await this.mfa.totpDisable(a.user.id, parse(passwordConfirm, body).password);
    await this.auth.securityAudit(a, actor, 'auth.totp_disabled');
    return { ok: true };
  }

  @Post('recovery-codes')
  @HttpCode(200)
  async recoveryCodes(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    const out = await this.mfa.regenerateRecoveryCodes(a.user.id, parse(passwordConfirm, body).password);
    await this.auth.securityAudit(a, actor, 'auth.recovery_codes_regenerated');
    return out;
  }

  @Post('passkeys/options')
  @HttpCode(200)
  passkeyRegisterOptions(@Auth() a: AuthInfo) {
    return this.mfa.passkeyRegisterOptions(a.user.id);
  }

  @Post('passkeys')
  async passkeyRegister(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(z.object({ ticket: ticketSchema, response: webauthnResponse, name: z.string().trim().max(100).default('') }), body);
    const out = await this.mfa.passkeyRegister(a.user.id, input.ticket, input.response as never, input.name);
    await this.auth.securityAudit(a, actor, 'auth.passkey_added', { name: out.name });
    return out;
  }

  @Post('passkeys/:id/delete')
  @HttpCode(200)
  async passkeyDelete(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    await this.mfa.deletePasskey(a.user.id, assertUuid(id, 'Passkey'), parse(passwordConfirm, body).password);
    await this.auth.securityAudit(a, actor, 'auth.passkey_removed');
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(a, actor);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@Auth() a: AuthInfo) {
    return this.auth.me(a);
  }

  @Public()
  @Get('config')
  config() {
    return { smtpEnabled: this.mailer.enabled };
  }

  @Post('switch-organization')
  @HttpCode(200)
  async switchOrg(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), body);
    await this.auth.switchOrganization(a, organizationId, actor);
    return { ok: true };
  }

  @Public()
  @Get('invitations/:token')
  invitation(@Param('token') token: string) {
    return this.auth.describeInvitation(token);
  }

  @Public()
  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(acceptInviteSchema, body);
    const session = await this.auth.acceptInvitation(input, meta(req));
    res.cookie(SESSION_COOKIE, session.raw, this.guard.cookieOptions(session.expiresAt));
    return { ok: true };
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(200)
  async requestReset(@Body() body: unknown, @Req() req: Request) {
    const { email } = parse(requestPasswordResetSchema, body);
    resetLimiter.check(`${clientIp(req)}`);
    if (this.mailer.enabled) {
      const target = await this.auth.requestPasswordReset(email);
      if (target) {
        const link = await this.auth.issueToken(target.user.id, target.organizationId, 'password_reset', null);
        await this.mailer.send(
          target.user.email,
          'Project Hub şifre sıfırlama',
          `Merhaba ${target.user.displayName},\n\nŞifrenizi sıfırlamak için bağlantı (${link.expiresInHours} saat geçerli):\n${link.url}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayın.`,
        );
      }
    }
    // Same answer whether or not the account exists.
    return { ok: true, emailEnabled: this.mailer.enabled };
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(200)
  async confirmReset(@Body() body: unknown, @Req() req: Request) {
    await this.auth.resetPassword(parse(resetPasswordSchema, body), meta(req));
    return { ok: true };
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(changePasswordSchema, body);
    await this.auth.changePassword(a, input.currentPassword, input.newPassword, actor);
    return { ok: true };
  }

  @Patch('profile')
  profile(@Auth() a: AuthInfo, @Body() body: unknown) {
    return this.auth.updateProfile(a, parse(updateProfileSchema, body));
  }

  @Get('notification-preferences')
  notificationPreferences(@Auth() a: AuthInfo) {
    return this.auth.notificationPreferences(a);
  }

  /** Replaces the user's preferences (categories left out fall back to the defaults). */
  @Put('notification-preferences')
  setNotificationPreferences(@Auth() a: AuthInfo, @Body() body: unknown) {
    return this.auth.setNotificationPreferences(a, parse(notificationPreferencesSchema, body));
  }

  @Get('sessions')
  sessions(@Auth() a: AuthInfo) {
    return this.auth.listSessions(a);
  }

  @Delete('sessions/:id')
  async revokeSession(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.auth.revokeSession(a, assertUuid(id, 'Oturum'), actor);
    return { ok: true };
  }

  @Get('tokens')
  tokens(@Auth() a: AuthInfo) {
    return this.auth.listTokens(a);
  }

  @Post('tokens')
  createToken(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.auth.createToken(a, parse(createApiTokenSchema, body), actor);
  }

  @Delete('tokens/:id')
  async revokeToken(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.auth.revokeToken(a, assertUuid(id, 'Token'), actor);
    return { ok: true };
  }
}
