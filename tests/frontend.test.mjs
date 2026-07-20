import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../static/index.html", import.meta.url), "utf8");

test("inline frontend scripts parse", () => {
  const scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g), (match) => match[1]);
  assert.ok(scripts.length > 0);
  assert.doesNotThrow(() => new Function(scripts.join("\n")));
});

function loadInlineFunction(name) {
  const match = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?^    \\}`, "m"));
  assert.ok(match, `missing inline function ${name}`);
  return new Function(`${match[0]}; return ${name};`)();
}

test("cancelled jobs abort the matching browser generation run", () => {
  assert.match(html, /results\.forEach\(\(r, idx\)[\s\S]*abortActiveGeneration\(ids\[idx\]\)/);
  assert.match(html, /run\.controller\.abort\(generationError\('cancelled'/);
  assert.match(html, /if \(ownsStoredJob\) clearActiveJob\(jobId\)/);
  assert.match(html, /event\.key !== ACTIVE_JOB_KEY[\s\S]*abortActiveGeneration\(removed\.id\)/);
  assert.match(html, /stopElapsedTicker\(\);[\s\S]*setLoading\(false\)/);
});

test("SSE transport failures use structured polling fallback", () => {
  assert.match(html, /generationError\(data\.detail \|\| t\('generate\.errDefault'\), \{ terminal: true \}\)/);
  assert.match(html, /if \(e\?\.jobTerminal \|\| e\?\.generationCancelled \|\| signal\?\.aborted\) throw e/);
  assert.match(html, /err\.generationTransport = !!options\.transport/);
  assert.match(html, /EventSource closed'[\s\S]*\{ transport: true \}/);
  assert.match(html, /if \(!e\?\.generationTransport\) throw e/);
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

test("preview loading distinguishes retryable timeouts from hard failures", () => {
  assert.match(html, /const PREVIEW_IMAGE_LOAD_TIMEOUT_MS = 30_000/);
  assert.match(html, /setTimeout\(\(\) => loadError\(true\), PREVIEW_IMAGE_LOAD_TIMEOUT_MS\)/);
  assert.match(html, /img\.onerror = \(\) => loadError\(false\)/);
  assert.match(html, /await showGeneratedImage\(result\);\s*clearActiveJob\(submitted\.job_id\)/);
  assert.match(html, /if \(!e\?\.previewLoadTimedOut && run\?\.jobId\) clearActiveJob\(run\.jobId\)/);
});

test("active job cleanup is compare-and-delete and gallery refresh is background work", () => {
  assert.match(html, /function clearActiveJob\(expectedJobId\)[\s\S]*stored\?\.id !== expectedJobId[\s\S]*removeItem\(ACTIVE_JOB_KEY\)/);
  assert.match(html, /loadGallery\(1, \{ throwOnError: true \}\)\.catch/);
  assert.doesNotMatch(html, /await loadGallery\(1, \{ throwOnError: true \}\)/);
});

test("API presets restore their model list into the generation selector", () => {
  assert.match(html, /id="settingsModels"/);
  assert.match(html, /function parseModelsTextarea\(\)[\s\S]*MODEL_NAME_RE[\s\S]*out\.length < 50/);
  assert.match(html, /function applyModelsToHomeSelect\(models\)[\s\S]*\['gpt-image-2'\]/);
  assert.match(html, /models: parsedModels/);
  assert.match(html, /applyModelsToHomeSelect\(Array\.isArray\(session\.models\) \? session\.models : \[\]\)/);
});

test("gallery filters are forwarded across paging and bulk operations", () => {
  for (const id of ["galleryPromptFilter", "galleryModelFilter", "galleryPresetFilter", "gallerySizeFilter", "galleryDateFromFilter", "galleryDateToFilter", "galleryFavoriteFilter"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /function buildGalleryQueryParams[\s\S]*params\.set\('prompt'[\s\S]*params\.set\('model'[\s\S]*params\.set\('preset'[\s\S]*params\.set\('size'[\s\S]*params\.set\('date_from'[\s\S]*params\.set\('date_to'[\s\S]*params\.set\('favorite'/);
  assert.match(html, /function invertGallerySelection[\s\S]*buildGalleryQueryParams\(page, pageSize\)/);
  assert.match(html, /function fetchAllGalleryEntries[\s\S]*buildGalleryQueryParams\(page, pageSize\)/);
  assert.match(html, /galleryFilterDebounce = setTimeout[\s\S]*250/);
  assert.match(html, /const sequence = \+\+galleryLoadSequence[\s\S]*sequence !== galleryLoadSequence/);
});

test("gallery favorites and file sizes are rendered", () => {
  const formatGalleryTotalSize = loadInlineFunction("formatGalleryTotalSize");
  assert.equal(formatGalleryTotalSize(1023), "1023 B");
  assert.equal(formatGalleryTotalSize(1024), "1.0 KB");
  assert.equal(formatGalleryTotalSize(1024 * 1024), "1.0 MB");
  assert.match(html, /apiFetch\('\/api\/gallery\/' \+ encodeURIComponent\(imageId\) \+ '\/favorite'/);
  assert.match(html, /renderLightboxFavoriteButton\(normalized\)/);
  assert.match(html, /renderParameter\(t\('param\.byteSize'\), byteSize \|\| '—'\)/);
});
