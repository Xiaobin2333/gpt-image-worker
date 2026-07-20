import assert from "node:assert/strict";
import test from "node:test";

import {
  addGalleryEntriesForJob,
  addToGalleryForJob,
  appendProducedId,
  cancelGenerateJob,
  finishClaimedJob,
  getGalleryPage,
  isJobRunning,
  renewJobLease,
  setGalleryFavorite,
} from "../src/storage.ts";

function leaseEnv(result) {
  const calls = [];
  return {
    calls,
    env: {
      DB: {
        prepare(sql) {
          assert.match(sql, /status = 'running'/);
          assert.match(sql, /claim_token/);
          return {
            bind(...args) {
              calls.push(args);
              return { first: async () => result };
            },
          };
        },
      },
    },
  };
}

test("renewJobLease keeps a running job active", async () => {
  const { env, calls } = leaseEnv({ id: "job-1" });
  assert.equal(await renewJobLease(env, "job-1", "claim-1"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "job-1");
  assert.equal(calls[0][2], "claim-1");
  assert.equal(Number.isNaN(Date.parse(calls[0][0])), false);
});

test("renewJobLease reports a terminal or missing job", async () => {
  const { env } = leaseEnv(null);
  assert.equal(await renewJobLease(env, "job-2", "claim-2"), false);
});

test("isJobRunning only accepts an active running row", async () => {
  const { env: running } = leaseEnv({ id: "job-3" });
  const { env: terminal } = leaseEnv(null);
  assert.equal(await isJobRunning(running, "job-3", "claim-3"), true);
  assert.equal(await isJobRunning(terminal, "job-3", "claim-3"), false);
});

test("appendProducedId checkpoints only a running job", async () => {
  let sql = "";
  const env = {
    DB: {
      prepare(value) {
        sql = value;
        return { bind: () => ({ first: async () => ({ id: "job-4" }) }) };
      },
    },
  };
  assert.equal(await appendProducedId(env, "job-4", "claim-4", "image-1"), true);
  assert.match(sql, /status = 'running'/);
  assert.match(sql, /claim_token = \?/);
  assert.match(sql, /RETURNING id/);
});

test("finishClaimedJob cannot overwrite a terminal or re-claimed job", async () => {
  let sql = "";
  let args = [];
  const env = {
    DB: {
      prepare(value) {
        sql = value;
        return {
          bind(...values) {
            args = values;
            return { first: async () => null };
          },
        };
      },
    },
  };
  const finished = await finishClaimedJob(env, {
    id: "job-6",
    status: "error",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:02.000Z",
    prompt: "test",
    detail: "late failure",
  }, "claim-6");
  assert.equal(finished, false);
  assert.match(sql, /status = 'running' AND claim_token = \?/);
  assert.equal(args.at(-1), "claim-6");
});

test("gallery insert and produced checkpoint share one guarded D1 batch", async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            const statement = { sql, args };
            statements.push(statement);
            return statement;
          },
        };
      },
      async batch(batch) {
        assert.deepEqual(batch, statements);
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
      },
    },
  };
  const entry = {
    id: "image-7",
    filename: "image-7.png",
    prompt: "test",
    size: "1024x1024",
    created_at: "2026-01-01T00:00:00.000Z",
    byte_size: 123456,
    favorite: true,
    is_public: true,
  };
  assert.equal(await addToGalleryForJob(env, entry, "job-7", "claim-7"), true);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /WHERE EXISTS/);
  assert.match(statements[0].sql, /claim_token = \?/);
  assert.match(statements[0].sql, /byte_size, favorite/);
  assert.deepEqual(statements[0].args.slice(16, 18), [123456, 1]);
  assert.match(statements[1].sql, /produced_ids/);
});

test("multiple gallery entries use one guarded D1 batch and one checkpoint", async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            const statement = { sql, args };
            statements.push(statement);
            return statement;
          },
        };
      },
      async batch(batch) {
        assert.deepEqual(batch, statements);
        return batch.map(() => ({ meta: { changes: 1 } }));
      },
    },
  };
  const makeEntry = (id) => ({
    id,
    filename: `${id}.png`,
    prompt: "test",
    size: "1024x1024",
    created_at: "2026-01-01T00:00:00.000Z",
    is_public: true,
  });
  assert.equal(await addGalleryEntriesForJob(
    env,
    [makeEntry("image-a"), makeEntry("image-b")],
    "job-8",
    "claim-8",
  ), true);
  assert.equal(statements.length, 3);
  assert.match(statements[0].sql, /WHERE EXISTS/);
  assert.match(statements[1].sql, /WHERE EXISTS/);
  assert.match(statements[2].sql, /'\$\[#\]', \?, '\$\[#\]', \?/);
  assert.deepEqual(statements[2].args.slice(0, 2), ["image-a", "image-b"]);
});

test("cancelGenerateJob reports a completion that wins the update race", async () => {
  let state = "running";
  const row = () => ({
    id: "job-5",
    status: state,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    prompt: "test",
    owner_id: "owner-1",
    result: state === "success" ? JSON.stringify({ status: "success" }) : null,
    detail: null,
    produced_ids: null,
  });
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (/UPDATE jobs/.test(sql)) {
                  state = "success";
                  return null;
                }
                return row();
              },
            };
          },
        };
      },
    },
  };

  const result = await cancelGenerateJob(env, "job-5", "owner-1");
  assert.equal(result.status, "already_finished");
  assert.equal(result.job.status, "success");
});

test("gallery filters preserve visibility and return options plus total bytes", async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          args: [],
          bind(...args) { this.args = args; return this; },
          async first() { return { n: 1, total_bytes: 2048 }; },
        };
        statements.push(statement);
        return statement;
      },
      async batch(batch) {
        return batch.map((statement, index) => ({
          results: index === 0
            ? [{ id: "image-9", filename: "image-9.png", prompt: "sunset", size: "1024x1024", created_at: "2026-01-15T00:00:00.000Z", is_public: 1, favorite: 1, byte_size: 2048 }]
            : [{ value: index === 1 ? "model-a" : index === 2 ? "Default" : "1024x1024" }],
          meta: {},
          success: true,
        }));
      },
    },
  };

  const result = await getGalleryPage(env, {
    page: 1,
    pageSize: 9,
    ownerId: "owner-9",
    prompt: "sun_set%",
    model: "model-a",
    preset: "Default",
    size: "1024x1024",
    dateFrom: "2026-01-01",
    dateToExclusive: "2026-02-01",
    favorite: true,
  });

  assert.equal(result.total_bytes, 2048);
  assert.deepEqual(result.filter_options, {
    models: ["model-a"],
    presets: ["Default"],
    sizes: ["1024x1024"],
  });
  assert.equal(result.images[0].favorite, true);
  assert.match(statements[0].sql, /prompt COLLATE NOCASE LIKE \? ESCAPE/);
  assert.match(statements[0].sql, /favorite = 1/);
  assert.deepEqual(statements[0].args.slice(0, 2), ["owner-9", "%sun\\_set\\%%"]);
});

test("gallery favorite updates return the normalized entry", async () => {
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /UPDATE gallery SET favorite = \?/);
        return {
          bind(value, id) {
            assert.deepEqual([value, id], [1, "image-10"]);
            return {
              async first() {
                return { id, filename: "image-10.png", prompt: "test", size: "1024x1024", created_at: "2026-01-01T00:00:00.000Z", favorite: value, is_public: 1 };
              },
            };
          },
        };
      },
    },
  };
  const entry = await setGalleryFavorite(env, "image-10", true);
  assert.equal(entry.favorite, true);
});
