import assert from "node:assert/strict";
import test from "node:test";

import { parseGenerateBody, ValidationError } from "../src/validate.ts";

const limits = {
  promptMaxChars: 100,
  referenceMaxCount: 4,
  referenceMaxBytes: 1024,
  generationMaxN: 4,
};

function request(overrides = {}) {
  return {
    prompt: "edit",
    size: "1024x1024",
    model: "gpt-image-2",
    n: 1,
    quality: "auto",
    output_format: "png",
    reference_images: ["data:image/png;base64,AAAA"],
    mask: "data:image/png;base64,AAAA",
    ...overrides,
  };
}

test("masked edits accept matching PNG inputs", () => {
  const parsed = parseGenerateBody(request(), limits);
  assert.match(parsed.mask, /^data:image\/png/);
});

test("masked edits reject mask formats without a reliable alpha channel", () => {
  assert.throws(
    () => parseGenerateBody(request({ mask: "data:image/jpeg;base64,AAAA" }), limits),
    (error) => error instanceof ValidationError && /alpha channel/.test(error.message),
  );
});

test("masked edits reject a non-PNG first reference", () => {
  assert.throws(
    () => parseGenerateBody(request({ reference_images: ["data:image/webp;base64,AAAA"] }), limits),
    (error) => error instanceof ValidationError && /first reference image/.test(error.message),
  );
});
