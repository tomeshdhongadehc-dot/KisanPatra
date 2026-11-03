import { Inject, Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpCode, Injectable, Post, Req, Res, SetMetadata, UnauthorizedException, UseGuards, ConflictException, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import * as argon2 from "argon2";
import * as QRCode from "qrcode";
import type { Request, Response } from "express";
import { z } from "zod";
import { Audit, Prisma, config, dec, enc, randomToken, sha256 } from "./core";
import { b32decode, b32encode, newRecoveryCodes, newSecret, normRecovery, otpauthUri, verifyTotp } from "./totp";

export type Role = "SUPER_ADMIN" | "ADMIN" | "OPERATOR" | "VERIFIER" | "VIEWER" | "AUDITOR";
export interface AuthUser { id: string; orgId: string; role: Role; displayName: string; mustChangePassword: boolean; mfaEnabled: boolean; mfaSetupRequired: boolean }

const COOKIE = "agri_session";
const SESSION_HOURS = 8;
// Roles that must use MFA. Empty in dev so tests run unattended; set MFA_REQUIRED_ROLES=ADMIN,VERIFIER in production.
const MFA_REQUIRED_ROLES = (process.env.MFA_REQUIRED_ROLES ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export const Roles = (...roles: Role[]) => SetMetadata("roles", roles);
export const Public = () => SetMetadata("public", true);
/** Routes a restricted session (must change password / must set up MFA) may still call. */
export const AllowRestricted = () => SetMetadata("restricted-ok", true);
export const CurrentUser = createParamDecorator((_d, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as AuthUser);

// ---------- password policy ----------
const COMMON = ["password", "passw0rd", "qwerty", "123456", "letmein", "welcome", "admin", "iloveyou", "changeme", "abc123"];
export function passwordProblem(pw: string, ctx: { email?: string | null; displayName?: string; current?: string }): string | null {
  if (pw.length < 12) return "PASSWORD_TOO_SHORT";
  if (pw.length > 200) return "PASSWORD_TOO_LONG";
  const lower = pw.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) return "PASSWORD_TOO_COMMON";
  const local = ctx.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return "PASSWORD_CONTAINS_IDENTIFIER";
  if (/^(.)\1+$/.test(pw)) return "PASSWORD_TOO_COMMON";
  if (ctx.current && pw === ctx.current) return "PASSWORD_UNCHANGED";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return "PASSWORD_TOO_SIMPLE";
  return null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Prisma) private readonly db: Prisma, @Inject(Reflector) private readonly reflector: Reflector, @Inject(Audit) private readonly audit: Audit) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler(), cls = ctx.getClass();
    if (this.reflector.getAllAndOverride<boolean>("public", [handler, cls])) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    // CSRF: cookie-authenticated mutations must come from our web origin.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (!origin || origin !== config.webOrigin) throw new ForbiddenException("Bad origin");
    }
    const raw = (req as any).cookies?.[COOKIE] as string | undefined;
    if (!raw) throw new UnauthorizedException();
    const s = await this.db.session.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
    if (!s || s.revokedAt || s.expiresAt < new Date() || s.user.status !== "ACTIVE") throw new UnauthorizedException();
    const u = s.user;
    const mfaSetupRequired = MFA_REQUIRED_ROLES.includes(u.role) && !u.mfaEnabled;
    req.user = { id: u.id, orgId: u.orgId, role: u.role as Role, displayName: u.displayName, mustChangePassword: u.mustChangePassword, mfaEnabled: u.mfaEnabled, mfaSetupRequired };

    // A temp/reset password or missing mandatory MFA leaves the session able to do only what fixes that.
    if ((u.mustChangePassword || mfaSetupRequired) && !this.reflector.getAllAndOverride<boolean>("restricted-ok", [handler, cls])) {
      throw new ForbiddenException(u.mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "MFA_SETUP_REQUIRED");
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>("roles", [handler, cls]);
    if (roles && roles.length && !roles.includes(req.user.role) && req.user.role !== "SUPER_ADMIN") {
      await this.audit.log({ orgId: req.user.orgId, actorId: req.user.id, action: `${req.method} ${req.route?.path}`, entityType: "route", outcome: "DENIED" });
      throw new ForbiddenException();
    }
    return true;
  }
}

// simple in-memory limiter (per key); replace with shared store when scaling out
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr); return true;
  }
}
const loginLimiter = new RateLimiter(Number(process.env.LOGIN_RATE_MAX ?? 10), 15 * 60_000);
const sensitiveLimiter = new RateLimiter(8, 15 * 60_000); // change-password / mfa disable: per user

const LoginDto = z.object({ identifier: z.string().min(3).max(200), password: z.string().min(8).max(200), totp: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(20).optional() }).strict();
const ChangePwDto = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) }).strict();
const MfaEnableDto = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const MfaDisableDto = z.object({ password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(20).optional() }).strict();

@Controller("auth")
export class AuthController {
  constructor(@Inject(Prisma) private readonly db: Prisma, @Inject(Audit) private readonly audit: Audit) {}

  private currentTokenHash(req: Request) { return sha256((req as any).cookies?.[COOKIE] ?? ""); }

  /** Checks a TOTP or recovery code for a user. Consumes the step / recovery code on success. */
  private async checkSecondFactor(user: { id: string; mfaSecretEnc: string | null; mfaLastStep: number | null; mfaRecoveryHashes: string[] }, totp?: string, recovery?: string): Promise<boolean> {
    if (totp && user.mfaSecretEnc) {
      const step = verifyTotp(b32decode(dec(user.mfaSecretEnc)!), totp, user.mfaLastStep);
      if (step === null) return false;
      await this.db.user.update({ where: { id: user.id }, data: { mfaLastStep: step } });
      return true;
    }
    if (recovery) {
      const h = sha256(normRecovery(recovery));
      if (!user.mfaRecoveryHashes.includes(h)) return false;
      await this.db.user.update({ where: { id: user.id }, data: { mfaRecoveryHashes: user.mfaRecoveryHashes.filter((x) => x !== h) } });
      return true;
    }
    return false;
  }

  @Public() @Post("login") @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const origin = req.headers.origin;
    if (origin !== config.webOrigin) throw new ForbiddenException("Bad origin");
    const dto = LoginDto.parse(body);
    if (!loginLimiter.allow(`${req.ip}|${dto.identifier.toLowerCase()}`)) throw new ForbiddenException("Too many attempts");
    const user = await this.db.user.findFirst({ where: { OR: [{ email: dto.identifier.toLowerCase() }, { mobile: dto.identifier }] } });
    const fail = async (reason: string) => {
      if (user) await this.audit.log({ orgId: user.orgId, actorId: user.id, action: "auth.login", entityType: "user", entityId: user.id, outcome: "FAILURE", meta: { reason } });
      throw new UnauthorizedException("Invalid credentials");
    };
    const countFailure = async () => {
      const failed = user!.failedLogins + 1;
      await this.db.user.update({ where: { id: user!.id }, data: { failedLogins: failed, lockedUntil: failed >= 6 ? new Date(Date.now() + 15 * 60_000) : null } });
    };
    if (!user || user.status !== "ACTIVE") { await argon2.hash("timing-equalizer"); return fail("unknown_or_inactive"); }
    if (user.lockedUntil && user.lockedUntil > new Date()) return fail("locked");
    if (!(await argon2.verify(user.passwordHash, dto.password))) { await countFailure(); return fail("bad_password"); }

    if (user.mfaEnabled) {
      if (!dto.totp && !dto.recoveryCode) throw new UnauthorizedException({ message: "MFA_REQUIRED" }); // password was right; ask for the second factor
      if (!(await this.checkSecondFactor(user, dto.totp, dto.recoveryCode))) { await countFailure(); return fail("bad_mfa"); }
    }
    await this.db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    const token = randomToken(32);
    await this.db.session.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000), userAgent: (req.headers["user-agent"] ?? "").slice(0, 200) } });
    res.cookie(COOKIE, token, { httpOnly: true, secure: config.isProd, sameSite: "lax", maxAge: SESSION_HOURS * 3600_000, path: "/" });
    await this.audit.log({ orgId: user.orgId, actorId: user.id, action: "auth.login", entityType: "user", entityId: user.id, meta: { mfa: user.mfaEnabled, recovery: !!dto.recoveryCode } });
    return { id: user.id, displayName: user.displayName, role: user.role, locale: user.locale, mustChangePassword: user.mustChangePassword, mfaSetupRequired: MFA_REQUIRED_ROLES.includes(user.role) && !user.mfaEnabled };
  }

  @Post("logout") @HttpCode(204) @AllowRestricted()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req as any).cookies?.[COOKIE];
    if (raw) await this.db.session.updateMany({ where: { tokenHash: sha256(raw) }, data: { revokedAt: new Date() } });
    res.clearCookie(COOKIE, { path: "/" });
  }

  @Get("me") @AllowRestricted()
  me(@CurrentUser() u: AuthUser) { return u; }

  @Post("change-password") @HttpCode(204) @AllowRestricted()
  async changePassword(@Body() body: unknown, @Req() req: Request, @CurrentUser() u: AuthUser) {
    const dto = ChangePwDto.parse(body);
    if (!sensitiveLimiter.allow(`pw|${u.id}`)) throw new ForbiddenException("Too many attempts");
    const user = await this.db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!(await argon2.verify(user.passwordHash, dto.current))) {
      await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "auth.change_password", entityType: "user", entityId: u.id, outcome: "FAILURE", meta: { reason: "bad_current" } });
      throw new UnauthorizedException("Invalid credentials");
    }
    const problem = passwordProblem(dto.next, { email: user.email, displayName: user.displayName, current: dto.current });
    if (problem) throw new ConflictException({ message: problem });
    await this.db.user.update({ where: { id: u.id }, data: { passwordHash: await argon2.hash(dto.next, { type: argon2.argon2id }), mustChangePassword: false } });
    // every other session of this user ends: a stolen session does not survive a password change
    await this.db.session.updateMany({ where: { userId: u.id, revokedAt: null, tokenHash: { not: this.currentTokenHash(req) } }, data: { revokedAt: new Date() } });
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "auth.change_password", entityType: "user", entityId: u.id });
  }

  // ---------- MFA (TOTP) ----------
  @Post("mfa/setup") @AllowRestricted()
  async mfaSetup(@CurrentUser() u: AuthUser) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (user.mfaEnabled) throw new ConflictException({ message: "MFA_ALREADY_ENABLED" });
    const secret = b32encode(newSecret());
    await this.db.user.update({ where: { id: u.id }, data: { mfaSecretEnc: enc(secret), mfaEnabled: false } }); // not active until a code is confirmed
    const uri = otpauthUri(secret, user.email ?? user.mobile ?? user.id, "Agri Card");
    const qr = `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 2 })).toString("base64")}`;
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "auth.mfa_setup", entityType: "user", entityId: u.id });
    return { secret, otpauthUri: uri, qr };
  }

  @Post("mfa/enable") @AllowRestricted()
  async mfaEnable(@Body() body: unknown, @CurrentUser() u: AuthUser) {
    const dto = MfaEnableDto.parse(body);
    if (!sensitiveLimiter.allow(`mfa|${u.id}`)) throw new ForbiddenException("Too many attempts");
    const user = await this.db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (user.mfaEnabled) throw new ConflictException({ message: "MFA_ALREADY_ENABLED" });
    if (!user.mfaSecretEnc) throw new ConflictException({ message: "MFA_NOT_STARTED" });
    const step = verifyTotp(b32decode(dec(user.mfaSecretEnc)!), dto.code, null);
    if (step === null) throw new UnauthorizedException({ message: "MFA_CODE_INVALID" });
    const codes = newRecoveryCodes();
    await this.db.user.update({ where: { id: u.id }, data: { mfaEnabled: true, mfaLastStep: step, mfaRecoveryHashes: codes.map((c) => sha256(normRecovery(c))) } });
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "auth.mfa_enable", entityType: "user", entityId: u.id });
    return { recoveryCodes: codes }; // shown once; only hashes are stored
  }

  @Post("mfa/disable") @HttpCode(204) @AllowRestricted()
  async mfaDisable(@Body() body: unknown, @CurrentUser() u: AuthUser) {
    const dto = MfaDisableDto.parse(body);
    if (!sensitiveLimiter.allow(`mfa|${u.id}`)) throw new ForbiddenException("Too many attempts");
    if (MFA_REQUIRED_ROLES.includes(u.role)) throw new ForbiddenException("MFA_REQUIRED_BY_POLICY");
    const user = await this.db.user.findUniqueOrThrow({ where: { id: u.id } });
    if (!user.mfaEnabled) throw new ConflictException({ message: "MFA_NOT_ENABLED" });
    if (!(await argon2.verify(user.passwordHash, dto.password)) || !(await this.checkSecondFactor(user, dto.totp, dto.recoveryCode))) {
      await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "auth.mfa_disable", entityType: "user", entityId: u.id, outcome: "FAILURE" });
      throw new UnauthorizedException("Invalid credentials");
    }
    await this.db.user.update({ where: { id: u.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaLastStep: null, mfaRecoveryHashes: [] } });
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "auth.mfa_disable", entityType: "user", entityId: u.id });
  }
}

export { UseGuards, COOKIE };
