import assert from "node:assert/strict";
import { test } from "node:test";
import { CompanyDataService } from "../src/companyData.ts";
import type { Security } from "../src/securities.ts";
import { fakeFetch, json, testClient, type Handler } from "./helpers.ts";

const DATA = "https://www.cninfo.com.cn/data20/";
const MOUTAI: Security = {
  code: "600519",
  name: "贵州茅台",
  orgId: "gssh0600519",
  category: "A股",
  market: "SH",
  board: "沪主板",
  column: "szse",
};

function envelope(records: unknown[], resultMsg = "success"): Response {
  return json({ code: 200, data: { resultMsg, resultCode: resultMsg === "success" ? "200" : "-1", records } });
}

function service(routes: Record<string, Handler>) {
  const prefixed = Object.fromEntries(Object.entries(routes).map(([k, v]) => [DATA + k, v]));
  const { fetch, calls } = fakeFetch(prefixed);
  return { data: new CompanyDataService(testClient(fetch)), calls };
}

test("maps coded upstream fields to labelled columns and drops empty values", async () => {
  const { data, calls } = service({
    "stockholderCapital/getTopTenStockholders": () =>
      envelope([
        { F001D: "2026-09-30", F005N: 1, F002V: "中国贵州茅台酒厂(集团)有限责任公司", F003N: 68128.29, F004N: 54.5, F006V: "流通A股", F007V: "未变" },
        { F001D: "2026-09-30", F005N: 2, F002V: "香港中央结算有限公司", F003N: 5526.37, F004N: 4.42, F006V: "流通A股", F007V: "--" },
        { F001D: "2026-06-30", F005N: 1, F002V: "x", F003N: 1, F004N: 1, F006V: null },
      ]),
  });
  const table = await data.table(MOUTAI, "top_shareholders", 2);
  assert.equal(table.label, "十大股东");
  assert.equal(table.total, 3);
  assert.equal(table.truncated, true);
  assert.deepEqual(table.rows[0], {
    截止日期: "2026-09-30",
    名次: 1,
    股东名称: "中国贵州茅台酒厂(集团)有限责任公司",
    "持股数量(万股)": 68128.29,
    "持股比例(%)": 54.5,
    股份性质: "流通A股",
    持股变动: "未变",
  });
  assert.equal("持股变动" in table.rows[1]!, false);
  assert.match(calls[0]!.url, /scode=600519/);
});

test("retries the data service's soft failures (HTTP 200 with resultMsg=fail)", async () => {
  let attempt = 0;
  const { data } = service({
    "tradeInformation/getMarginTrading": () => {
      attempt += 1;
      return attempt < 3 ? envelope([], "fail") : envelope([{ TRADEDATE: "2026-11-12", F001N: 100 }]);
    },
  });
  const table = await data.table(MOUTAI, "margin_trading", 10);
  assert.deepEqual(table.rows, [{ 交易日期: "2026-11-12", "融资余额(元)": 100 }]);
  assert.equal(attempt, 3);
});

test("surfaces a persistent soft failure as an error, not as an empty table", async () => {
  const { data } = service({ "stockholderCapital/getLiftBan": () => envelope([], "fail") });
  await assert.rejects(data.table(MOUTAI, "unlocks", 10), /getLiftBan.*fail/);
});

test("a genuinely empty dataset is an empty table", async () => {
  const { data } = service({ "stockholderCapital/getLiftBan": () => envelope([]) });
  assert.deepEqual(await data.table(MOUTAI, "unlocks", 10), {
    dataset: "unlocks",
    label: "限售解禁",
    total: 0,
    rows: [],
  });
});

test("builds the company profile from basic and listing information", async () => {
  const { data } = service({
    "companyOverview/getCompanyIntroduction": () =>
      envelope([
        {
          basicInformation: [{ ORGNAME: "贵州茅台酒股份有限公司", F032V: "酒、饮料和精制茶制造业", F007N: 125008.1601, F012V: "" }],
          listingInformation: [{ F008N: 31.39, F047V: "某证券" }],
        },
      ]),
  });
  const table = await data.table(MOUTAI, "profile", 1);
  assert.deepEqual(table.rows[0], {
    证券代码: "600519",
    证券简称: "贵州茅台",
    公司名称: "贵州茅台酒股份有限公司",
    所属行业: "酒、饮料和精制茶制造业",
    "注册资本(万元)": 125008.1601,
    "首发价格(元)": 31.39,
    首发主承销商: "某证券",
  });
});

test("labels the direction of shareholder trades", async () => {
  const { data } = service({
    "tradeInformation/getStockholederIncDecDetail": () =>
      envelope([
        { VARYDATE: "2025-09-09", F002V: "甲", F001C: "B", F004N: 100 },
        { varydate: "2025-09-08", F002V: "乙", F001C: "S", F004N: 50 },
      ]),
  });
  const table = await data.table(MOUTAI, "shareholder_trades", 10);
  assert.deepEqual(table.rows.map((row) => [row["变动日期"], row["方向"]]), [
    ["2025-09-09", "增持"],
    ["2025-09-08", "减持"],
  ]);
});

test("aligns statement rows to periods using the company's reporting template", async () => {
  const { data, calls } = service({
    "companyOverview/getCompanyInfo": () => envelope([{ SECCODE: "600519", F002N: 2 }]),
    "financialData/getIncomeStatement": () =>
      envelope([
        {
          year: [
            { index: "营业总收入", "2025": 300, "2024": 200, "2023": 100 },
            { index: "分组标题", "2025": null, "2024": null, "2023": null },
            { index: "营业利润", "2025": 30, "2024": null, "2023": 10 },
          ],
          middle: [],
          one: [],
          three: [{ index: "营业总收入", "2026": 250 }],
        },
      ]),
  });
  const annual = await data.financials(MOUTAI, "income", "annual", 2);
  assert.deepEqual(annual, {
    statement: "income",
    label: "利润表",
    unit: "万元",
    periods: ["2025-12-31", "2024-12-31"],
    rows: { 营业总收入: [300, 200], 营业利润: [30, null] },
  });
  const q3 = await data.financials(MOUTAI, "income", "q3", 5);
  assert.deepEqual(q3.periods, ["2026-09-30"]);
  // the template sign is looked up once and passed through; the statement is cached across periods
  assert.equal(calls.filter((c) => c.url.includes("getCompanyInfo")).length, 1);
  const statementCalls = calls.filter((c) => c.url.includes("getIncomeStatement"));
  assert.equal(statementCalls.length, 1);
  assert.match(statementCalls[0]!.url, /sign=2/);
});

test("labels indicator rows and orders periods newest first", async () => {
  const { data } = service({
    "companyOverview/getCompanyInfo": () => envelope([{ F002N: 1 }]),
    "financialData/getMainIndicators": () =>
      envelope([
        {
          year: [
            { ENDDATE: "2024-12-31", F004N: 68.64, F067N: 36.02, F043N: null },
            { ENDDATE: "2025-12-31", F004N: 65.66, F067N: 32.53, F043N: null },
          ],
        },
      ]),
  });
  const table = await data.financials(MOUTAI, "indicators", "annual", 5);
  assert.deepEqual(table.periods, ["2025-12-31", "2024-12-31"]);
  assert.deepEqual(table.rows, {
    "基本每股收益(元)": [65.66, 68.64],
    "加权净资产收益率(%)": [32.53, 36.02],
  });
});

test("rejects securities the data service does not cover", async () => {
  const { data, calls } = service({});
  const tencent: Security = { ...MOUTAI, code: "00700", market: "HK", board: "港股", column: "hke" };
  await assert.rejects(data.table(tencent, "profile", 1), /not for 港股/);
  await assert.rejects(data.financials(tencent, "income", "annual", 5), /not for 港股/);
  assert.equal(calls.length, 0);
});
