import { Inject, BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import * as QRCode from "qrcode";
import { chromium } from "playwright-core";
import { z } from "zod";
import { Audit, Prisma, Storage, blindIndex, config, dec, normName, randomToken, sha256 } from "./core";
import { AuthUser, CurrentUser, Public, RateLimiter, Roles } from "./auth";
import { CardData, cardHtml, sheetHtml } from "./cardhtml";

const TRUST_LABEL: Record<string, [string, string]> = {
  L0_DRAFT: ["मसुदा", "Draft"], L1_SUBMITTED: ["सादर", "Submitted"], L2_DOCUMENT_REVIEWED: ["कागदपत्रे तपासली", "Document reviewed"],
  L3_OFFICIALLY_VERIFIED: ["अधिकृत पडताळणी", "Officially verified"], L4_REVERIFICATION_REQUIRED: ["पुनर्पडताळणी आवश्यक", "Reverification required"],
};
const fmtDate = (iso: string | null) => (iso ? iso.split("-").reverse().join("-") : "");

@Injectable()
export class Cards {
  constructor(@Inject(Prisma) private readonly db: Prisma, @Inject(Storage) private readonly storage: Storage) {}

  async issue(farmerId: string, actor: AuthUser) {
    const f = await this.db.farmer.findFirstOrThrow({
      where: { id: farmerId, orgId: actor.orgId },
      include: { identity: true, contact: true, addresses: true, rights: { include: { parcel: true } }, documents: { include: { jobs: { include: { fields: true } } } } },
    });
    if (f.trustLevel !== "L2_DOCUMENT_REVIEWED") throw new ConflictException("Card requires trust level L2");

    const last = await this.db.card.findFirst({ where: { farmerId }, orderBy: { version: "desc" } });
    const version = (last?.version ?? 0) + 1;
    // 128-bit (22 chars): still unguessable (stored only as SHA-256, lookup is rate-limited), and it keeps the QR at 33x33 modules instead of 37x37,
    // i.e. larger modules at 24 mm: measured poor-print decode rate 60% -> 100%. Cards issued earlier carry 43-char tokens and stay valid.
    const token = randomToken(16); // plaintext exists only inside the QR
    const url = `${config.publicBaseUrl}/verify/${token}`;
    // Vector QR: stays sharp at any print resolution (a raster PNG gets resampled and blurred by PDF viewers/printers). Level M: higher levels make the code denser and scan worse at card size.
    const qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 4 })).toString("base64")}`;

    const photoKey = f.documents.flatMap((d) => d.jobs.flatMap((j) => j.fields)).find((x) => x.fieldKey === "photo_key");
    let photoDataUrl: string | null = null;
    if (photoKey) photoDataUrl = `data:image/jpeg;base64,${(await this.storage.get(dec(photoKey.normValueEnc)!)).toString("base64")}`;
    const addr = f.addresses[0];
    const [mr, en] = TRUST_LABEL[f.trustLevel];
    const parcels = f.rights.map((r) => ({ survey: r.parcel.surveyValue, village: r.parcel.village, taluka: r.parcel.subDistrict ?? "", district: r.parcel.district }));
    const dobIso = dec(f.identity!.dobEnc);
    const data: CardData = {
      platformId: f.platformId, nameLocal: f.identity!.nameLocal ?? f.identity!.nameEn, nameEn: f.identity!.nameEn, dob: fmtDate(dobIso), gender: f.identity!.gender ?? "OTHER",
      mobile: dec(f.contact?.mobileEnc) ?? "", trustLabelMr: mr, trustLabelEn: en, issuedOn: new Date().toISOString().slice(0, 10).split("-").reverse().join("-"), version,
      addressLocal: dec(addr?.addressLocalEnc) ?? "", addressEn: dec(addr?.addressEnEnc) ?? "", photoDataUrl, qrDataUrl, parcels: parcels.slice(0, 2), parcelCount: parcels.length,
    };

    const { png, pdf, a4 } = await this.render(cardHtml(data), sheetHtml(data));
    const [pngKey, pdfKey, a4Key] = [await this.storage.put(png, "png"), await this.storage.put(pdf, "pdf"), await this.storage.put(a4, "pdf")];
    return this.db.$transaction(async (tx) => {
      await tx.card.updateMany({ where: { farmerId, status: "ACTIVE" }, data: { status: "SUPERSEDED" } });
      await tx.verificationToken.updateMany({ where: { card: { farmerId }, status: "ACTIVE" }, data: { status: "SUPERSEDED" } });
      const card = await tx.card.create({
        data: { farmerId, version, status: "ACTIVE", trustLevelAtIssue: f.trustLevel, templateVersion: "card-v1", snapshotJson: { platformId: f.platformId, parcelCount: parcels.length, version }, pngKey, pvcPdfKey: pdfKey, a4PdfKey: a4Key, issuedAt: new Date(), issuedById: actor.id },
      });
      await tx.verificationToken.create({ data: { cardId: card.id, tokenHash: sha256(token), status: "ACTIVE" } });
      return { cardId: card.id, version, verifyUrl: url };
    });
  }

  private async render(html: string, sheet: string): Promise<{ png: Buffer; pdf: Buffer; a4: Buffer }> {
    const browser = await chromium.launch({ executablePath: config.chromePath, headless: true, args: ["--disable-extensions"] });
    try {
      const ctx = await browser.newContext({ deviceScaleFactor: 4, viewport: { width: 400, height: 260 }, javaScriptEnabled: false, offline: true });
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const png = await page.locator("#front").screenshot({ type: "png" });
      const pdf = await page.pdf({ width: "85.6mm", height: "54mm", printBackground: true, preferCSSPageSize: true });
      const sp = await ctx.newPage();
      await sp.setContent(sheet, { waitUntil: "load" });
      const a4 = await sp.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
      return { png, pdf, a4 };
    } finally {
      await browser.close();
    }
  }
}

const RevokeDto = z.object({ reason: z.string().min(3).max(200) }).strict();

@Controller("farmers")
export class FarmersController {
  constructor(@Inject(Prisma) private readonly db: Prisma, @Inject(Audit) private readonly audit: Audit, @Inject(Cards) private readonly cards: Cards, @Inject(Storage) private readonly storage: Storage) {}

  private async load(id: string, u: AuthUser) {
    const f = await this.db.farmer.findFirst({ where: { id, orgId: u.orgId }, include: { identity: true, contact: true, addresses: true, linkedIds: true, rights: { include: { parcel: true } }, cards: { orderBy: { version: "desc" } } } });
    if (!f || (u.role === "OPERATOR" && f.createdById !== u.id)) throw new NotFoundException();
    return f;
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query("q") q?: string) {
    const norm = normName(q);
    const where: any = { orgId: u.orgId, ...(u.role === "OPERATOR" ? { createdById: u.id } : {}) };
    if (q) where.OR = [{ platformId: { equals: q.toUpperCase() } }, { identity: { OR: [{ nameEnNorm: { contains: norm } }, { nameLocalNorm: { contains: norm } }] } }, { contact: { mobileIdx: blindIndex(q) } }];
    const rows = await this.db.farmer.findMany({ where, include: { identity: true }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map((r) => ({ id: r.id, platformId: r.platformId, nameEn: r.identity?.nameEn, nameLocal: r.identity?.nameLocal, trustLevel: r.trustLevel, status: r.status }));
  }

  @Get(":id")
  async get(@Param("id") id: string, @CurrentUser() u: AuthUser) {
    const f = await this.load(id, u);
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "farmer.read", entityType: "farmer", entityId: id });
    return {
      id: f.id, platformId: f.platformId, trustLevel: f.trustLevel, status: f.status, farmerType: f.farmerType, submittedById: f.submittedById,
      identity: f.identity && { nameEn: f.identity.nameEn, nameLocal: f.identity.nameLocal, gender: f.identity.gender, dob: dec(f.identity.dobEnc) },
      mobile: dec(f.contact?.mobileEnc), email: dec(f.contact?.emailEnc),
      address: f.addresses[0] && { en: dec(f.addresses[0].addressEnEnc), local: dec(f.addresses[0].addressLocalEnc) },
      linkedIds: f.linkedIds.map((l) => ({ scheme: l.scheme, value: dec(l.valueEnc), verified: l.verified })),
      parcels: f.rights.map((r) => ({ rightId: r.id, relationship: r.relationship, state: r.parcel.state, district: r.parcel.district, subDistrict: r.parcel.subDistrict, village: r.parcel.village, survey: r.parcel.surveyValue, areaAssignedHa: r.areaAssignedHa?.toString() ?? null, ownerNameOnRecord: r.ownerNameOnRecord })),
      cards: f.cards.map((c) => ({ id: c.id, version: c.version, status: c.status, issuedAt: c.issuedAt })),
    };
  }

  /** L1 -> L2 by a different user with VERIFIER (or ADMIN) role; issues the card. */
  @Post(":id/approve") @Roles("VERIFIER", "ADMIN")
  async approve(@Param("id") id: string, @CurrentUser() u: AuthUser) {
    const f = await this.load(id, u);
    if (f.trustLevel !== "L1_SUBMITTED") throw new ConflictException("Farmer is not awaiting approval");
    if (f.submittedById === u.id) {
      await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "farmer.approve", entityType: "farmer", entityId: id, outcome: "DENIED", meta: { reason: "four_eyes" } });
      throw new ForbiddenException("Submitter cannot approve own record");
    }
    await this.db.$transaction([
      this.db.farmer.update({ where: { id }, data: { trustLevel: "L2_DOCUMENT_REVIEWED" } }),
      this.db.approvalEvent.create({ data: { farmerId: id, fromLevel: "L1_SUBMITTED", toLevel: "L2_DOCUMENT_REVIEWED", actorId: u.id, checklist: { documentCompared: true } } }),
    ]);
    const card = await this.cards.issue(id, u);
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "farmer.approve", entityType: "farmer", entityId: id, meta: { cardId: card.cardId } });
    return { trustLevel: "L2_DOCUMENT_REVIEWED", ...card };
  }

  @Get(":id/card")
  async card(@Param("id") id: string, @Query("format") format: string | undefined, @CurrentUser() u: AuthUser, @Res() res: Response) {
    const f = await this.load(id, u);
    const c = f.cards.find((x) => x.status === "ACTIVE");
    if (!c) throw new NotFoundException("No active card");
    const fmt = format === "pdf" || format === "a4" ? "pdf" : "png";
    const key = format === "a4" ? c.a4PdfKey : fmt === "pdf" ? c.pvcPdfKey : c.pngKey;
    if (!key) throw new NotFoundException();
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "card.download", entityType: "card", entityId: c.id, meta: { format: format === "a4" ? "a4" : fmt } });
    res.setHeader("Content-Type", fmt === "pdf" ? "application/pdf" : "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${f.platformId}${format === "a4" ? "-A4" : ""}.${fmt}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(await this.storage.get(key));
  }

  @Post("cards/:cardId/revoke") @Roles("ADMIN")
  async revoke(@Param("cardId") cardId: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const dto = RevokeDto.parse(body);
    const card = await this.db.card.findFirst({ where: { id: cardId, farmer: { orgId: u.orgId } } });
    if (!card) throw new NotFoundException();
    await this.db.$transaction([
      this.db.card.update({ where: { id: cardId }, data: { status: "REVOKED", revokedAt: new Date(), revokeReason: dto.reason } }),
      this.db.verificationToken.updateMany({ where: { cardId }, data: { status: "REVOKED", revokedAt: new Date() } }),
    ]);
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "card.revoke", entityType: "card", entityId: cardId });
    return { ok: true };
  }
}

// ---------- public verification (no login, minimal projection, rate-limited) ----------
const verifyLimiter = new RateLimiter(30, 60_000);

@Controller("public")
export class PublicController {
  constructor(@Inject(Prisma) private readonly db: Prisma) {}

  @Public() @Get("verify/:token")
  async verify(@Param("token") token: string, @Req() req: Request) {
    if (!verifyLimiter.allow(req.ip ?? "x")) throw new ForbiddenException("Too many requests");
    const generic = { status: "NOT_FOUND" as const };
    if (!/^[A-Za-z0-9_-]{22,50}$/.test(token)) return generic;
    const t = await this.db.verificationToken.findUnique({ where: { tokenHash: sha256(token) }, include: { card: { include: { farmer: true } } } });
    if (!t) { await this.db.verificationEvent.create({ data: { outcome: "NOT_FOUND" } }); return generic; }
    let status: "ACTIVE" | "REVOKED" | "EXPIRED" | "SUPERSEDED" = "ACTIVE";
    if (t.status === "REVOKED" || t.card.status === "REVOKED" || t.card.farmer.status === "REVOKED") status = "REVOKED";
    else if (t.status === "SUPERSEDED" || t.card.status === "SUPERSEDED") status = "SUPERSEDED";
    else if (t.card.expiresAt && t.card.expiresAt < new Date()) status = "EXPIRED";
    await this.db.verificationEvent.create({ data: { tokenId: t.id, outcome: status } });
    // Minimal projection: no photo, phone, address, land, documents. Name is off by default.
    return {
      status, platformId: t.card.farmer.platformId, trustLevel: t.card.farmer.trustLevel, issuedAt: t.card.issuedAt, issuer: "Agri·Card (platform-generated, not a government credential)",
      reference: t.card.id.slice(0, 8).toUpperCase(), checkedAt: new Date().toISOString(),
    };
  }
}

export { BadRequestException };
