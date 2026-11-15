/**
 * 真实访问巨潮的端到端冒烟测试：通过 stdio 启动服务器并逐个调用工具。
 * 不属于默认测试集（会联网），用 `npm run test:live` 运行。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDir } from "../helpers.ts";

const enabled = process.env.CNINFO_LIVE === "1";
const client = new Client({ name: "live-test", version: "0.0.0" });

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.notEqual(result.isError, true, text);
  return { text, data: result.structuredContent as Record<string, any> };
}

before(async () => {
  if (!enabled) return;
  const root = await tempDir("cninfo-mcp-live-");
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(import.meta.dirname, "..", "..", "src", "cli.ts")],
      env: {
        ...(process.env as Record<string, string>),
        CNINFO_MCP_DOWNLOAD_DIR: path.join(root, "downloads"),
        CNINFO_MCP_CACHE_DIR: path.join(root, "cache"),
      },
    }),
  );
});

after(async () => {
  if (enabled) await client.close();
});

test("live: resolve, list, read and download a report", { skip: !enabled, timeout: 120_000 }, async () => {
  const found = await call("search_securities", { query: "茅台" });
  assert.equal(found.data.securities[0].code, "600519");

  const reports = await call("list_reports", { stock: "贵州茅台", report_type: "q3" });
  assert.equal(reports.data.complete, true);
  assert.ok(reports.data.count >= 10);
  const latest = reports.data.reports[0];
  assert.match(latest.url, /^https:\/\/static\.cninfo\.com\.cn\/finalpage\//);

  const overview = await call("read_document", { url: latest.url, max_chars: 2000 });
  assert.match(overview.text, /PDF · \d+ pages · \d{4,} characters/);
  assert.match(overview.text, /--- page 1 \//);
  const hits = await call("read_document", { url: latest.url, query: "营业收入" });
  assert.match(hits.text, /found on [1-9]\d* page/);

  const saved = await call("download_reports", { stock: "600519", report_type: "q3", year: latest.year });
  assert.equal(saved.data.complete, true);
  assert.equal(saved.data.downloaded, 1);
});

test("live: Beijing exchange codes, old and new", { skip: !enabled, timeout: 60_000 }, async () => {
  const oldCode = await call("list_reports", { stock: "835185" });
  const newCode = await call("list_reports", { stock: "920185" });
  assert.ok(oldCode.data.count >= 4);
  assert.equal(oldCode.data.count, newCode.data.count);
  assert.equal(oldCode.data.reports[0].name, "贝特瑞");
});

test("live: announcement search by stock, category and market", { skip: !enabled, timeout: 60_000 }, async () => {
  const byStock = await call("search_announcements", { stock: "300750", keyword: "回购", limit: 5 });
  assert.ok(byStock.data.total >= 1);
  const market = await call("search_announcements", { categories: ["业绩预告"], limit: 5 });
  assert.equal(market.data.returned, 5);
  const hongKong = await call("search_announcements", { stock: "00700.HK", limit: 3 });
  assert.equal(hongKong.data.announcements[0].code, "00700");
  const research = await call("search_announcements", { stock: "宁德时代", source: "investor_relations", limit: 3 });
  assert.ok(research.data.total >= 1);
});

test("live: structured financial and company data", { skip: !enabled, timeout: 120_000 }, async () => {
  const financials = await call("get_financials", {
    stock: "600519",
    statements: ["indicators", "income", "balance", "cashflow"],
  });
  assert.equal(financials.data.statements.length, 4);
  const income = financials.data.statements.find((s: any) => s.statement === "income");
  assert.ok(income.rows["营业总收入"][0] > 1_000_000, "Moutai revenue is above 100 亿元 (in 万元)");

  const company = await call("get_company_data", {
    stock: "000001",
    datasets: ["profile", "top_shareholders", "shareholder_count", "dividends"],
    limit: 10,
  });
  assert.equal(company.data.data.profile.rows[0]["公司名称"], "平安银行股份有限公司");
  assert.equal(company.data.data.top_shareholders.rows.length, 10);
});
