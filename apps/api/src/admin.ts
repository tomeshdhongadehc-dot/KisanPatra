// Admin & operations: user lifecycle and dashboard counts. Every query is scoped to the actor's organisation.
// Audit entries carry ids and roles only, never emails, names or passwords.
import { Inject, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import * as argon2 from "argon2";
import crypto from "node:crypto";
import { z } from "zod";
import { Audit, Prisma } from "./core";
import { AuthUser, CurrentUser, Roles } from "./auth";

const ASSIGNABLE = ["ADMIN", "OPERATOR", "VERIFIER", "VIEWER", "AUDITOR"] as const;
const CreateDto = z.object({ email: z.string().email().max(200), displayName: z.string().min(2).max(100), role: z.enum(ASSIGNABLE), mobile: z.string().regex(/^[6-9]\d{9}$/).optional() }).strict();
const PatchDto = z.object({ role: z.enum(ASSIGNABLE).optional(), status: z.enum(["ACTIVE", "SUSPENDED"]).optional(), displayName: z.string().min(2).max(100).optional() }).strict();

// unambiguous characters only (no 0/O, 1/l/I): temp passwords get read aloud / typed from paper
const TEMP_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export function tempPassword(): string {
  const pick = () => TEMP_ALPHA[crypto.randomInt(TEMP_ALPHA.length)];
  const group = () => Array.from({ length: 4 }, pick).join("");
  return `${group()}-${group()}-${group()}-${group()}`; // ~93 bits, satisfies the password policy (length >= 12, 3 character classes in practice via retry below)
}
const strongTemp = (): string => { for (;;) { const p = tempPassword(); if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) return p; } };

@Controller("admin")
export class AdminController {
  constructor(@Inject(Prisma) private readonly db: Prisma, @Inject(Audit) private readonly audit: Audit) {}

  private async target(id: string, actor: AuthUser) {
    const t = await this.db.user.findFirst({ where: { id, orgId: actor.orgId } });
    if (!t) throw new NotFoundException();
    if (t.role === "SUPER_ADMIN" && actor.role !== "SUPER_ADMIN") throw new ForbiddenException(); // admins cannot touch the super admin
    return t;
  }
  private rowOf(u: any) {
    return { id: u.id, email: u.email, mobile: u.mobile, displayName: u.displayName, role: u.role, status: u.status, mfaEnabled: u.mfaEnabled, mustChangePassword: u.mustChangePassword, locked: !!u.lockedUntil && u.lockedUntil > new Date(), createdAt: u.createdAt };
  }

  @Get("users") @Roles("ADMIN")
  async users(@CurrentUser() a: AuthUser) {
    const rows = await this.db.user.findMany({ where: { orgId: a.orgId }, orderBy: { createdAt: "asc" } });
    return rows.map((u) => this.rowOf(u));
  }

  @Post("users") @Roles("ADMIN") @HttpCode(201)
  async create(@Body() body: unknown, @CurrentUser() a: AuthUser) {
    const dto = CreateDto.parse(body);
    const email = dto.email.toLowerCase();
    if (await this.db.user.findFirst({ where: { orgId: a.orgId, email } })) throw new ConflictException({ message: "EMAIL_EXISTS" });
    if (dto.mobile && (await this.db.user.findFirst({ where: { orgId: a.orgId, mobile: dto.mobile } }))) throw new ConflictException({ message: "MOBILE_EXISTS" });
    const temp = strongTemp();
    const u = await this.db.user.create({ data: { orgId: a.orgId, email, mobile: dto.mobile, displayName: dto.displayName, role: dto.role, status: "ACTIVE", mustChangePassword: true, passwordHash: await argon2.hash(temp, { type: argon2.argon2id }) } });
    await this.audit.log({ orgId: a.orgId, actorId: a.id, action: "admin.user.create", entityType: "user", entityId: u.id, meta: { role: dto.role } });
    return { user: this.rowOf(u), tempPassword: temp }; // shown once; the user must change it at first login
  }

  @Patch("users/:id") @Roles("ADMIN")
  async update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown, @CurrentUser() a: AuthUser) {
    const dto = PatchDto.parse(body);
    const t = await this.target(id, a);
    if (t.id === a.id && (dto.role || dto.status)) throw new ForbiddenException({ message: "CANNOT_MODIFY_SELF" }); // no self-demotion / self-lockout
    const u = await this.db.user.update({ where: { id }, data: { role: dto.role, status: dto.status, displayName: dto.displayName } });
    if (dto.status === "SUSPENDED" || (dto.role && dto.role !== t.role)) await this.db.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); // takes effect immediately
    await this.audit.log({ orgId: a.orgId, actorId: a.id, action: "admin.user.update", entityType: "user", entityId: id, meta: { role: dto.role, status: dto.status } });
    return this.rowOf(u);
  }

  @Post("users/:id/reset-password") @Roles("ADMIN") @HttpCode(200)
  async resetPassword(@Param("id", new ParseUUIDPipe()) id: string, @CurrentUser() a: AuthUser) {
    const t = await this.target(id, a);
    if (t.id === a.id) throw new ForbiddenException({ message: "CANNOT_MODIFY_SELF" }); // use change-password for your own account
    const temp = strongTemp();
    await this.db.user.update({ where: { id }, data: { passwordHash: await argon2.hash(temp, { type: argon2.argon2id }), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
    await this.db.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ orgId: a.orgId, actorId: a.id, action: "admin.user.reset_password", entityType: "user", entityId: id });
    return { tempPassword: temp };
  }

  @Post("users/:id/reset-mfa") @Roles("ADMIN") @HttpCode(204)
  async resetMfa(@Param("id", new ParseUUIDPipe()) id: string, @CurrentUser() a: AuthUser) {
    const t = await this.target(id, a);
    if (t.id === a.id) throw new ForbiddenException({ message: "CANNOT_MODIFY_SELF" });
    await this.db.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaLastStep: null, mfaRecoveryHashes: [] } });
    await this.db.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ orgId: a.orgId, actorId: a.id, action: "admin.user.reset_mfa", entityType: "user", entityId: id });
  }

  @Post("users/:id/unlock") @Roles("ADMIN") @HttpCode(204)
  async unlock(@Param("id", new ParseUUIDPipe()) id: string, @CurrentUser() a: AuthUser) {
    await this.target(id, a);
    await this.db.user.update({ where: { id }, data: { failedLogins: 0, lockedUntil: null } });
    await this.audit.log({ orgId: a.orgId, actorId: a.id, action: "admin.user.unlock", entityType: "user", entityId: id });
  }

  /** Counts only: no personal data leaves this endpoint. */
  @Get("stats") @Roles("ADMIN", "AUDITOR")
  async stats(@CurrentUser() a: AuthUser) {
    const org = a.orgId, dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [docs, farmers, cards, jobs, queued, failed24, users, locked] = await Promise.all([
      this.db.sourceDocument.groupBy({ by: ["status"], where: { orgId: org }, _count: true }),
      this.db.farmer.groupBy({ by: ["trustLevel"], where: { orgId: org }, _count: true }),
      this.db.card.groupBy({ by: ["status"], where: { farmer: { orgId: org } }, _count: true }),
      this.db.extractionJob.groupBy({ by: ["status"], where: { document: { orgId: org } }, _count: true }),
      this.db.extractionJob.findFirst({ where: { status: "QUEUED", document: { orgId: org } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      this.db.sourceDocument.count({ where: { orgId: org, status: "FAILED", createdAt: { gte: dayAgo } } }),
      this.db.user.groupBy({ by: ["role"], where: { orgId: org, status: "ACTIVE" }, _count: true }),
      this.db.user.count({ where: { orgId: org, lockedUntil: { gt: new Date() } } }),
    ]);
    const m = (rows: any[], k: string) => Object.fromEntries(rows.map((r) => [r[k], r._count]));
    return {
      documents: m(docs, "status"), farmersByTrust: m(farmers, "trustLevel"), cards: m(cards, "status"), jobs: m(jobs, "status"),
      oldestQueuedSeconds: queued ? Math.round((Date.now() - queued.createdAt.getTime()) / 1000) : 0,
      failedLast24h: failed24, activeUsersByRole: m(users, "role"), lockedUsers: locked,
    };
  }
}
