// Dev seed: one org + one user per role. Passwords are printed once; development only.
import * as argon2 from "argon2";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

async function main() {
  const db = new PrismaClient();
  const org = await db.organization.upsert({ where: { slug: "dev-org" }, update: {}, create: { name: "Dev Organization", slug: "dev-org" } });
  const users = [
    { email: "admin@dev.local", role: "ADMIN", displayName: "Dev Admin" },
    { email: "operator@dev.local", role: "OPERATOR", displayName: "Dev Operator" },
    { email: "verifier@dev.local", role: "VERIFIER", displayName: "Dev Verifier" },
    { email: "auditor@dev.local", role: "AUDITOR", displayName: "Dev Auditor" },
  ] as const;
  for (const u of users) {
    const password = process.env.SEED_PASSWORD ?? randomBytes(9).toString("base64url");
    await db.user.upsert({
      where: { orgId_email: { orgId: org.id, email: u.email } }, update: {},
      create: { orgId: org.id, email: u.email, role: u.role, displayName: u.displayName, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    console.log(`${u.role.padEnd(9)} ${u.email}  password=${password}  (only valid if user was newly created)`);
  }
  await db.$disconnect();
}
main();
