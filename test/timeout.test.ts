import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { askOnce, buildRequest, createClient } from "../src/chat.ts";
import { responseTimeoutMs } from "../src/timeout.ts";

test("request timeout defaults to two minutes and flags override exported seconds", () => {
  assert.equal(responseTimeoutMs(undefined, {}), 120_000);
  assert.equal(responseTimeoutMs(undefined, { ASK_TIMEOUT: "300" }), 300_000);
  assert.equal(responseTimeoutMs("30", { ASK_TIMEOUT: "invalid" }), 30_000);
  assert.equal(responseTimeoutMs("0.025", {}), 25);
});

test("invalid timeouts fail rather than silently disabling the timeout", () => {
  for (const raw of ["", " ", "0", "-1", "NaN", "Infinity", "oops", "0.0001", "2147483.648", "1e99"]) {
    assert.throws(() => responseTimeoutMs(raw, {}), /--timeout must be positive seconds/);
    assert.throws(() => responseTimeoutMs(undefined, { ASK_TIMEOUT: raw }), /ASK_TIMEOUT must be positive seconds/);
  }
});

test("configured timeout aborts a stalled provider without TUI retries", async () => {
  let requests = 0;
  const server = createServer(() => { requests++; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = createClient({
      apiKey: undefined,
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: responseTimeoutMs("0.2", {}), maxRetries: 0,
    });
    await assert.rejects(askOnce(client, buildRequest({ prompt: "Hello" })), /Request timed out/);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
