import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AnnouncementService,
  cleanTitle,
  normalizeAnnouncement,
  resolveCategory,
  resolveDocumentUrl,
} from "../src/announcements.ts";
import { CninfoError } from "../src/errors.ts";
import type { Security } from "../src/securities.ts";
import { fakeFetch, json, rawAnnouncement, testClient } from "./helpers.ts";

const QUERY = "https://www.cninfo.com.cn/new/hisAnnouncement/query";
const PINGAN: Security = {
  code: "000001",
  name: "平安银行",
  orgId: "gssz0000001",
  category: "A股",
  market: "SZ",
  board: "深主板",
  column: "szse",
};

function pageOf(start: number, count: number): unknown[] {
  return Array.from({ length: count }, (_, i) =>
    rawAnnouncement(start + i, `公告${start + i}`, "2026-01-05", { orgId: "gssz0000001", secCode: "000001" }),
  );
}

test("normalizeAnnouncement converts timestamps to Beijing dates and absolute URLs", () => {
  const item = normalizeAnnouncement({
    announcementId: "1225114741",
    secCode: "600519",
    secName: "贵州 茅台",
    announcementTitle: "贵州茅台<em>2025</em>年年度报告",
    announcementTime: Date.parse("2026-04-16T16:00:00Z"), // 2026-04-17 00:00 Beijing
    adjunctUrl: "finalpage/2026-04-17/1225114741.PDF",
    adjunctType: "PDF",
    adjunctSize: 1058,
  });
  assert.deepEqual(item, {
    id: "1225114741",
    code: "600519",
    name: "贵州茅台",
    title: "贵州茅台2025年年度报告",
    date: "2026-04-17",
    url: "https://static.cninfo.com.cn/finalpage/2026-04-17/1225114741.PDF",
    format: "PDF",
    size_kb: 1058,
  });
  const timed = normalizeAnnouncement({
    announcementId: 1,
    announcementTime: Date.parse("2026-10-21T01:16:00Z"),
    adjunctUrl: "finalpage/1989-03-10/60125.html",
    adjunctType: null,
  });
  assert.equal(timed?.time, "09:16");
  assert.equal(timed?.format, "HTML");
});

test("normalizeAnnouncement drops records without a usable attachment", () => {
  assert.equal(normalizeAnnouncement({ announcementId: 1, adjunctUrl: "" }), undefined);
  assert.equal(normalizeAnnouncement({ announcementId: 1, adjunctUrl: "https://evil.example.com/a.pdf" }), undefined);
});

test("resolveDocumentUrl confines documents to the static host", () => {
  assert.equal(
    resolveDocumentUrl("finalpage/2026-04-17/1.PDF"),
    "https://static.cninfo.com.cn/finalpage/2026-04-17/1.PDF",
  );
  assert.equal(
    resolveDocumentUrl("http://static.cninfo.com.cn/finalpage/1.PDF".replace("http:", "https:")),
    "https://static.cninfo.com.cn/finalpage/1.PDF",
  );
  for (const bad of [
    "",
    "http://static.cninfo.com.cn/a.pdf",
    "https://www.cninfo.com.cn/a.pdf",
    "//evil.example.com/a.pdf",
    "https://static.cninfo.com.cn@evil.example.com/a.pdf",
    "finalpage/a b.pdf",
    "finalpage\\..\\a.pdf",
  ]) {
    assert.throws(() => resolveDocumentUrl(bad), CninfoError, bad);
  }
});

test("resolveCategory accepts friendly names, Chinese labels and raw ids", () => {
  assert.equal(resolveCategory("earnings_forecast", "announcements"), "category_yjygjxz_szsh");
  assert.equal(resolveCategory("业绩预告", "announcements"), "category_yjygjxz_szsh");
  assert.equal(resolveCategory("category_ndbg_jjgg", "announcements"), "category_ndbg_jjgg");
  assert.equal(resolveCategory("research", "investor_relations"), "category_dyhd_szdy");
  assert.throws(() => resolveCategory("回购", "announcements"), /Unknown category/);
});

test("cleanTitle strips highlight markup and entities", () => {
  assert.equal(cleanTitle("关于<em>回购</em>公司股份 &amp; 进展的公告"), "关于回购公司股份 & 进展的公告");
  assert.equal(cleanTitle(null), "");
});

test("fetches the remaining pages concurrently and deduplicates", async () => {
  const { fetch, calls } = fakeFetch({
    [QUERY]: (call) => {
      const page = Number(call.form.pageNum);
      const items = page === 1 ? pageOf(1, 30) : page === 2 ? [...pageOf(30, 1), ...pageOf(31, 29)] : pageOf(60, 10);
      return json({ totalAnnouncement: 70, announcements: items });
    },
  });
  const service = new AnnouncementService(testClient(fetch));
  const result = await service.query({ securities: [PINGAN], limit: 100 });
  assert.equal(result.total, 70);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 3);
  // announcement 30 appears on pages 1 and 2 (upstream shifted by a new filing) but is returned once
  assert.equal(result.items.length, 69);
  assert.equal(new Set(result.items.map((item) => item.id)).size, 69);
});

test("limit and offset only fetch the pages they need", async () => {
  const { fetch, calls } = fakeFetch({
    [QUERY]: (call) =>
      json({ totalAnnouncement: 300, announcements: pageOf((Number(call.form.pageNum) - 1) * 30 + 1, 30) }),
  });
  const service = new AnnouncementService(testClient(fetch));
  const result = await service.query({ securities: [PINGAN], limit: 10, offset: 65 });
  assert.deepEqual(calls.map((call) => call.form.pageNum), ["3"]);
  assert.deepEqual(result.items.map((item) => Number(item.id)), [66, 67, 68, 69, 70, 71, 72, 73, 74, 75]);
});

test("next offset accounts for upstream rows that are dropped", async () => {
  const rows = [
    ...pageOf(1, 4),
    { announcementId: "x1", adjunctUrl: "" }, // no attachment: dropped
    ...pageOf(1, 1), // duplicate of the first row: dropped
    ...pageOf(5, 4),
  ];
  const { fetch } = fakeFetch({ [QUERY]: () => json({ totalAnnouncement: 10, announcements: rows }) });
  const service = new AnnouncementService(testClient(fetch));
  const first = await service.query({ securities: [PINGAN], limit: 5 });
  assert.deepEqual(first.items.map((item) => Number(item.id)), [1, 2, 3, 4, 5]);
  assert.equal(first.nextOffset, 7); // rows 0-6 were consumed to produce five items
  const second = await service.query({ securities: [PINGAN], limit: 5, offset: first.nextOffset });
  assert.deepEqual(second.items.map((item) => Number(item.id)), [6, 7, 8]);
  assert.equal(second.nextOffset, 10);
  // a window made up entirely of dropped rows still advances
  const empty = await service.query({ securities: [PINGAN], limit: 1, offset: 4 });
  assert.equal(empty.nextOffset > 4, true);
});

test("reports partial results when a page keeps failing", async () => {
  const { fetch } = fakeFetch({
    [QUERY]: (call) =>
      call.form.pageNum === "2"
        ? new Response("", { status: 500 })
        : json({ totalAnnouncement: 80, announcements: pageOf((Number(call.form.pageNum) - 1) * 30 + 1, 30) }),
  });
  const service = new AnnouncementService(testClient(fetch));
  const result = await service.query({ securities: [PINGAN], limit: 100 });
  assert.equal(result.complete, false);
  assert.equal(result.items.length, 60);
  assert.match(result.warnings[0]!, /Page 2 failed/);
});

test("partial results are not cached, so the next call retries", async () => {
  let failing = true;
  const { fetch } = fakeFetch({
    [QUERY]: (call) =>
      failing && call.form.pageNum === "2"
        ? new Response("", { status: 500 })
        : json({ totalAnnouncement: 40, announcements: pageOf((Number(call.form.pageNum) - 1) * 30 + 1, call.form.pageNum === "1" ? 30 : 10) }),
  });
  const service = new AnnouncementService(testClient(fetch));
  assert.equal((await service.query({ securities: [PINGAN], limit: 100 })).complete, false);
  failing = false;
  const retried = await service.query({ securities: [PINGAN], limit: 100 });
  assert.equal(retried.complete, true);
  assert.equal(retried.items.length, 40);
});

test("a failing first page fails the query", async () => {
  const { fetch } = fakeFetch({ [QUERY]: () => new Response("", { status: 500 }) });
  const service = new AnnouncementService(testClient(fetch));
  await assert.rejects(service.query({ securities: [PINGAN], limit: 10 }), /500/);
});

test("retries malformed pages instead of treating them as empty", async () => {
  let attempt = 0;
  const { fetch } = fakeFetch({
    [QUERY]: () => {
      attempt += 1;
      return attempt === 1 ? json({ unexpected: true }) : json({ totalAnnouncement: 1, announcements: pageOf(1, 1) });
    },
  });
  const result = await new AnnouncementService(testClient(fetch)).query({ securities: [PINGAN], limit: 10 });
  assert.equal(result.items.length, 1);
  assert.equal(attempt, 2);
});

test("builds the upstream form from filters", async () => {
  const { fetch, calls } = fakeFetch({ [QUERY]: () => json({ totalAnnouncement: 0, announcements: null }) });
  const service = new AnnouncementService(testClient(fetch));
  const result = await service.query({
    categories: ["业绩预告", "dividend"],
    keyword: " 预增 ",
    startDate: "2026-10-01",
    plate: "SZCY",
    sort: "oldest",
    tab: "announcements",
    limit: 30,
  });
  assert.deepEqual(result.items, []);
  const form = calls[0]!.form;
  assert.equal(form.column, "szse");
  assert.equal(form.tabName, "fulltext");
  assert.equal(form.category, "category_yjygjxz_szsh;category_qyfpxzcs_szsh");
  assert.equal(form.searchkey, "预增");
  assert.equal(form.seDate, "2026-10-01~2099-12-31");
  assert.equal(form.plate, "szcy");
  assert.equal(form.sortName, "time");
  assert.equal(form.sortType, "asc");
});

test("queries every code of an issuer", async () => {
  const { fetch, calls } = fakeFetch({ [QUERY]: () => json({ totalAnnouncement: 0, announcements: [] }) });
  const service = new AnnouncementService(testClient(fetch));
  const bShare: Security = { ...PINGAN, code: "900901", orgId: "gssh0600602", aliases: ["600602"] };
  await service.query({ securities: [bShare, PINGAN], limit: 10 });
  assert.equal(calls[0]!.form.stock, "900901,gssh0600602;600602,gssh0600602;000001,gssz0000001");
});

test("rejects invalid filters before any request", async () => {
  const { fetch, calls } = fakeFetch({});
  const service = new AnnouncementService(testClient(fetch));
  await assert.rejects(service.query({ startDate: "2026-02-30", limit: 1 }), /valid date/);
  await assert.rejects(service.query({ startDate: "2026-03-01", endDate: "2026-01-01", limit: 1 }), /after end_date/);
  await assert.rejects(service.query({ plate: "nyse", limit: 1 }), /Unknown market/);
  const hk: Security = { ...PINGAN, code: "00700", column: "hke" };
  await assert.rejects(service.query({ securities: [PINGAN, hk], limit: 1 }), /same market group/);
  assert.equal(calls.length, 0);
});

test("identical queries within the TTL share one upstream call", async () => {
  const { fetch, calls } = fakeFetch({ [QUERY]: () => json({ totalAnnouncement: 1, announcements: pageOf(1, 1) }) });
  const service = new AnnouncementService(testClient(fetch));
  await Promise.all([
    service.query({ securities: [PINGAN], limit: 10 }),
    service.query({ securities: [PINGAN], limit: 10 }),
  ]);
  await service.query({ securities: [PINGAN], limit: 10 });
  assert.equal(calls.length, 1);
});
