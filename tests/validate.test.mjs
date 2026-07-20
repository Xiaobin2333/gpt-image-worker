import assert from "node:assert/strict";
import test from "node:test";

import { parseGenerateBody, ValidationError } from "../src/validate.ts";

const limits = {
  promptMaxChars: 100,
  referenceMaxCount: 4,
  referenceMaxBytes: 1024,
  generationMaxN: 4,
};
const alphaPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const rgbPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function withPngDimensions(base64, width, height) {
  const bytes = Buffer.from(base64, "base64");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function request(overrides = {}) {
  return {
    prompt: "edit",
    size: "1024x1024",
    model: "gpt-image-2",
    n: 1,
    quality: "auto",
    output_format: "png",
    reference_images: [`data:image/png;base64,${alphaPng}`],
    mask: `data:image/png;base64,${alphaPng}`,
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
    (error) => error instanceof ValidationError && /PNG data URL/.test(error.message),
  );
});

test("masked edits reject an RGB-only PNG mask", () => {
  assert.throws(
    () => parseGenerateBody(request({ mask: `data:image/png;base64,${rgbPng}` }), limits),
    (error) => error instanceof ValidationError && /alpha channel/.test(error.message),
  );
});

test("masked edits reject a non-PNG first reference", () => {
  assert.throws(
    () => parseGenerateBody(request({ reference_images: ["data:image/webp;base64,AAAA"] }), limits),
    (error) => error instanceof ValidationError && /first reference image/.test(error.message),
  );
});

test("masked edits reject corrupt PNG bytes", () => {
  assert.throws(
    () => parseGenerateBody(request({ mask: "data:image/png;base64,AAAA" }), limits),
    (error) => error instanceof ValidationError && /valid PNG/.test(error.message),
  );
});

test("masked edits reject dimensions that differ from the first reference", () => {
  const widerMask = withPngDimensions(alphaPng, 2, 1);
  assert.throws(
    () => parseGenerateBody(request({ mask: `data:image/png;base64,${widerMask}` }), limits),
    (error) => error instanceof ValidationError && /same dimensions/.test(error.message),
  );
});

test("masked edits enforce the encoded size limit before decoding", () => {
  assert.throws(
    () => parseGenerateBody(request({ mask: `data:image/png;base64,${"A".repeat(1500)}` }), limits),
    (error) => error instanceof ValidationError && /mask exceeds/.test(error.message),
  );
});
