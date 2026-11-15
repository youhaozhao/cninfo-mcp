import assert from "node:assert/strict";
import { test } from "node:test";
import { AnnouncementService } from "../src/announcements.ts";
import { CninfoError } from "../src/errors.ts";
import { classifyReportTitle, listReports, normalizeReportType } from "../src/reports.ts";
import type { Security } from "../src/securities.ts";
import { fakeFetch, json, rawAnnouncement, testClient } from "./helpers.ts";

const MOUTAI: Security = {
  code: "600519",
  name: "贵州茅台",
  orgId: "gssh0600519",
  category: "A股",
  market: "SH",
  board: "沪主板",
  column: "szse",
};

test("normalizeReportType accepts English and Chinese aliases", () => {
  assert.equal(normalizeReportType(undefined), "annual");
  assert.equal(normalizeReportType(" Annual "), "annual");
  assert.equal(normalizeReportType("年度报告"), "annual");
  assert.equal(normalizeReportType("半年报"), "semiannual");
  assert.equal(normalizeReportType("half year"), "semiannual");
  assert.equal(normalizeReportType("一季报"), "q1");
  assert.equal(normalizeReportType("Q3"), "q3");
  assert.equal(normalizeReportType("招股书"), "prospectus");
  assert.throws(() => normalizeReportType("monthly"), CninfoError);
});

test("recognises full report bodies of each type", () => {
  const cases: Array<[string, Parameters<typeof classifyReportTitle>[1], number]> = [
    ["贵州茅台2023年年度报告", "annual", 2023],
    ["某公司2023年度报告", "annual", 2023],
    ["2024年年度报告", "annual", 2024],
    ["某公司 2023 年年报", "annual", 2023],
    ["平安银行2023年半年度报告", "semiannual", 2023],
    ["某公司2023年中期报告", "semiannual", 2023],
    ["贵州茅台2024年第一季度报告", "q1", 2024],
    ["某公司2024年一季度报告", "q1", 2024],
    ["平安银行2023年第三季度报告", "q3", 2023],
    ["某公司2023年三季度报告", "q3", 2023],
    ["某公司2023年年度报告全文", "annual", 2023],
    ["G 茅 台2006年度中期报告", "semiannual", 2006],
    ["中国石化2005年第三季度季报", "q3", 2005],
    ["2020年第一季度报告全文", "q1", 2020],
  ];
  for (const [title, type, year] of cases) {
    assert.deepEqual(classifyReportTitle(title, type), { kind: "main", year }, title);
  }
});

test("labels revised, summary and English variants instead of dropping them", () => {
  assert.equal(classifyReportTitle("某公司2023年年度报告（更新后）", "annual")?.kind, "revised");
  assert.equal(classifyReportTitle("某公司2023年年度报告(修订版)", "annual")?.kind, "revised");
  assert.equal(classifyReportTitle("某公司2024年第一季度报告（更正后）", "q1")?.kind, "revised");
  assert.equal(classifyReportTitle("贵州茅台2023年年度报告摘要", "annual")?.kind, "summary");
  assert.equal(classifyReportTitle("某公司2023年半年度报告摘要（更新后）", "semiannual")?.kind, "summary");
  assert.equal(classifyReportTitle("贵州茅台2025年年度报告（英文版）", "annual")?.kind, "english");
  assert.equal(classifyReportTitle("某公司2023年年度报告（已取消）", "annual")?.kind, "other");
  assert.equal(classifyReportTitle("2006年年度报告（调整后）", "annual")?.kind, "revised");
  // Shenzhen quarterly reports come as 全文 (full) and 正文 (the short newspaper version)
  assert.equal(classifyReportTitle("2020年第一季度报告正文", "q1")?.kind, "summary");
  assert.equal(classifyReportTitle("2020年第三季度报告正文", "q3")?.kind, "summary");
});

test("variant notes are classified the same in any order", () => {
  assert.equal(classifyReportTitle("2023年年度报告(修订稿)(英文版)", "annual")?.kind, "english");
  assert.equal(classifyReportTitle("2023年年度报告(英文版)(修订稿)", "annual")?.kind, "english");
  assert.equal(classifyReportTitle("2023年年度报告摘要(更新后)(已取消)", "annual")?.kind, "other");
  assert.equal(classifyReportTitle("H股公告-2023年度报告(更新后)", "annual")?.kind, "h_share");
});

test("labels H-share editions filed alongside the A-share report", () => {
  for (const [title, type] of [
    ["港股公告：2025年年报", "annual"],
    ["工商银行H股公告-2022年度报告", "annual"],
    ["H股公告-2018年中期报告", "semiannual"],
    ["工商银行H股公告——2025年第三季度报告", "q3"],
  ] as const) {
    assert.equal(classifyReportTitle(title, type)?.kind, "h_share", title);
  }
  assert.equal(classifyReportTitle("H股公告-关于2022年度报告的更正公告", "annual"), undefined);
});

test("does not confuse report types with each other", () => {
  assert.equal(classifyReportTitle("某公司2024年第三季度报告", "q1"), undefined);
  assert.equal(classifyReportTitle("某公司2024年第一季度报告", "q3"), undefined);
  assert.equal(classifyReportTitle("某公司2023年半年度报告", "annual"), undefined);
  assert.equal(classifyReportTitle("某公司2023半年度报告", "annual"), undefined);
  assert.equal(classifyReportTitle("某公司2023年年度报告", "semiannual"), undefined);
});

test("rejects announcements that are merely about a report", () => {
  for (const title of [
    "关于2023年年度报告的更正公告",
    "关于2023年年度报告的补充说明",
    "2023年年度报告更正公告",
    "关于延期披露2023年年度报告的提示性公告",
    "2023年年度报告的审计意见",
    "董事会关于公司2023年年度报告",
  ]) {
    assert.equal(classifyReportTitle(title, "annual"), undefined, title);
  }
});

test("accepts prospectus bodies in any review version", () => {
  for (const suffix of ["", "（申报稿）", "（注册稿）", "（上会稿）", "(封卷稿)"]) {
    const title = "某公司首次公开发行股票并上市招股说明书" + suffix;
    assert.deepEqual(classifyReportTitle(title, "prospectus"), { kind: "main" }, title);
  }
  assert.ok(classifyReportTitle("某公司招股意向书", "prospectus"));
});

test("rejects prospectus-related documents that are not the prospectus", () => {
  for (const title of [
    "中科德芯招股说明书摘要",
    "某公司招股意向书更正公告",
    "保荐机构关于招股说明书的核查意见",
    "律师对招股说明书的验证报告",
    "招股说明书问询回复",
    "招股说明书（核查意见）",
    "招股说明书（封卷稿）（摘要）",
    "招股说明书（封卷稿）（英文）",
    "招股说明书（审计报告）",
    "招股说明书（附件）",
    "招股说明书（附录）",
  ]) {
    assert.equal(classifyReportTitle(title, "prospectus"), undefined, title);
  }
});

function service(pages: Record<number, unknown[]>, total: number) {
  const { fetch, calls } = fakeFetch({
    "https://www.cninfo.com.cn/new/hisAnnouncement/query": (call) =>
      json({ totalAnnouncement: total, announcements: pages[Number(call.form.pageNum)] ?? [] }),
  });
  return { announcements: new AnnouncementService(testClient(fetch)), calls };
}

test("listReports keeps only report bodies, newest fiscal year first", async () => {
  const { announcements, calls } = service(
    {
      1: [
        rawAnnouncement(5, "贵州茅台2024年年度报告摘要", "2025-04-03"),
        rawAnnouncement(4, "贵州茅台2024年年度报告", "2025-04-03"),
        rawAnnouncement(3, "贵州茅台2023年年度报告（英文版）", "2024-04-03"),
        rawAnnouncement(2, "贵州茅台2023年年度报告", "2024-04-03"),
        rawAnnouncement(1, "关于2023年年度报告的更正公告", "2024-05-01"),
      ],
    },
    5,
  );
  const listing = await listReports(announcements, MOUTAI, "annual");
  assert.deepEqual(
    listing.items.map((item) => [item.year, item.kind, item.id]),
    [
      [2024, "main", "4"],
      [2023, "main", "2"],
    ],
  );
  assert.equal(listing.complete, true);
  // one request, addressed by orgId, restricted to the annual-report category
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.form.stock, "600519,gssh0600519");
  assert.equal(calls[0]!.form.category, "category_ndbg_szsh");
  assert.equal(calls[0]!.form.searchkey, "");
});

test("listReports filters by fiscal year and can include variants", async () => {
  const { announcements } = service(
    {
      1: [
        rawAnnouncement(5, "贵州茅台2024年年度报告摘要", "2025-04-03"),
        rawAnnouncement(4, "贵州茅台2024年年度报告", "2025-04-03"),
        rawAnnouncement(2, "贵州茅台2023年年度报告", "2024-04-03"),
      ],
    },
    3,
  );
  const only = await listReports(announcements, MOUTAI, "annual", { year: 2023 });
  assert.deepEqual(only.items.map((item) => item.id), ["2"]);
  const all = await listReports(announcements, MOUTAI, "annual", { year: 2024, includeVariants: true });
  assert.deepEqual(all.items.map((item) => item.kind).sort(), ["main", "summary"]);
});

test("prospectus listing searches by keyword and filters by disclosure year", async () => {
  const { announcements, calls } = service(
    {
      1: [
        rawAnnouncement(9, "首次公开发行股票并在科创板上市招股说明书", "2020-07-13"),
        rawAnnouncement(8, "首次公开发行股票招股说明书（申报稿）", "2019-12-01"),
        rawAnnouncement(7, "关于招股说明书的核查意见", "2020-07-01"),
      ],
    },
    3,
  );
  const listing = await listReports(announcements, MOUTAI, "prospectus", { year: 2020 });
  assert.deepEqual(listing.items.map((item) => item.id), ["9"]);
  assert.equal(calls[0]!.form.searchkey, "招股");
  assert.equal(calls[0]!.form.category, "");
});

test("listReports refuses markets it cannot classify", async () => {
  const { announcements } = service({}, 0);
  const tencent: Security = { ...MOUTAI, code: "00700", market: "HK", board: "港股", column: "hke" };
  await assert.rejects(listReports(announcements, tencent, "annual"), /search_announcements/);
});
