import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Mutex, TtlCache, readJsonFile, writeFileAtomic } from "../src/cache.ts";
import { tempDir } from "./helpers.ts";

test("TtlCache expires entries and evicts least recently used", () => {
  let now = 0;
  const cache = new TtlCache<number>(2, () => now);
  cache.set("a", 1, 100);
  cache.set("b", 2, 100);
  assert.equal(cache.get("a"), 1); // a is now the most recently used
  cache.set("c", 3, 100);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  now = 101;
  assert.equal(cache.get("a"), undefined);
});

test("getOrLoad deduplicates concurrent loads and does not cache failures", async () => {
  const cache = new TtlCache<string>();
  let loads = 0;
  const loader = async (): Promise<string> => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "value";
  };
  const results = await Promise.all([
    cache.getOrLoad("k", 1000, loader),
    cache.getOrLoad("k", 1000, loader),
    cache.getOrLoad("k", 1000, loader),
  ]);
  assert.deepEqual(results, ["value", "value", "value"]);
  assert.equal(loads, 1);

  let attempts = 0;
  const flaky = async (): Promise<string> => {
    attempts += 1;
    if (attempts === 1) throw new Error("boom");
    return "recovered";
  };
  await assert.rejects(cache.getOrLoad("f", 1000, flaky), /boom/);
  assert.equal(await cache.getOrLoad("f", 1000, flaky), "recovered");
});

test("writeFileAtomic replaces content and leaves no temporary files", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "nested", "data.json");
  await writeFileAtomic(file, JSON.stringify({ a: 1 }));
  await writeFileAtomic(file, JSON.stringify({ a: 2 }));
  assert.deepEqual(await readJsonFile(file), { a: 2 });
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["data.json"]);
  assert.equal(await readJsonFile(path.join(dir, "missing.json")), undefined);
});

test("Mutex runs tasks one at a time and survives failures", async () => {
  const mutex = new Mutex();
  let running = 0;
  let peak = 0;
  const task = (fail: boolean) => async (): Promise<string> => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running -= 1;
    if (fail) throw new Error("task failed");
    return "done";
  };
  const results = await Promise.allSettled([
    mutex.run(task(false)),
    mutex.run(task(true)),
    mutex.run(task(false)),
  ]);
  assert.equal(peak, 1);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
});
