// Extraction queue + worker. Postgres is the queue (no extra infrastructure): jobs are ExtractionJob rows, claimed with
// FOR UPDATE SKIP LOCKED so several workers can run safely. Each job runs in a throwaway child process (extract-child.ts)
// with a scrubbed environment, a hard timeout and a memory cap, so a malicious or broken PDF cannot reach DB credentials or keys,
// and a hung OCR/renderer cannot take down the API.
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Audit, Prisma, Storage, config, enc } from "./core";

const MAX_ATTEMPTS = 2;
const EXTRACTOR_VERSION = "agristack-farmer-reg-form@1";
const DETERMINISTIC = new Set(["UNSUPPORTED_LAYOUT", "TEMPLATE_ANCHOR_MISMATCH", "EXTRACTION_ERROR"]); // retrying cannot help

const jobTimeoutMs = Number(process.env.EXTRACTION_TIMEOUT_MS ?? 120_000);
export const queueConfig = {
  inline: (process.env.WORKER_MODE ?? "inline") !== "external", // "external": the API only enqueues; run `pnpm worker` separately
  concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1)), // OCR is CPU heavy
  pollMs: Number(process.env.WORKER_POLL_MS ?? 1000),
  jobTimeoutMs,
  staleMs: Math.max(Number(process.env.STALE_JOB_MS ?? jobTimeoutMs * 2), jobTimeoutMs + 5_000), // RUNNING longer than this = its worker died; never shorter than a job may legitimately run
  childMemMb: Number(process.env.EXTRACTION_CHILD_MEM_MB ?? 1536),
};

/** Environment for the sandboxed extraction child: only what OCR/rendering needs. No DATABASE_URL, no APP_* keys, no session secrets. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TESSERACT_BIN: config.tesseractBin, TESSDATA_DIR: config.tessdataDir, TMP: os.tmpdir(), TEMP: os.tmpdir(), NODE_ENV: process.env.NODE_ENV };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // required by native libs on Windows
  return env;
}

@Injectable()
export class ExtractionQueue implements OnModuleInit, OnModuleDestroy {
  private log = new Logger("Queue");
  private running = 0;
  private active = new Set<string>(); // jobs this process is running right now
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private lastRecover = 0;

  constructor(@Inject(Prisma) private readonly db: Prisma, @Inject(Storage) private readonly storage: Storage, @Inject(Audit) private readonly audit: Audit) {}

  onModuleInit() { if (queueConfig.inline) this.start(); }
  onModuleDestroy() { this.stop(); }

  /** Called by the upload endpoint. Cheap: one row. */
  async enqueue(documentId: string) {
    return this.db.extractionJob.create({ data: { documentId, status: "QUEUED", provider: "local-ocr", extractorVersion: EXTRACTOR_VERSION } });
  }

  start() {
    if (this.timer) return; // idempotent
    this.stopped = false;
    this.log.log(`worker started (concurrency ${queueConfig.concurrency}, timeout ${queueConfig.jobTimeoutMs}ms, mode ${queueConfig.inline ? "inline" : "external"})`);
    const tick = async () => {
      if (this.stopped) return;
      try {
        if (Date.now() - this.lastRecover > Math.min(60_000, queueConfig.staleMs)) { this.lastRecover = Date.now(); await this.recoverStale(); }
        while (!this.stopped && this.running < queueConfig.concurrency) {
          const job = await this.claim();
          if (!job) break;
          this.running++; this.active.add(job.id);
          void this.process(job).catch((e) => this.log.error(`job ${job.id}: ${e?.message}`)).finally(() => { this.running--; this.active.delete(job.id); });
        }
      } catch (e: any) { this.log.error(`tick: ${e?.message}`); }
      this.timer = setTimeout(tick, queueConfig.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** Atomically take the oldest queued job. */
  private async claim(): Promise<{ id: string; documentId: string; attempts: number } | null> {
    const rows = await this.db.$queryRaw<{ id: string; documentId: string; attempts: number }[]>`
      UPDATE "ExtractionJob" SET status = 'RUNNING'::"JobStatus", "startedAt" = (now() AT TIME ZONE 'UTC'), attempts  /* Prisma timestamps are UTC without tz: never write local now() */ = attempts + 1
      WHERE id = (SELECT id FROM "ExtractionJob" WHERE status = 'QUEUED'::"JobStatus" ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, "documentId", attempts`;
    return rows[0] ?? null;
  }

  /** A worker that died mid-job leaves RUNNING rows behind: put them back (or fail them after MAX_ATTEMPTS). */
  async recoverStale() {
    const cutoff = new Date(Date.now() - queueConfig.staleMs);
    const stale = await this.db.extractionJob.findMany({ where: { status: "RUNNING", startedAt: { lt: cutoff } }, select: { id: true, documentId: true, attempts: true } });
    for (const j of stale) {
      if (this.active.has(j.id)) continue;
      if (j.attempts < MAX_ATTEMPTS) { await this.db.extractionJob.update({ where: { id: j.id }, data: { status: "QUEUED" } }); this.log.warn(`requeued stale job ${j.id}`); }
      else await this.fail(j.id, j.documentId, "EXTRACTION_TIMEOUT");
    }
  }

  private async fail(jobId: string, documentId: string, reason: string) {
    await this.db.extractionJob.update({ where: { id: jobId }, data: { status: "FAILED", error: reason.slice(0, 200), finishedAt: new Date() } });
    await this.db.sourceDocument.update({ where: { id: documentId }, data: { status: "FAILED", rejectReason: reason.slice(0, 100) } });
  }

  private async process(job: { id: string; documentId: string; attempts: number }) {
    const doc = await this.db.sourceDocument.findUnique({ where: { id: job.documentId } });
    if (!doc) { await this.db.extractionJob.update({ where: { id: job.id }, data: { status: "FAILED", error: "DOCUMENT_GONE", finishedAt: new Date() } }); return; }
    await this.db.sourceDocument.update({ where: { id: doc.id }, data: { status: "PROCESSING" } });
    const dir = path.join(os.tmpdir(), `agri-job-${crypto.randomBytes(8).toString("hex")}`);
    try {
      await fs.mkdir(dir, { mode: 0o700 });
      await fs.writeFile(path.join(dir, "in.pdf"), await this.storage.get(doc.storageKey), { mode: 0o600 });
      const exit = await this.runChild(dir);
      if (exit.code !== 0) {
        const code = exit.code === 2 ? await fs.readFile(path.join(dir, "out", "error.txt"), "utf8").catch(() => "EXTRACTION_ERROR") : exit.timedOut ? "EXTRACTION_TIMEOUT" : "EXTRACTION_CRASH";
        if (!DETERMINISTIC.has(code) && job.attempts < MAX_ATTEMPTS) {
          this.log.warn(`job ${job.id} ${code}, retrying`);
          await this.db.extractionJob.update({ where: { id: job.id }, data: { status: "QUEUED", error: code } });
          await this.db.sourceDocument.update({ where: { id: doc.id }, data: { status: "VALIDATED" } });
          return;
        }
        await this.fail(job.id, doc.id, code);
        await this.audit.log({ orgId: doc.orgId, action: "document.extraction_failed", entityType: "document", entityId: doc.id, outcome: "FAILURE", meta: { reason: code } });
        return;
      }
      await this.persist(job.id, doc, dir);
    } catch (e: any) {
      this.log.warn(`job ${job.id} failed: ${e?.message}`);
      await this.fail(job.id, doc.id, "EXTRACTION_ERROR");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }); // the PDF copy and page images never outlive the job
    }
  }

  private runChild(dir: string): Promise<{ code: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const env = childEnv();
      let timedOut = false;
      const child = spawn(process.execPath, [`--max-old-space-size=${queueConfig.childMemMb}`, "--import", "tsx", path.join(__dirname, "extract-child.ts"), dir], { env, cwd: path.resolve(__dirname, ".."), stdio: "ignore", windowsHide: true });
      const killer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, queueConfig.jobTimeoutMs);
      child.on("exit", (code) => { clearTimeout(killer); resolve({ code, timedOut }); });
      child.on("error", () => { clearTimeout(killer); resolve({ code: 1, timedOut }); });
    });
  }

  private async persist(jobId: string, doc: { id: string; orgId: string }, dir: string) {
    const res = JSON.parse(await fs.readFile(path.join(dir, "out", "result.json"), "utf8"));
    for (const p of res.pages as { pageNo: number; width: number; height: number; file: string }[]) {
      if (!/^page-\d+\.png$/.test(p.file)) continue;
      const imageKey = await this.storage.put(await fs.readFile(path.join(dir, "out", p.file)), "png");
      await this.db.documentPage.create({ data: { documentId: doc.id, pageNo: p.pageNo, imageKey, width: p.width, height: p.height } });
    }
    const all = [...res.fields, ...res.parcels.flatMap((p: any) => p.fields)] as any[];
    for (const f of all) {
      await this.db.extractedField.create({
        data: { jobId, fieldKey: f.key, rawValueEnc: enc(f.raw), normValueEnc: enc(f.value), confidence: f.confidence, sourcePage: f.page, regionJson: f.box, validationErrors: f.errors },
      });
    }
    if (res.hasPhoto) {
      const photoKey = await this.storage.put(await fs.readFile(path.join(dir, "out", "photo.jpg")), "jpg");
      await this.db.extractedField.create({ data: { jobId, fieldKey: "photo_key", rawValueEnc: enc(photoKey), normValueEnc: enc(photoKey), reviewState: "CONFIRMED", sourcePage: 1 } });
    }
    await this.db.extractionJob.update({ where: { id: jobId }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
    await this.db.sourceDocument.update({ where: { id: doc.id }, data: { status: "READY_FOR_REVIEW", kind: "FARMER_REGISTRATION_FORM", templateId: res.templateId, pageCount: res.pageCount } });
    await this.audit.log({ orgId: doc.orgId, action: "document.extracted", entityType: "document", entityId: doc.id, meta: { fields: all.length } });
  }
}
