import assert from "node:assert/strict";
import test from "node:test";

import { createApiPreset, loadApiSettingsState, parseModelIds, saveSettings } from "../src/settings.ts";

function settingsEnv(initial) {
  let stored = initial;
  return {
    DEFAULT_API_URL: "https://example.test",
    DEFAULT_API_KEY: "secret",
    DEFAULT_API_PATH: "/v1/images/generations",
    SETTINGS: {
      async get() { return stored; },
      async put(_key, value) { stored = JSON.parse(value); },
    },
  };
}

test("model ids preserve order, remove duplicates, and cap at 50", () => {
  const input = Array.from({ length: 55 }, (_, i) => `model-${i}`);
  input.splice(1, 0, "model-0");
  const models = parseModelIds(input);
  assert.equal(models.length, 50);
  assert.deepEqual(models.slice(0, 3), ["model-0", "model-1", "model-2"]);
  assert.throws(() => parseModelIds(["bad model"]), /Invalid model id/);
});

test("preset models survive settings updates and are copied to new presets", async () => {
  const env = settingsEnv();
  await saveSettings(env, {
    api_url: "https://example.test",
    api_key: null,
    api_path: "/v1/images/generations",
    models: ["gpt-image-2", "custom/image-model"],
  });
  const { created } = await createApiPreset(env, { source_preset_id: "default" });
  assert.deepEqual(created.models, ["gpt-image-2", "custom/image-model"]);
  const state = await loadApiSettingsState(env);
  assert.deepEqual(state.presets[0].models, ["gpt-image-2", "custom/image-model"]);
});
