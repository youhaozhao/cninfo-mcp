import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, createServices, packageVersion } from "../src/server.ts";
import {
  LIST_ROUTES,
  fakeFetch,
  json,
  makePdf,
  rawAnnouncement,
  tempDir,
  testConfig,
  type Handler,
} from "./helpers.ts";

const QUERY = "https://www.cninfo.com.cn/new/hisAnnouncement/query";
const REPORT_URL = "https://static.cninfo.com.cn/finalpage/2026-04-17/100.PDF";

const DEFAULT_ROUTES: Record<string, Handler> = {
  ...LIST_ROUTES,
  [QUERY]: (call) =>
    json({
      totalAnnouncement: 3,
      announcements:
        call.form.pageNum === "1"
          ? [
              rawAnnouncement(100, "贵州茅台2025年年度报告", "2026-04-17"),
              rawAnnouncement(101, "贵州茅台2025年年度报告摘要", "2026-04-17"),
              rawAnnouncement(102, "2024年年度报告", "2025-04-03", { secName: null }),
            ]
          : [],
    }),
  [REPORT_URL]: () =>
    new Response(makePdf(["Kweichow Moutai Annual Report", "Gross margin was 91 percent", "Risk factors"])),
  "https://static.cninfo.com.cn/finalpage/2025-04-03/102.PDF": () => new Response(makePdf(["FY2024"])),
};

async function connect(routes: Record<string, Handler> = DEFAULT_ROUTES) {
  const root = await tempDir();
  const { fetch, calls } = fakeFetch(routes);
  const config = testConfig(root);
  const services = createServices(config, { fetch, sleep: async () => {}, backoffMs: 1 });
  const server = createServer(services);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    return { result, text, data: result.structuredContent as Record<string, any> | undefined };
  };
  return { client, call, calls, config, close: () => client.close() };
}

test("advertises the tools with safety annotations and prompts", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "download_documents",
    "download_reports",
    "get_company_data",
    "get_financials",
    "list_reports",
    "read_document",
    "search_announcements",
    "search_securities",
  ]);
  for (const tool of tools) {
    const writes = tool.name.startsWith("download_");
    assert.equal(tool.annotations?.readOnlyHint, !writes, tool.name);
    assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    assert.equal(tool.annotations?.idempotentHint, true, tool.name);
    assert.equal(tool.annotations?.openWorldHint, true, tool.name);
    assert.ok(tool.description && tool.description.length > 50, tool.name);
  }
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["company_research", "earnings_review"]);
  const prompt = await client.getPrompt({ name: "company_research", arguments: { stock: "600519" } });
  assert.match((prompt.messages[0]!.content as { text: string }).text, /600519/);
  assert.equal(client.getServerVersion()?.version, packageVersion());
  await close();
});

test("list_reports resolves a name, filters bodies and fills missing names", async () => {
  const { call, close } = await connect();
  const { data, text } = await call("list_reports", { stock: "贵州茅台" });
  assert.deepEqual(JSON.parse(text), data);
  assert.equal(data!.security.code, "600519");
  assert.equal(data!.complete, true);
  assert.deepEqual(
    data!.reports.map((r: any) => [r.year, r.kind, r.name, r.url]),
    [
      [2025, "main", "贵州茅台", REPORT_URL],
      [2024, "main", "贵州茅台", "https://static.cninfo.com.cn/finalpage/2025-04-03/102.PDF"],
    ],
  );
  assert.equal("org_id" in data!.reports[0], false);
  await close();
});

test("tool failures are structured results, not protocol errors", async () => {
  const { call, close } = await connect();
  const bad = await call("list_reports", { stock: "600519", report_type: "monthly" });
  assert.equal(bad.result.isError, true);
  assert.equal(JSON.parse(bad.text).error.code, "INVALID_INPUT");
  const missing = await call("read_document", { url: "https://evil.example.com/a.pdf" });
  assert.equal(JSON.parse(missing.text).error.code, "FORBIDDEN_URL");
  const hk = await call("get_company_data", { stock: "00700.HK", datasets: ["profile"] });
  assert.equal(JSON.parse(hk.text).error.code, "INVALID_INPUT");
  await close();
});

test("search_announcements pages through results and reports totals", async () => {
  const { call, calls, close } = await connect();
  const { data } = await call("search_announcements", {
    stock: "600519, 平安银行",
    categories: ["年报"],
    start_date: "2025-01-01",
    limit: 2,
  });
  assert.equal(data!.total, 3);
  assert.equal(data!.returned, 2);
  assert.equal(data!.has_more, true);
  assert.equal(data!.next_offset, 2);
  assert.equal(data!.securities.length, 2);
  const form = calls.find((c) => c.url === QUERY)!.form;
  assert.equal(form.stock, "600519,gssh0600519;000001,gssz0000001");
  assert.equal(form.category, "category_ndbg_szsh");
  await close();
});

test("read_document offers overview, search and page modes as plain text", async () => {
  const { call, close } = await connect();
  const overview = await call("read_document", { url: REPORT_URL });
  // the text block is the single source of truth: no structured copy that could omit the body
  assert.equal(overview.data, undefined);
  assert.match(overview.text, /PDF · 3 pages/);
  assert.match(overview.text, /--- page 2 \/ 3 ---\nGross margin was 91 percent/);
  assert.doesNotMatch(overview.text, /more page\(s\) not shown/);

  const search = await call("read_document", { url: REPORT_URL, query: "margin risk" });
  assert.match(search.text, /found on 2 page\(s\)/);
  assert.match(search.text, /\[p\.2\] 1 match/);
  assert.match(search.text, /\[p\.3\] 1 match/);
  const scoped = await call("read_document", { url: REPORT_URL, query: "margin risk", pages: "3" });
  assert.match(scoped.text, /found on 1 page\(s\) within pages 3/);

  const pages = await call("read_document", { url: REPORT_URL, pages: "3" });
  assert.match(pages.text, /Risk factors/);
  assert.doesNotMatch(pages.text, /Gross margin/);
  await close();
});

test("read_document respects max_chars and says where to continue", async () => {
  // 14 short pages: more than fits in the 1000-character budget
  const pageTexts = Array.from({ length: 14 }, (_, i) => `page${String(i + 1).padStart(2, "0")} `.repeat(10).trim());
  const { call, close } = await connect({
    [REPORT_URL]: () => new Response(makePdf(pageTexts)),
  });
  const first = await call("read_document", { url: REPORT_URL, max_chars: 1000 });
  const shown = [...first.text.matchAll(/--- page (\d+) \/ 14 ---/g)].map((m) => Number(m[1]));
  assert.ok(shown.length >= 5 && shown.length < 14, String(shown));
  assert.deepEqual(shown, shown.map((_, i) => i + 1));
  assert.ok(first.text.length <= 1300, "body stays near the requested budget");
  const hint = /continue with pages="([^"]+)"/.exec(first.text)?.[1];
  assert.equal(hint, shown.length + 1 === 14 ? "14" : `${shown.length + 1}-14`);

  const rest = await call("read_document", { url: REPORT_URL, pages: hint!, max_chars: 5000 });
  assert.match(rest.text, /page14/);
  assert.doesNotMatch(rest.text, /not shown/);

  // a sparse selection continues with the pages that were asked for, not the ones in between
  const sparse = await call("read_document", { url: REPORT_URL, pages: "1,3,5-14", max_chars: 1000 });
  const sparseShown = [...sparse.text.matchAll(/--- page (\d+) \/ 14 ---/g)].map((m) => Number(m[1]));
  assert.deepEqual(sparseShown.slice(0, 3), [1, 3, 5]);
  const expectedRest = [1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].slice(sparseShown.length);
  assert.ok(expectedRest.length > 0);
  assert.match(sparse.text, new RegExp(`${expectedRest.length} more page\\(s\\) not shown: continue with pages="${expectedRest[0]}`));
  await close();
});

test("read_document applies max_chars to search results too", async () => {
  const pageTexts = Array.from({ length: 14 }, (_, i) => `margin ${"filler ".repeat(9)}margin p${i + 1}`);
  const { call, close } = await connect({
    [REPORT_URL]: () => new Response(makePdf(pageTexts)),
  });
  const full = await call("read_document", { url: REPORT_URL, query: "margin", max_chars: 20000 });
  assert.match(full.text, /found on 14 page\(s\)/);
  assert.equal([...full.text.matchAll(/\[p\.\d+\]/g)].length, 14);
  assert.doesNotMatch(full.text, /max_chars reached/);

  const capped = await call("read_document", { url: REPORT_URL, query: "margin", max_chars: 1000 });
  const shown = [...capped.text.matchAll(/\[p\.(\d+)\]/g)].length;
  assert.ok(shown >= 1 && shown < 14, String(shown));
  assert.ok(capped.text.length < 1500, String(capped.text.length));
  // pages whose snippets did not fit are still named, so nothing is silently lost
  assert.match(capped.text, new RegExp(`max_chars reached; also matched on pages ${shown + 1}-14`));
  await close();
});

test("download_reports writes only inside the download directory", async () => {
  const { call, config, close } = await connect();
  const escape = await call("download_reports", { stock: "600519", save_path: "../outside" });
  assert.equal(escape.result.isError, true);
  assert.match(escape.text, /inside the download directory/);
  await assert.rejects(fs.stat(path.join(config.downloadDir, "..", "outside")));

  const { data } = await call("download_reports", { stock: "600519", year: 2025, save_path: "moutai" });
  assert.equal(data!.complete, true);
  assert.equal(data!.downloaded, 1);
  const saved = data!.files[0].path as string;
  assert.equal(path.dirname(saved), path.join(config.downloadDir, "moutai"));
  assert.equal(path.basename(saved), "600519_贵州茅台_贵州茅台2025年年度报告_100.pdf");

  const again = await call("download_reports", { stock: "600519", year: 2025, save_path: "moutai" });
  assert.equal(again.data!.downloaded, 0);
  assert.equal(again.data!.already_existed, 1);
  await close();
});

test("download_documents reports per-file failures and is not complete", async () => {
  const { call, close } = await connect();
  const { data } = await call("download_documents", {
    urls: [REPORT_URL, "finalpage/2099-01-01/nope.PDF"],
  });
  assert.equal(data!.complete, false);
  assert.equal(data!.downloaded, 1);
  assert.equal(data!.failed, 1);
  assert.equal(data!.failures[0].url, "finalpage/2099-01-01/nope.PDF");
  await close();
});

test("get_company_data returns partial data with per-dataset errors", async () => {
  const envelope = (records: unknown[], resultMsg = "success") =>
    json({ code: 200, data: { resultMsg, records } });
  const { call, close } = await connect({
    ...LIST_ROUTES,
    "https://www.cninfo.com.cn/data20/stockholderCapital/getStockholderNum": () =>
      envelope([{ ENDDATE: "2026-09-30", F001N: 406492, F009N: -9.81 }]),
    "https://www.cninfo.com.cn/data20/stockholderCapital/getEquityPledge": () => envelope([], "fail"),
  });
  const { data } = await call("get_company_data", {
    stock: "000001",
    datasets: ["shareholder_count", "pledges"],
  });
  assert.equal(data!.complete, false);
  assert.deepEqual(data!.data.shareholder_count.rows, [
    { 截止日期: "2026-09-30", "股东人数(户)": 406492, "较上期变动(%)": -9.81 },
  ]);
  assert.equal(data!.errors[0].dataset, "pledges");
  await close();
});

test("server.json stays in sync with package.json and nothing runs at install time", async () => {
  const root = path.join(import.meta.dirname, "..");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "server.json"), "utf8"));
  assert.equal(manifest.name, pkg.mcpName);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.packages.length, 1);
  assert.equal(manifest.packages[0].identifier, pkg.name);
  assert.equal(manifest.packages[0].version, pkg.version);
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(pkg.scripts[hook], undefined, hook);
  }
  assert.equal(packageVersion(), pkg.version);
});
