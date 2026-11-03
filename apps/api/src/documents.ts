import { Inject, BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, Injectable, Logger, NotFoundException, Param, ParseIntPipe, Patch, Post, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { z } from "zod";
import { Audit, Prisma, Storage, blindIndex, config, dec, enc, normName, platformId, sha256 } from "./core";
import { AuthUser, CurrentUser, Roles } from "./auth";
import { ExtractionQueue } from "./queue";

// Calibrated on the synthetic benchmark (docs: README "Extraction benchmark"): 0.90 gave 0 silent errors in 1464 fields, 0.85 gave the first. Recalibrate on real redacted forms.
const REVIEW_CONFIDENCE = Number(process.env.REVIEW_CONFIDENCE ?? 0.9);
const REQUIRED = ["farmer_id", "name_en", "name_local", "gender", "dob", "mobile", "address_en"];

const EditDto = z.object({ action: z.enum(["confirm", "edit", "reject"]), value: z.string().max(500).optional(), reason: z.string().max(200).optional() }).strict();
const SubmitDto = z.object({ attested: z.literal(true) }).strict();

@Controller("documents")
export class DocumentsController {
  constructor(@Inject(Prisma) private readonly db: Prisma, @Inject(Storage) private readonly storage: Storage, @Inject(Audit) private readonly audit: Audit, @Inject(ExtractionQueue) private readonly queue: ExtractionQueue) {}

  private async loadDoc(id: string, u: AuthUser) {
    const d = await this.db.sourceDocument.findFirst({ where: { id, orgId: u.orgId } });
    if (!d) throw new NotFoundException();
    // record-level rule: operators only see their own uploads
    if (u.role === "OPERATOR" && d.uploadedById !== u.id) {
      await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "document.read", entityType: "document", entityId: id, outcome: "DENIED" });
      throw new NotFoundException();
    }
    return d;
  }

  @Post() @Roles("OPERATOR", "ADMIN")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: config.maxUploadBytes, files: 1 } }))
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() u: AuthUser) {
    if (!file) throw new BadRequestException("file required");
    const reject = async (reason: string) => {
      await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "document.upload", entityType: "document", outcome: "FAILURE", meta: { reason } });
      throw new BadRequestException(reason);
    };
    if (!/\.pdf$/i.test(file.originalname)) return reject("NOT_PDF_EXTENSION");
    if (file.mimetype !== "application/pdf") return reject("NOT_PDF_MIME");
    if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return reject("NOT_PDF_SIGNATURE");
    const hash = sha256(file.buffer);
    const dup = await this.db.sourceDocument.findFirst({ where: { orgId: u.orgId, sha256: hash, status: { not: "REJECTED" } } });
    if (dup) throw new ConflictException({ message: "DUPLICATE_DOCUMENT", documentId: dup.id });

    const storageKey = await this.storage.put(file.buffer, "pdf");
    const doc = await this.db.sourceDocument.create({ data: { orgId: u.orgId, uploadedById: u.id, storageKey, sha256: hash, sizeBytes: file.size, status: "VALIDATED" } });
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "document.upload", entityType: "document", entityId: doc.id });
    await this.queue.enqueue(doc.id); // async: a worker picks it up; caller polls GET /documents/:id
    return { id: doc.id, status: doc.status };
  }

  @Get(":id")
  async get(@Param("id") id: string, @CurrentUser() u: AuthUser) {
    const d = await this.loadDoc(id, u);
    const job = await this.db.extractionJob.findFirst({ where: { documentId: id, status: { in: ["SUCCEEDED", "RUNNING", "FAILED"] } }, orderBy: { createdAt: "desc" }, include: { fields: true } });
    const pages = await this.db.documentPage.findMany({ where: { documentId: id }, orderBy: { pageNo: "asc" } });
    const fields = (job?.fields ?? []).filter((f) => f.fieldKey !== "photo_key").map((f) => ({
      id: f.id, key: f.fieldKey, raw: dec(f.rawValueEnc), value: dec(f.normValueEnc), finalValue: dec(f.finalValueEnc),
      confidence: f.confidence, page: f.sourcePage, box: f.regionJson, errors: (f.validationErrors as string[] | null) ?? [], state: f.reviewState,
      needsReview: ((f.validationErrors as string[] | null)?.length ?? 0) > 0 || (f.confidence ?? 0) < REVIEW_CONFIDENCE,
    })).sort((a, b) => a.key.localeCompare(b.key));
    return { id: d.id, status: d.status, rejectReason: d.rejectReason, templateId: d.templateId, farmerId: d.farmerId, pages: pages.map((p) => ({ pageNo: p.pageNo, width: p.width, height: p.height })), fields };
  }

  @Get(":id/pages/:n/image")
  async page(@Param("id") id: string, @Param("n", ParseIntPipe) n: number, @CurrentUser() u: AuthUser, @Res() res: Response) {
    await this.loadDoc(id, u);
    const p = await this.db.documentPage.findUnique({ where: { documentId_pageNo: { documentId: id, pageNo: n } } });
    if (!p) throw new NotFoundException();
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "document.page.view", entityType: "document", entityId: id });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(await this.storage.get(p.imageKey));
  }

  @Patch(":id/fields/:fid") @Roles("OPERATOR", "ADMIN", "VERIFIER")
  async review(@Param("id") id: string, @Param("fid") fid: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    const dto = EditDto.parse(body);
    const d = await this.loadDoc(id, u);
    if (d.status !== "READY_FOR_REVIEW") throw new ConflictException("Document not editable");
    const f = await this.db.extractedField.findFirst({ where: { id: fid, job: { documentId: id } } });
    if (!f) throw new NotFoundException();
    if (dto.action === "edit") {
      if (dto.value === undefined) throw new BadRequestException("value required");
      await this.db.fieldRevision.create({ data: { fieldId: f.id, userId: u.id, oldValueEnc: f.finalValueEnc ?? f.normValueEnc, newValueEnc: enc(dto.value), reason: dto.reason } });
      await this.db.extractedField.update({ where: { id: f.id }, data: { finalValueEnc: enc(dto.value), reviewState: "EDITED", reviewedById: u.id, reviewedAt: new Date() } });
    } else {
      await this.db.extractedField.update({ where: { id: f.id }, data: { reviewState: dto.action === "confirm" ? "CONFIRMED" : "REJECTED", finalValueEnc: dto.action === "confirm" ? (f.finalValueEnc ?? f.normValueEnc) : null, reviewedById: u.id, reviewedAt: new Date() } });
    }
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: `field.${dto.action}`, entityType: "extracted_field", entityId: f.id, meta: { key: f.fieldKey } });
    return { ok: true };
  }

  /** Review complete: create the farmer record (trust level L1). */
  @Post(":id/submit") @Roles("OPERATOR", "ADMIN")
  async submit(@Param("id") id: string, @Body() body: unknown, @CurrentUser() u: AuthUser) {
    SubmitDto.parse(body);
    const d = await this.loadDoc(id, u);
    if (d.status !== "READY_FOR_REVIEW") throw new ConflictException("Document not ready");
    const job = await this.db.extractionJob.findFirstOrThrow({ where: { documentId: id, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, include: { fields: true } });

    const unresolved: string[] = [];
    const val: Record<string, string | null> = {};
    for (const f of job.fields) {
      if (f.fieldKey === "photo_key") { val.photo_key = dec(f.normValueEnc); continue; }
      const errs = (f.validationErrors as string[] | null) ?? [];
      const needs = errs.length > 0 || (f.confidence ?? 0) < REVIEW_CONFIDENCE;
      if (needs && f.reviewState === "PROPOSED") unresolved.push(f.fieldKey);
      val[f.fieldKey] = f.reviewState === "REJECTED" ? null : (dec(f.finalValueEnc) ?? dec(f.normValueEnc));
    }
    if (unresolved.length) throw new BadRequestException({ message: "UNRESOLVED_FIELDS", fields: unresolved });
    const missing = REQUIRED.filter((k) => !val[k]);
    if (missing.length) throw new BadRequestException({ message: "MISSING_REQUIRED", fields: missing });

    const farmerIdIdx = blindIndex(val.farmer_id!);
    const exists = await this.db.linkedExternalId.findFirst({ where: { scheme: "AGRISTACK_FARMER_ID", valueIdx: farmerIdIdx } });
    if (exists) throw new ConflictException({ message: "DUPLICATE_FARMER", farmerId: exists.farmerId });

    const gender = (["MALE", "FEMALE", "OTHER"] as const).find((g) => g === val.gender) ?? null;
    const ftype = ({ owner: "OWNER", tenant: "TENANT", sharecropper: "SHARECROPPER" } as Record<string, any>)[(val.farmer_type ?? "").toLowerCase()] ?? "OTHER";

    const farmer = await this.db.$transaction(async (tx) => {
      let pid = platformId();
      while (await tx.farmer.findUnique({ where: { platformId: pid } })) pid = platformId();
      const farmer = await tx.farmer.create({
        data: {
          orgId: u.orgId, platformId: pid, farmerType: ftype, occupation: val.occupation ?? null, trustLevel: "L1_SUBMITTED", createdById: u.id, submittedById: u.id,
          identity: { create: { nameEn: val.name_en!, nameLocal: val.name_local, gender, dobEnc: enc(val.dob), casteCategory: val.caste_category, identifierNameEn: val.identifier_name_en, identifierNameLocal: val.identifier_name_local, nameEnNorm: normName(val.name_en), nameLocalNorm: normName(val.name_local) } },
          contact: { create: { mobileEnc: enc(val.mobile), mobileIdx: val.mobile ? blindIndex(val.mobile) : null, emailEnc: enc(val.email) } },
          addresses: { create: { addressEnEnc: enc(val.address_en), addressLocalEnc: enc(val.address_local), village: val["land[0].village"] ?? null, subDistrict: val["land[0].sub_district"] ?? null, district: val["land[0].district"] ?? null, state: val["land[0].state"] ?? null } },
          linkedIds: {
            create: [
              { scheme: "AGRISTACK_FARMER_ID", valueEnc: enc(val.farmer_id)!, valueIdx: farmerIdIdx, verified: false, sourceDocumentId: id },
              ...(val.enrollment_number ? [{ scheme: "AGRISTACK_ENROLLMENT_NO", valueEnc: enc(val.enrollment_number)!, valueIdx: blindIndex(val.enrollment_number), verified: false, sourceDocumentId: id }] : []),
            ],
          },
        },
      });
      const idxs = [...new Set(Object.keys(val).map((k) => /^land\[(\d+)\]/.exec(k)?.[1]).filter((x): x is string => !!x))];
      for (const i of idxs) {
        const g = (k: string) => val[`land[${i}].${k}`] ?? null;
        if (!g("survey_no") || !g("village") || !g("district") || !g("state")) continue;
        const where = { orgId: u.orgId, state: g("state")!, district: g("district")!, village: g("village")!, surveyValue: g("survey_no")!, subSurveyValue: g("sub_survey_no") };
        const parcel = (await tx.landParcel.findFirst({ where })) ?? (await tx.landParcel.create({ data: { ...where, subDistrict: g("sub_district"), surveyLabel: "S No.", areaTotalHa: g("area_total_ha") } }));
        await tx.cultivationRight.create({
          data: {
            farmerId: farmer.id, parcelId: parcel.id, relationship: ftype === "TENANT" ? "TENANT" : ftype === "SHARECROPPER" ? "SHARECROPPER" : "OWNER", ownerNameOnRecord: g("owner_name"),
            ownerType: g("owner_type"), shareType: g("share_type"), areaAssignedHa: g("area_assigned_ha"), sourceDocumentId: id, verificationNote: "From uploaded registration form; not officially verified",
          },
        });
      }
      await tx.approvalEvent.create({ data: { farmerId: farmer.id, fromLevel: "L0_DRAFT", toLevel: "L1_SUBMITTED", actorId: u.id, checklist: { attested: true } } });
      await tx.sourceDocument.update({ where: { id }, data: { status: "APPROVED", farmerId: farmer.id } });
      return farmer;
    });
    await this.audit.log({ orgId: u.orgId, actorId: u.id, action: "farmer.submit", entityType: "farmer", entityId: farmer.id });
    return { farmerId: farmer.id, platformId: farmer.platformId, trustLevel: farmer.trustLevel };
  }
}

export { HttpException, ForbiddenException };
