import assert from "node:assert/strict";
import test from "node:test";

import { renewJobLease } from "../src/storage.ts";

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
