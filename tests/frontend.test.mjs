import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../static/index.html", import.meta.url), "utf8");

function loadInlineFunction(name) {
  const match = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?^    \\}`, "m"));
  assert.ok(match, `missing inline function ${name}`);
  return new Function(`${match[0]}; return ${name};`)();
}

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

test("mask export uses transparency for painted regions", () => {
  const savedMaskAlpha = loadInlineFunction("savedMaskAlpha");
  const restoredMaskPaintAlpha = loadInlineFunction("restoredMaskPaintAlpha");
  assert.equal(savedMaskAlpha(217), 0);
  assert.equal(savedMaskAlpha(0), 255);
  assert.equal(restoredMaskPaintAlpha(0), 217);
  assert.equal(restoredMaskPaintAlpha(255), 0);
});

test("mask requests normalize references and reject Responses mode", () => {
  assert.match(html, /await normalizeFirstMaskReferenceToPng\(out\.width, out\.height\)/);
  assert.match(html, /isResponsesApiSelected\(\) && referenceImages\.length > 0/);
  assert.match(html, /referenceMaskDataUrl = null;\s*referenceImages = \[\{ name: meta\.filename, dataUrl \}\]/);
});
