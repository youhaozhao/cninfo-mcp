import assert from "node:assert/strict";
import { test } from "node:test";
import { CninfoError } from "../src/errors.ts";
import { assertAllowedUrl } from "../src/http.ts";
import { fakeFetch, json, testClient } from "./helpers.ts";

const API = "https://www.cninfo.com.cn/api";

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<CninfoError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CninfoError, `expected CninfoError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

test("assertAllowedUrl only accepts https on the CNINFO hosts", () => {
  assert.equal(
    assertAllowedUrl("https://static.cninfo.com.cn/finalpage/a.PDF#frag").href,
    "https://static.cninfo.com.cn/finalpage/a.PDF",
  );
  for (const bad of [
    "http://www.cninfo.com.cn/",
    "https://evil.example.com/",
    "https://www.cninfo.com.cn.evil.example/",
    "https://user:pw@www.cninfo.com.cn/",
    "https://www.cninfo.com.cn:8443/",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.throws(() => assertAllowedUrl(bad), CninfoError, bad);
  }
});

test("requests to other hosts never reach fetch", async () => {
  const { fetch, calls } = fakeFetch({});
  await rejectsWith(testClient(fetch).getJson("https://example.com/x"), "FORBIDDEN_URL");
  assert.equal(calls.length, 0);
});

test("retries transient failures and then succeeds", async () => {
  let attempt = 0;
  const { fetch, calls } = fakeFetch({
    [API]: () => {
      attempt += 1;
      if (attempt === 1) return new Response("", { status: 502 });
      if (attempt === 2) return new Response("", { status: 200 }); // empty body = throttled
      return json({ ok: true });
    },
  });
  assert.deepEqual(await testClient(fetch).getJson(API), { ok: true });
  assert.equal(calls.length, 3);
});

test("gives up after maxAttempts with the last error", async () => {
  const { fetch, calls } = fakeFetch({ [API]: () => new Response("", { status: 503 }) });
  const error = await rejectsWith(testClient(fetch).getJson(API), "UPSTREAM");
  assert.match(error.message, /503/);
  assert.equal(calls.length, 3);
});

test("does not retry permanent client errors", async () => {
  const { fetch, calls } = fakeFetch({
    [`${API}/missing`]: () => new Response("", { status: 404 }),
    [`${API}/bad`]: () => new Response("", { status: 400 }),
  });
  await rejectsWith(testClient(fetch).getJson(`${API}/missing`), "NOT_FOUND");
  await rejectsWith(testClient(fetch).getJson(`${API}/bad`), "UPSTREAM");
  assert.equal(calls.length, 2);
});

test("treats 403 as rate limiting: cools down globally, then retries", async () => {
  let attempt = 0;
  const sleeps: number[] = [];
  let now = 1000;
  const { fetch } = fakeFetch({
    [API]: () => {
      attempt += 1;
      return attempt === 1 ? new Response("", { status: 403 }) : json({ ok: true });
    },
  });
  const client = testClient(fetch, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  assert.deepEqual(await client.getJson(API), { ok: true });
  // one backoff sleep plus the remaining cooldown before the retry is sent
  assert.ok(sleeps.length >= 1);
  assert.ok(now >= 2000, "the retry must wait out the 1s cooldown");
});

test("requests already queued behind the pacing interval honour a new cooldown", async () => {
  // virtual clock: sleeping advances time and lets other tasks run
  let now = 0;
  const starts: number[] = [];
  let first = true;
  const { fetch } = fakeFetch({
    [API]: () => {
      starts.push(now);
      if (first) {
        first = false;
        return new Response("", { status: 429 });
      }
      return json({ ok: true });
    },
  });
  const timers: Array<{ at: number; wake: () => void }> = [];
  const client = testClient(fetch, {
    minIntervalMs: 120,
    now: () => now,
    sleep: (ms) => new Promise<void>((wake) => timers.push({ at: now + ms, wake })),
  });
  const all = Promise.all([0, 1, 2, 3].map((i) => client.getJson(`${API}?i=${i}`)));
  for (let guard = 0; guard < 200; guard++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (timers.length === 0) break;
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift()!;
    now = Math.max(now, next.at);
    next.wake();
  }
  await all;
  // the first request is throttled at t=0; nothing else may start inside the 1s cooldown
  assert.equal(starts[0], 0);
  assert.ok(starts.slice(1).every((t) => t >= 1000), JSON.stringify(starts));
});

test("validate() can mark a well-formed response as retryable", async () => {
  let attempt = 0;
  const { fetch } = fakeFetch({
    [API]: () => {
      attempt += 1;
      return json({ status: attempt < 3 ? "fail" : "success" });
    },
  });
  const body = await testClient(fetch).getJson<{ status: string }>(API, {
    validate: (value) => {
      if (value.status !== "success") {
        throw new CninfoError("UPSTREAM", "not ready", { retryable: true });
      }
    },
  });
  assert.equal(body.status, "success");
  assert.equal(attempt, 3);
});

test("follows redirects only within the allowlist", async () => {
  const { fetch } = fakeFetch({
    [`${API}/hop`]: () =>
      new Response(null, { status: 302, headers: { location: "https://static.cninfo.com.cn/ok" } }),
    "https://static.cninfo.com.cn/ok": () => json({ landed: true }),
    [`${API}/escape`]: () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } }),
    [`${API}/loop`]: () => new Response(null, { status: 302, headers: { location: `${API}/loop` } }),
  });
  const client = testClient(fetch);
  assert.deepEqual(await client.getJson(`${API}/hop`), { landed: true });
  await rejectsWith(client.getJson(`${API}/escape`), "FORBIDDEN_URL");
  await rejectsWith(client.getJson(`${API}/loop`), "UPSTREAM");
});

test("a redirected POST continues as GET without replaying the form", async () => {
  const { fetch, calls } = fakeFetch({
    [`${API}/moved`]: () => new Response(null, { status: 302, headers: { location: `${API}/new` } }),
    [`${API}/new`]: () => json({ ok: true }),
  });
  await testClient(fetch).postForm(`${API}/moved`, { secret: "form-value" });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
  assert.deepEqual(calls[1]!.form, {});
});

test("enforces the response size limit", async () => {
  const { fetch } = fakeFetch({ [API]: () => new Response(new Uint8Array(2048)) });
  await rejectsWith(testClient(fetch).getBytes(API, { maxBytes: 1024 }), "TOO_LARGE");
});

test("posts form bodies with browser-like headers", async () => {
  const { fetch, calls } = fakeFetch({ [API]: () => json([]) });
  await testClient(fetch).postForm(API, { keyWord: "茅台", maxNum: 10 });
  assert.equal(calls[0]!.method, "POST");
  assert.deepEqual(calls[0]!.form, { keyWord: "茅台", maxNum: "10" });
  assert.match(calls[0]!.headers["Content-Type"]!, /x-www-form-urlencoded/);
  assert.equal(calls[0]!.headers["User-Agent"], "test-agent");
});

test("never exceeds the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const { fetch } = fakeFetch({
    [API]: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json({});
    },
  });
  const client = testClient(fetch, { concurrency: 2 });
  await Promise.all(Array.from({ length: 9 }, (_, i) => client.getJson(`${API}?i=${i}`)));
  assert.equal(peak, 2);
});

test("times out slow requests as retryable and reports TIMEOUT", async () => {
  const fetch = (_url: string, init: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  const client = testClient(fetch, { timeoutMs: 20, maxAttempts: 2 });
  const error = await rejectsWith(client.getJson(API), "TIMEOUT");
  assert.equal(error.retryable, true);
});
