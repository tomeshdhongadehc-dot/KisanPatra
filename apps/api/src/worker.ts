// Standalone extraction worker: `pnpm --filter @agri/api worker`. Run with the API in WORKER_MODE=external so the
// API process never parses uploads. Holds DB access (to persist results) but the per-job child process does not.
import "reflect-metadata";
import { Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Audit, Prisma, Storage } from "./core";
import { ExtractionQueue } from "./queue";

@Module({ providers: [Prisma, Storage, Audit, ExtractionQueue] })
class WorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ["error", "warn", "log"] });
  app.get(ExtractionQueue).start();
  const bye = async () => { app.get(ExtractionQueue).stop(); await app.close(); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  Logger.log("extraction worker running", "Worker");
}
main();
