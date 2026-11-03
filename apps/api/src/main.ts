import "reflect-metadata";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { ZodError } from "zod";
import { Audit, Prisma, Storage, config } from "./core";
import { AuthController, AuthGuard } from "./auth";
import { DocumentsController } from "./documents";
import { ExtractionQueue } from "./queue";
import { AdminController } from "./admin";
import { Cards, FarmersController, PublicController } from "./farmers";

@Catch()
class AllExceptions implements ExceptionFilter {
  private log = new Logger("Http");
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof ZodError) return res.status(400).json({ message: "VALIDATION_ERROR", issues: e.issues.map((i) => ({ path: i.path.join("."), code: i.code })) });
    if (e instanceof HttpException) {
      const body = e.getResponse();
      return res.status(e.getStatus()).json(typeof body === "string" ? { message: body } : body);
    }
    const code = (e as any)?.code;
    if (code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "FILE_TOO_LARGE" });
    this.log.error((e as Error)?.message); // never echo internals to the client
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: "INTERNAL_ERROR" });
  }
}

@Module({
  controllers: [AuthController, AdminController, DocumentsController, FarmersController, PublicController],
  providers: [Prisma, Storage, Audit, ExtractionQueue, Cards, { provide: APP_GUARD, useClass: AuthGuard }],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  app.setGlobalPrefix("api/v1");
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.useGlobalFilters(new AllExceptions());
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.getHttpAdapter().getInstance().set("trust proxy", false);
  await app.listen(config.port);
  Logger.log(`API on :${config.port}`, "Bootstrap");
}
bootstrap();
