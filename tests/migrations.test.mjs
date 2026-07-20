import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("gallery favorite and byte size migration is tracked", async () => {
  const sql = await readFile(new URL("../migrations/0006_gallery_favorite_size.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN byte_size INTEGER/);
  assert.match(sql, /idx_gallery_favorite_created/);
});
