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

function inlineFunctionSource(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^    \\}`, "m"));
  assert.ok(match, `missing inline function ${name}`);
  return match[0];
}

test("cancelled jobs abort the matching browser generation run", () => {
  assert.match(html, /results\.forEach\(\(r, idx\) => \{\s*abortActiveGeneration\(ids\[idx\]\);\s*if \(r\.status === 'fulfilled'\)/);
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

test("mask requests normalize references and support Responses mode", () => {
  assert.match(html, /await normalizeFirstMaskReferenceToPng\(out\.width, out\.height\)/);
  assert.doesNotMatch(html, /isResponsesApiSelected\(\) && referenceImages\.length > 0/);
  assert.doesNotMatch(inlineFunctionSource("openMaskEditor"), /isResponsesApiSelected/);
  assert.match(html, /referenceMaskDataUrl = null;\s*referenceImages = \[\{ name: meta\.filename, dataUrl \}\]/);
});

test("preview loading never keeps a completed browser job active", () => {
  assert.match(html, /const PREVIEW_IMAGE_LOAD_TIMEOUT_MS = 30_000/);
  assert.match(html, /setTimeout\(\(\) => loadError\(true\), PREVIEW_IMAGE_LOAD_TIMEOUT_MS\)/);
  assert.match(html, /const loader = new Image\(\)[\s\S]*loader\.onerror = \(\) => loadError\(false\)[\s\S]*img\.src = url;\s*loader\.src = url/);
  assert.match(html, /waitForPreviewImage\(previewImg, primary\.image_url\)\.catch/);
  assert.doesNotMatch(html, /await waitForPreviewImage\(previewImg, primary\.image_url\)/);
  assert.match(html, /await finishGeneratedImage\(result\);\s*clearActiveJob\(submitted\.job_id\)/);
  assert.match(html, /if \(run\?\.jobId\) clearActiveJob\(run\.jobId\)/);
  assert.doesNotMatch(html, /if \(!e\?\.previewLoadTimedOut/);
});

test("SSE image events render completed images before the terminal result", () => {
  const streamSource = inlineFunctionSource("streamGenerateJob");
  assert.match(streamSource, /ev\.addEventListener\('image',[\s\S]*JSON\.parse\(e\.data\)/);
  assert.match(streamSource, /t\('preview\.progress',[\s\S]*completed: data\.completed \|\| 0[\s\S]*total: data\.total \|\| 0/);
  assert.match(streamSource, /Promise\.resolve\(onImage\(data\.result, data\.completed, data\.total\)\)/);
  assert.match(html, /runJobStream\(submitted\.job_id, run\.controller\.signal, showGeneratedImageProgress\)/);
  assert.match(html, /function finishGeneratedImage\(data\)[\s\S]*previewImages\.length === 0[\s\S]*showGeneratedImage\(data\)/);
});

test("generation quantity defaults to 20 images", () => {
  assert.match(html, /id="quantityInput"[^>]*min="1"[^>]*max="20"/);
  assert.match(html, /generation_max_n:\s*20/);
  assert.match(html, /Number\(activeLimits\.generation_max_n\) \|\| 20/);
  assert.match(html, /clampSetting\('settingsGenerationMaxN', 1, 20, 20\)/);
  assert.doesNotMatch(html, /id="settingsResponsesConcurrency"/);
});

test("Responses mode keeps image parameters and references editable", () => {
  const controlsSource = inlineFunctionSource("refreshParameterControls");
  const formatSource = inlineFunctionSource("handleOutputFormatChange");
  const templateSource = inlineFunctionSource("applyTemplateSizeQuality");
  assert.match(controlsSource, /lockedIds = \['qualitySelect', 'formatSelect', 'quantityInput', 'responseFormatSelect', 'sizeSelect'\]/);
  assert.match(controlsSource, /lockedIds\.forEach\(\(id\) => setControlDisabled\(id, loading\)\)/);
  assert.doesNotMatch(controlsSource, /const lockParameters/);
  assert.doesNotMatch(controlsSource, /setControlDisabled\([^\n]*responsesMode/);
  assert.match(controlsSource, /referencesDisabled = loading \|\| activeLimits\.reference_max_count <= 0/);
  assert.doesNotMatch(controlsSource, /responsesMode/);
  assert.doesNotMatch(formatSource, /isResponsesApiSelected/);
  assert.match(formatSource, /compressionInput\.disabled = isPng/);
  assert.doesNotMatch(templateSource, /isResponsesApiSelected/);
});

test("active job cleanup is compare-and-delete and gallery refresh is background work", () => {
  assert.match(html, /function clearActiveJob\(expectedJobId\)[\s\S]*stored\?\.id !== expectedJobId[\s\S]*removeItem\(ACTIVE_JOB_KEY\)/);
  assert.match(html, /loadGallery\(1, \{ throwOnError: true \}\)\.catch/);
  assert.doesNotMatch(html, /await loadGallery\(1, \{ throwOnError: true \}\)/);
});

test("page reload restores queued jobs from the server when local state is missing", () => {
  const restoreSource = inlineFunctionSource("findRestorableJob");
  assert.match(restoreSource, /readActiveJob\(\)/);
  assert.match(restoreSource, /apiFetch\('\/api\/generate\/jobs'/);
  assert.match(restoreSource, /ACTIVE_JOB_STATUSES\.has\(job\.status\)/);
  assert.match(restoreSource, /!isAdmin \|\| job\.is_owner/);
  assert.match(restoreSource, /rememberActiveJob\(job\.job_id, job\.prompt \|\| '', startedAt\)/);
  assert.match(html, /async function resumeActiveJobIfAny\(\)[\s\S]*await findRestorableJob\(\)/);
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
