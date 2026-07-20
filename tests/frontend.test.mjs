import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../static/index.html", import.meta.url), "utf8");

test("cancelled jobs abort the matching browser generation run", () => {
  assert.match(html, /results\.forEach\(\(r, idx\)[\s\S]*abortActiveGeneration\(ids\[idx\]\)/);
  assert.match(html, /run\.controller\.abort\(generationError\('cancelled'/);
  assert.match(html, /if \(ownsStoredJob\) clearActiveJob\(\)/);
  assert.match(html, /stopElapsedTicker\(\);[\s\S]*setLoading\(false\)/);
});

test("terminal SSE errors do not fall back to polling", () => {
  assert.match(html, /generationError\(data\.detail \|\| t\('generate\.errDefault'\), \{ terminal: true \}\)/);
  assert.match(html, /if \(e\?\.jobTerminal \|\| e\?\.generationCancelled \|\| signal\?\.aborted\) throw e/);
});

test("polling and sleeps share the active generation abort signal", () => {
  assert.match(html, /apiFetch\('\/api\/generate\/' \+ encodeURIComponent\(jobId\), \{ signal \}/);
  assert.ok(html.includes("abortableSleep(pollIntervalMs(performance.now() - start), signal)"));
});
