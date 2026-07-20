import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runSettledBatch, runSettledBatchWithRetries } from "../src/batch.ts";

const proxy = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

function loadBuildResponsesPayload() {
  const match = proxy.match(/export function buildResponsesPayload\([\s\S]*?^\}/m);
  assert.ok(match, "missing buildResponsesPayload");
  const javascript = match[0]
    .replace(/^export /, "")
    .replace(/payload: GenerateRequestBody/, "payload")
    .replace(/responsesModel: string/, "responsesModel")
    .replace(/\): Record<string, unknown>/, ")")
    .replace(/const tool: Record<string, unknown>/, "const tool");
  return new Function("parseDataUrl", `${javascript}; return buildResponsesPayload;`)(
    (value) => {
      if (!String(value).startsWith("data:")) throw new Error("invalid data URL");
      return value;
    },
  );
}

test("runSettledBatch keeps successful images when one call fails", async () => {
  const started = [];
  const batch = await runSettledBatch(4, 2, async (index) => {
    started.push(index);
    if (index === 1) throw new Error("upstream 400");
    return `image-${index}`;
  });

  assert.deepEqual(started.sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.deepEqual(batch.results, ["image-0", "image-2", "image-3"]);
  assert.equal(batch.errors.length, 1);
  assert.equal(batch.errors[0].index, 1);
  assert.match(batch.errors[0].error.message, /400/);
});

test("runSettledBatch reports every failure when the whole batch fails", async () => {
  const batch = await runSettledBatch(3, 3, async (index) => {
    throw new Error(`failure-${index}`);
  });

  assert.deepEqual(batch.results, []);
  assert.deepEqual(batch.errors.map((item) => item.index), [0, 1, 2]);
});

test("runSettledBatchWithRetries retries only failed slots", async () => {
  const calls = [];
  const batch = await runSettledBatchWithRetries(
    5,
    5,
    async (index, attempt) => {
      calls.push([index, attempt]);
      if ((index === 1 || index === 4) && attempt === 1) throw new Error("transient");
      return `image-${index}`;
    },
    { maxRetries: 2, shouldRetry: () => true },
  );

  assert.deepEqual(batch.results, ["image-0", "image-1", "image-2", "image-3", "image-4"]);
  assert.deepEqual(batch.errors, []);
  assert.deepEqual(calls.filter(([, attempt]) => attempt === 2).map(([index]) => index), [1, 4]);
});

test("runSettledBatchWithRetries keeps permanent failures terminal", async () => {
  let calls = 0;
  const batch = await runSettledBatchWithRetries(
    2,
    2,
    async (index) => {
      calls++;
      if (index === 1) throw new Error("upstream 400");
      return "image-0";
    },
    { maxRetries: 2, shouldRetry: (error) => !String(error).includes("400") },
  );

  assert.equal(calls, 2);
  assert.deepEqual(batch.results, ["image-0"]);
  assert.equal(batch.errors.length, 1);
  assert.equal(batch.errors[0].index, 1);
});

test("sequential image edits continue after individual failures", async () => {
  assert.match(proxy, /if \(useSingleImagePerCall\) \{[\s\S]*single-image attempt failed, continuing batch[\s\S]*continue;/);
  assert.match(proxy, /if \(entries\.length === 0\) throw new Error\("Upstream produced no images"\)/);
});

test("Images API falls back when the upstream rejects tools[0].n", async () => {
  assert.match(proxy, /function requiresSingleImageCalls[\s\S]*\^gpt-image-2[\s\S]*\.test\(payload\.model\.trim\(\)\)/);
  assert.match(proxy, /let useSingleImagePerCall = requiresSingleImageCalls\(payload\)/);
  assert.match(proxy, /if \(!useSingleImagePerCall && perCall > 1 && rejectsImageCountParameter\(e\)\) \{[\s\S]*runParallelSingleCalls\(remaining, remaining, "images fallback"\)[\s\S]*break;/);
  assert.match(proxy, /const perCall = useSingleImagePerCall \? 1 : remaining/);
});

test("Responses API uses an image_generation tool payload", () => {
  const buildResponsesPayload = loadBuildResponsesPayload();
  const payload = {
    prompt: "draw a red circle",
    size: "1536x1024",
    model: "gpt-image-2",
    n: 20,
    quality: "high",
    output_format: "jpeg",
    output_compression: 82,
    response_format: "url",
  };
  assert.deepEqual(buildResponsesPayload(payload, "gpt-5.4"), {
    model: "gpt-5.4",
    input: "draw a red circle",
    tools: [{
      type: "image_generation",
      size: "1536x1024",
      quality: "high",
      output_format: "jpeg",
      output_compression: 82,
    }],
  });
  assert.equal(buildResponsesPayload(payload, "  ").model, "gpt-image-2");
  assert.deepEqual(buildResponsesPayload({ ...payload, output_format: "png" }, "gpt-5.4").tools, [{
    type: "image_generation",
    size: "1536x1024",
    quality: "high",
    output_format: "png",
  }]);

  const withReferences = buildResponsesPayload({
    ...payload,
    reference_images: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
    mask: "data:image/png;base64,CCCC",
  }, "gpt-5.4");
  assert.deepEqual(withReferences.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "draw a red circle" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_image", image_url: "data:image/jpeg;base64,BBBB" },
    ],
  }]);
  assert.deepEqual(withReferences.tools[0].input_image_mask, {
    image_url: "data:image/png;base64,CCCC",
  });
  assert.equal("n" in withReferences.tools[0], false);
});

test("single-image paths use the requested quantity as their concurrency", () => {
  assert.match(proxy, /if \(apiPath === "\/v1\/responses" \|\| parallelImages\)[\s\S]*runParallelSingleCalls\(remaining, remaining/);
  assert.match(proxy, /const parallelImages = apiPath === "\/v1\/images\/generations"\s*&& requiresSingleImageCalls\(payload\)/);
  assert.doesNotMatch(proxy, /responsesConcurrency/);
});

test("parallel edits reuse decoded inputs and save the detected output format", () => {
  assert.match(proxy, /const editAssets = apiPath === "\/v1\/images\/generations" && hasReferences[\s\S]*prepareEditAssets\(payload\)/);
  assert.match(proxy, /callImagesEdits\(settings\.api_url, settings\.api_key, callPayload, editAssets!, signal\)/);
  assert.match(proxy, /const actualFormat = detectFormatInfo\(bytes\) \?\? fmt[\s\S]*saveImage\(env, filename, bytes, actualFormat\.mediaType\)/);
  assert.doesNotMatch(proxy.match(/export function buildResponsesPayload\([\s\S]*?^\}/m)?.[0] ?? "", /parseDataUrl/);
});

test("upstream JSON parsing does not depend on the Content-Type header", () => {
  assert.match(proxy, /async function readUpstreamJson[\s\S]*const text = await resp\.text\(\);[\s\S]*JSON\.parse\(text\)/);
  assert.doesNotMatch(proxy, /if \(!ct\.includes\("application\/json"\)\)/);
});

test("streamed jobs publish each committed image as an SSE image event", () => {
  assert.match(proxy, /else \{[\s\S]*addToGalleryForJob\(env, entry, options\.jobId, options\.claimToken\)[\s\S]*publishedIds\.add\(entry\.id\)[\s\S]*if \(options\.onImage\)/);
  assert.match(proxy, /deletePendingImages\(persisted\.results\.filter\(\(entry\) => !publishedIds\.has\(entry\.id\)\)\)/);
  assert.match(worker, /executeClaimedJob\([\s\S]*\(result, completed\) => emitResultImages\(result, completed\)/);
});

test("parallel jobs retry missing images and reject incomplete terminal results", () => {
  assert.match(proxy, /runSettledBatchWithRetries\([\s\S]*maxRetries: 2[\s\S]*isRetryableParallelError/);
  assert.match(proxy, /Generated \$\{entries\.length\} of \$\{targetCount\} images; \$\{batch\.errors\.length\} calls failed/);
});

test("job image records share one guarded gallery batch", async () => {
  assert.match(proxy, /const pendingEntries = entries\.filter[\s\S]*addGalleryEntriesForJob\([\s\S]*pendingEntries/);
  assert.match(proxy, /if \(!committed\)[\s\S]*deletePendingImages[\s\S]*Generation job lease lost/);
  assert.match(proxy, /if \(isFatalJobError\(e\)\) \{[\s\S]*throw e/);
});
