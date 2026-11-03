import test from "node:test";
import assert from "node:assert/strict";
import { childEnv } from "./queue";

test("extraction child never receives secrets or DB credentials", () => {
  process.env.DATABASE_URL = "postgresql://x"; process.env.APP_MASTER_KEY = "k"; process.env.APP_BLIND_INDEX_KEY = "b"; process.env.SESSION_SECRET = "s";
  const keys = Object.keys(childEnv());
  for (const bad of ["DATABASE_URL", "APP_MASTER_KEY", "APP_BLIND_INDEX_KEY", "SESSION_SECRET"]) assert.ok(!keys.includes(bad), bad);
  assert.ok(keys.includes("TESSERACT_BIN") && keys.includes("TESSDATA_DIR"));
});
