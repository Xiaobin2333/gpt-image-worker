import assert from "node:assert/strict";
import test from "node:test";

import { appendProducedId, cancelGenerateJob, isJobRunning, renewJobLease } from "../src/storage.ts";

function leaseEnv(result) {
  const calls = [];
  return {
    calls,
    env: {
      DB: {
        prepare(sql) {
          assert.match(sql, /status = 'running'/);
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
  assert.equal(await renewJobLease(env, "job-1"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "job-1");
  assert.equal(Number.isNaN(Date.parse(calls[0][0])), false);
});

test("renewJobLease reports a terminal or missing job", async () => {
  const { env } = leaseEnv(null);
  assert.equal(await renewJobLease(env, "job-2"), false);
});

test("isJobRunning only accepts an active running row", async () => {
  const { env: running } = leaseEnv({ id: "job-3" });
  const { env: terminal } = leaseEnv(null);
  assert.equal(await isJobRunning(running, "job-3"), true);
  assert.equal(await isJobRunning(terminal, "job-3"), false);
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
  assert.equal(await appendProducedId(env, "job-4", "image-1"), true);
  assert.match(sql, /status = 'running'/);
  assert.match(sql, /RETURNING id/);
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
