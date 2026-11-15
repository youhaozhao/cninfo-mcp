import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CninfoError } from "../src/errors.ts";
import {
  SecurityDirectory,
  classifySecurity,
  normalizeName,
  parseSecurityQuery,
} from "../src/securities.ts";
import { HK_LIST, LIST_ROUTES, STOCK_LIST, fakeFetch, json, tempDir, testClient } from "./helpers.ts";

const TOP_SEARCH = "https://www.cninfo.com.cn/new/information/topSearch/query";

test("parseSecurityQuery understands common code notations", () => {
  assert.deepEqual(parseSecurityQuery(" 600519 "), { text: "600519", code: "600519" });
  assert.deepEqual(parseSecurityQuery("sh600519"), { text: "sh600519", code: "600519", marketHint: "SH" });
  assert.deepEqual(parseSecurityQuery("000001.SZ"), { text: "000001.SZ", code: "000001", marketHint: "SZ" });
  assert.deepEqual(parseSecurityQuery("700.HK"), { text: "700.HK", code: "00700", marketHint: "HK" });
  assert.deepEqual(parseSecurityQuery("00700"), { text: "00700", code: "00700", marketHint: "HK" });
  assert.deepEqual(parseSecurityQuery("贵州茅台"), { text: "贵州茅台" });
  assert.throws(() => parseSecurityQuery("  "), CninfoError);
});

test("classifySecurity maps codes to exchanges and boards", () => {
  assert.deepEqual(classifySecurity("600519", "A股"), { market: "SH", board: "沪主板", column: "szse" });
  assert.equal(classifySecurity("688981", "A股").board, "科创板");
  assert.equal(classifySecurity("900901", "B股").board, "沪市B股");
  assert.equal(classifySecurity("000001", "A股").board, "深主板");
  assert.equal(classifySecurity("300750", "A股").board, "创业板");
  assert.equal(classifySecurity("920185", "A股").market, "BJ");
  assert.equal(classifySecurity("835185", "A股").market, "BJ");
  assert.equal(classifySecurity("430047", "A股").market, "BJ");
  assert.deepEqual(classifySecurity("00700", "港股"), { market: "HK", board: "港股", column: "hke" });
  assert.equal(classifySecurity("159915", "ETF", "fund").column, "fund");
});

test("normalizeName ignores spacing and full-width forms", () => {
  assert.equal(normalizeName("万 科Ａ"), normalizeName("万科A"));
});

test("resolves codes and names from the cached directory with one download", async () => {
  const { fetch, calls } = fakeFetch(LIST_ROUTES);
  const directory = new SecurityDirectory(testClient(fetch), await tempDir());
  const [byCode, byName, byPrefixed, oldBse, spaced] = await Promise.all([
    directory.resolve("600519"),
    directory.resolve("贵州茅台"),
    directory.resolve("SZ000001"),
    directory.resolve("835185"),
    directory.resolve("万科A"),
  ]);
  assert.equal(byCode.orgId, "gssh0600519");
  assert.equal(byName.code, "600519");
  assert.equal(byPrefixed.name, "平安银行");
  assert.equal(oldBse.orgId, "gfbj0835185");
  assert.equal(spaced.code, "000002");
  assert.equal(calls.filter((call) => call.url.includes("szse_stock")).length, 1);
});

test("links the codes of one issuer so queries cover all of them", async () => {
  const { fetch } = fakeFetch({
    "https://www.cninfo.com.cn/new/data/szse_stock.json": () =>
      json({
        stockList: [
          ...STOCK_LIST.stockList,
          { code: "600602", pinyin: "yszl", category: "A股", orgId: "gssh0600602", zwjc: "云赛智联" },
        ],
      }),
  });
  const directory = new SecurityDirectory(testClient(fetch), await tempDir());
  // B-share disclosures are filed under the A-share code, Beijing filings under old and new codes
  assert.deepEqual((await directory.resolve("900901")).aliases, ["600602"]);
  assert.deepEqual((await directory.resolve("600602")).aliases, ["900901"]);
  assert.deepEqual((await directory.resolve("835185")).aliases, ["920185"]);
  assert.equal((await directory.resolve("600519")).aliases, undefined);
});

test("resolves Hong Kong codes from the Hong Kong list", async () => {
  const { fetch } = fakeFetch(LIST_ROUTES);
  const directory = new SecurityDirectory(testClient(fetch), await tempDir());
  const tencent = await directory.resolve("700.HK");
  assert.deepEqual([tencent.code, tencent.market, tencent.column], ["00700", "HK", "hke"]);
  // a company listed in both markets resolves to its A share by name
  assert.equal((await directory.resolve("宁德时代")).code, "300750");
});

test("falls back to the suggestion API for securities outside the lists", async () => {
  const { fetch } = fakeFetch({
    ...LIST_ROUTES,
    [TOP_SEARCH]: (call) =>
      json(
        call.form.keyWord === "159915"
          ? [{ code: "159915", category: "ETF", type: "fund", orgId: "jjjl0000041", zwjc: "创业板ETF易方达" }]
          : [],
      ),
  });
  const directory = new SecurityDirectory(testClient(fetch), await tempDir());
  const etf = await directory.resolve("159915");
  assert.deepEqual([etf.market, etf.column], ["FUND", "fund"]);
  await assert.rejects(directory.resolve("999999"), /No security found/);
  await assert.rejects(directory.resolve("不存在的公司"), /No security found/);
});

test("reports ambiguous names with candidates", async () => {
  const { fetch } = fakeFetch({
    ...LIST_ROUTES,
    [TOP_SEARCH]: () =>
      json([
        { code: "00700", category: "港股", type: "hke", orgId: "gshk0000700", zwjc: "腾讯控股" },
        { code: "01698", category: "港股", type: "hke", orgId: "9900056812", zwjc: "腾讯音乐-SW" },
      ]),
  });
  const directory = new SecurityDirectory(testClient(fetch), await tempDir());
  await assert.rejects(directory.resolve("腾讯"), (error: unknown) => {
    assert.ok(error instanceof CninfoError);
    assert.equal(error.code, "AMBIGUOUS");
    assert.equal((error.details as { candidates: unknown[] }).candidates.length, 2);
    return true;
  });
});

test("search ranks exact, prefix and pinyin matches locally", async () => {
  const { fetch, calls } = fakeFetch(LIST_ROUTES);
  const directory = new SecurityDirectory(testClient(fetch), await tempDir());
  assert.equal((await directory.search("茅台"))[0]!.code, "600519");
  assert.deepEqual((await directory.search("ndsd")).map((s) => s.code).sort(), ["03750", "300750"]);
  assert.deepEqual((await directory.search("0000")).map((s) => s.code), ["000001", "000002"]);
  assert.equal((await directory.search("btr", 1)).length, 1);
  assert.equal(calls.some((call) => call.url === TOP_SEARCH), false);
});

test("uses the disk copy across restarts and when the upstream is down", async () => {
  const cacheDir = await tempDir();
  const online = fakeFetch(LIST_ROUTES);
  await new SecurityDirectory(testClient(online.fetch), cacheDir).resolve("600519");

  // a fresh process within the TTL does not download again
  const second = fakeFetch(LIST_ROUTES);
  await new SecurityDirectory(testClient(second.fetch), cacheDir).resolve("000001");
  assert.equal(second.calls.length, 0);

  // once stale, a failing upstream falls back to the stale copy instead of failing
  const offline = fakeFetch({});
  const later = Date.now() + 48 * 60 * 60 * 1000;
  const stale = new SecurityDirectory(testClient(offline.fetch), cacheDir, () => later);
  assert.equal((await stale.resolve("300750")).name, "宁德时代");
  assert.ok(offline.calls.length > 0);
});

test("fails clearly when the list is unavailable and nothing is cached", async () => {
  const { fetch } = fakeFetch({});
  const directory = new SecurityDirectory(testClient(fetch), await tempDir());
  await assert.rejects(directory.resolve("600519"), /security list/);
});

test("ignores a corrupt disk cache", async () => {
  const cacheDir = await tempDir();
  await fs.mkdir(path.join(cacheDir, "lists"), { recursive: true });
  await fs.writeFile(path.join(cacheDir, "lists", "szse_stock.json"), "{not json");
  const { fetch } = fakeFetch(LIST_ROUTES);
  const directory = new SecurityDirectory(testClient(fetch), cacheDir);
  assert.equal((await directory.resolve("600519")).name, "贵州茅台");
  assert.equal(STOCK_LIST.stockList.length > 0 && HK_LIST.stockList.length > 0, true);
});
