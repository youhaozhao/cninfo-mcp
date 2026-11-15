import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CninfoError } from "../src/errors.ts";
import { isInside, resolveSaveDir, safeFileStem } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

test("resolveSaveDir keeps relative and absolute paths inside the root", async () => {
  const root = path.join(await tempDir(), "downloads"); // does not exist yet
  assert.equal(await resolveSaveDir(root), root);
  assert.equal(await resolveSaveDir(root, "  "), root);
  assert.equal(await resolveSaveDir(root, "annual/2024"), path.join(root, "annual", "2024"));
  assert.equal(await resolveSaveDir(root, path.join(root, "x")), path.join(root, "x"));
  assert.equal(await resolveSaveDir(root, "a/../b"), path.join(root, "b"));
});

test("resolveSaveDir rejects anything that escapes the root", async () => {
  const base = await tempDir();
  const root = path.join(base, "downloads");
  for (const bad of ["..", "../other", "a/../../other", "/etc", path.join(base, "downloads-evil")]) {
    await assert.rejects(resolveSaveDir(root, bad), CninfoError, bad);
  }
});

test("resolveSaveDir rejects symlinks that point outside the root", async (t) => {
  const base = await tempDir();
  const root = path.join(base, "downloads");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try {
    await fs.symlink(outside, path.join(root, "link"), "dir");
  } catch {
    t.skip("symlinks are not available on this platform");
    return;
  }
  await assert.rejects(resolveSaveDir(root, "link"), /inside the download directory/);
  await assert.rejects(resolveSaveDir(root, "link/deeper/still"), /inside the download directory/);
  // a symlink that stays inside is fine
  await fs.mkdir(path.join(root, "real"));
  await fs.symlink(path.join(root, "real"), path.join(root, "alias"), "dir");
  assert.equal(await resolveSaveDir(root, "alias/sub"), path.join(root, "real", "sub"));
});

test("isInside is not fooled by sibling prefixes", () => {
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
  assert.equal(isInside("/a/b", "/a/b/..hidden"), true);
  assert.equal(isInside("/a/b", "/a/b/../c"), false);
});

test("safeFileStem removes unsafe characters and truncates by bytes", () => {
  assert.equal(safeFileStem('600519_贵州茅台_2025年年度报告: "全文"/<终稿>?'), "600519_贵州茅台_2025年年度报告 全文终稿");
  assert.equal(safeFileStem("../../etc/passwd"), "etcpasswd");
  assert.equal(safeFileStem(" . "), "document");
  const long = safeFileStem("报".repeat(200), 180);
  assert.equal(Buffer.byteLength(long, "utf8"), 180);
  assert.equal(long, "报".repeat(60));
});
