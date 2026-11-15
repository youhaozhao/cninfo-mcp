import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AnnouncementService,
  CATEGORIES,
  PLATES,
  RELATION_CATEGORIES,
  type Announcement,
} from "./announcements.ts";
import {
  CompanyDataService,
  DATASET_LABELS,
  assertAShare,
  type Dataset,
  type Period,
  type Statement,
} from "./companyData.ts";
import { DOWNLOAD_DIR_ENV, loadConfig, type Config } from "./config.ts";
import {
  DocumentService,
  formatPageSpec,
  parsePageSpec,
  searchPages,
  type DownloadOutcome,
} from "./documents.ts";
import { CninfoError, errorMessage, invalid } from "./errors.ts";
import { HttpClient, type HttpClientOptions } from "./http.ts";
import { resolveSaveDir } from "./paths.ts";
import { REPORT_TYPES, listReports, normalizeReportType } from "./reports.ts";
import { SecurityDirectory, publicSecurity, type Security } from "./securities.ts";

export function packageVersion(): string {
  try {
    const manifest = new URL("../package.json", import.meta.url);
    return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface Services {
  config: Config;
  http: HttpClient;
  securities: SecurityDirectory;
  announcements: AnnouncementService;
  companyData: CompanyDataService;
  documents: DocumentService;
}

export function createServices(
  config: Config = loadConfig(),
  httpOverrides: Partial<HttpClientOptions> = {},
): Services {
  const http = new HttpClient({
    concurrency: config.concurrency,
    minIntervalMs: config.minIntervalMs,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    userAgent: config.userAgent,
    ...httpOverrides,
  });
  return {
    config,
    http,
    securities: new SecurityDirectory(http, config.cacheDir),
    announcements: new AnnouncementService(http),
    companyData: new CompanyDataService(http),
    documents: new DocumentService(http, config.cacheDir, config.cacheMaxBytes),
  };
}

const INSTRUCTIONS = [
  "China-market disclosure research on CNINFO (巨潮资讯网, the CSRC-designated disclosure site): Shanghai, Shenzhen and Beijing listed companies, plus Hong Kong announcements.",
  "Typical flow: search_securities to resolve a company -> list_reports or search_announcements to find filings -> read_document to read them (use its query argument to locate sections such as 管理层讨论与分析 or 主要会计数据 instead of reading a whole annual report).",
  "get_financials and get_company_data return structured data (statements, key ratios, shareholders, dividends, pledges, block trades) without opening any PDF.",
  "Every stock argument accepts a code (600519, 000001.SZ, 00700.HK) or a Chinese short name (贵州茅台).",
  "Results with complete=false are partial: say so rather than treating them as the full picture. Data comes from an unofficial interface and is not investment advice.",
].join(" ");

const stockSchema = z
  .string()
  .min(1)
  .max(40)
  .describe("Stock code or Chinese short name, e.g. 600519, 000001.SZ, 920185, 00700.HK, 贵州茅台");

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// 下载工具会在下载根目录内写文件；文件名带公告 ID，重复调用命中同一文件，因此幂等且非破坏性
const WRITES_FILES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data) }],
    structuredContent: data,
  };
}

/**
 * 纯文本结果，用于文档正文：正文只放在文本块里，不再复制一份到 structuredContent，
 * 这样无论客户端把哪一部分交给模型，读到的都是同一份完整内容。
 */
function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(error: unknown): CallToolResult {
  const known = error instanceof CninfoError;
  const payload: Record<string, unknown> = {
    code: known ? error.code : "INTERNAL",
    message: errorMessage(error),
  };
  if (known && error.retryable) payload.retryable = true;
  if (known && error.details !== undefined) payload.details = error.details;
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: payload }) }] };
}

/** 统一的工具外壳：任何异常都变成结构化的 isError 结果，而不是协议层错误。 */
function guarded<Args>(
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return fail(error);
    }
  };
}

/** 去掉只在内部使用的字段；report_type 在响应顶层已有，不必每条重复。 */
function publicAnnouncement(item: Announcement & { report_type?: string }): Record<string, unknown> {
  const { org_id: _orgId, report_type: _type, ...rest } = item;
  return rest;
}

function downloadPayload(outcome: DownloadOutcome, directory: string): Record<string, unknown> {
  const downloaded = outcome.files.filter((f) => f.status === "downloaded").length;
  const existing = outcome.files.length - downloaded;
  return {
    directory,
    downloaded,
    already_existed: existing,
    failed: outcome.failures.length,
    files: outcome.files,
    failures: outcome.failures,
  };
}

export function createServer(services: Services = createServices()): McpServer {
  const { config, securities, announcements, companyData, documents } = services;
  const server = new McpServer(
    { name: "cninfo-mcp", title: "CNINFO 巨潮资讯 (unofficial)", version: packageVersion() },
    { instructions: INSTRUCTIONS },
  );

  /** 上游对北交所等记录不返回简称，用证券目录补齐。 */
  async function fillNames<T extends { code: string; name: string }>(items: T[]): Promise<T[]> {
    await Promise.all(
      items.map(async (item) => {
        if (!item.name && item.code) item.name = (await securities.nameOf(item.code)) ?? "";
      }),
    );
    return items;
  }

  async function resolveStocks(value: string): Promise<Security[]> {
    const parts = value.split(/[,，;；、]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) throw invalid("stock must not be empty");
    if (parts.length > 10) throw invalid("At most 10 stocks per query");
    return Promise.all(parts.map((part) => securities.resolve(part)));
  }

  server.registerTool(
    "search_securities",
    {
      title: "Search securities",
      description:
        "Find listed securities by code, Chinese short name or pinyin initials (e.g. 茅台, gzmt, 6005). Covers Shanghai/Shenzhen/Beijing A and B shares and Hong Kong stocks; funds and bonds are found by exact code. Use it to resolve the right code before calling other tools when the name is ambiguous.",
      inputSchema: {
        query: z.string().min(1).max(40).describe("Code, name fragment or pinyin initials"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ query, limit }) => {
      const results = await securities.search(query, limit);
      return ok({ query, count: results.length, securities: results.map(publicSecurity) });
    }),
  );

  server.registerTool(
    "list_reports",
    {
      title: "List periodic reports and prospectuses",
      description:
        "List a company's periodic reports (annual 年报, semiannual 半年报, q1 一季报, q3 三季报) or IPO prospectuses (招股说明书) with document URLs. Returns only full report bodies by default (kind main, or revised for a corrected full text); set include_variants to also get summaries, English versions and H-share editions. year is the fiscal year of the report (for prospectuses, the disclosure year); omit it for all years.",
      inputSchema: {
        stock: stockSchema,
        report_type: z
          .string()
          .default("annual")
          .describe(`One of: ${Object.keys(REPORT_TYPES).join(", ")}`),
        year: z.number().int().min(1985).max(2100).optional(),
        include_variants: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ stock, report_type, year, include_variants }) => {
      const type = normalizeReportType(report_type);
      const security = await securities.resolve(stock);
      const listing = await listReports(announcements, security, type, {
        ...(year === undefined ? {} : { year }),
        includeVariants: include_variants,
      });
      await fillNames(listing.items);
      const payload: Record<string, unknown> = {
        security: publicSecurity(security),
        report_type: type,
        year: year ?? null,
        count: listing.items.length,
        complete: listing.complete,
        reports: listing.items.map(publicAnnouncement),
      };
      if (listing.warnings.length > 0) payload.warnings = listing.warnings;
      return ok(payload);
    }),
  );

  server.registerTool(
    "search_announcements",
    {
      title: "Search announcements",
      description: [
        "Search company announcements (公告) on CNINFO, newest first. Filter by stock, title keyword, category and date range; omit stock for a market-wide search (e.g. all 业绩预告 in a date range).",
        `categories: ${Object.entries(CATEGORIES).map(([name, c]) => `${name}(${c.label})`).join(", ")}.`,
        `With source=investor_relations (调研/投资者关系活动记录): ${Object.entries(RELATION_CATEGORIES).map(([name, c]) => `${name}(${c.label})`).join(", ")}.`,
        "Categories apply to Shanghai/Shenzhen/Beijing stocks; for Hong Kong stocks use keyword only. The result reports total matches; to page, pass the returned next_offset as offset.",
      ].join(" "),
      inputSchema: {
        stock: z
          .string()
          .max(200)
          .optional()
          .describe("Code or short name; several may be comma-separated (max 10)"),
        keyword: z.string().max(100).optional().describe("Words that must appear in the title, e.g. 回购"),
        categories: z.array(z.string().max(60)).max(10).optional(),
        start_date: z.string().optional().describe("YYYY-MM-DD, inclusive (Beijing time)"),
        end_date: z.string().optional().describe("YYYY-MM-DD, inclusive (Beijing time)"),
        market: z
          .enum(Object.keys(PLATES) as [string, ...string[]])
          .optional()
          .describe(
            `Board filter for market-wide searches: ${Object.entries(PLATES).map(([k, v]) => `${k}=${v}`).join(", ")}`,
          ),
        source: z.enum(["announcements", "investor_relations"]).default("announcements"),
        sort: z.enum(["newest", "oldest"]).default("newest"),
        limit: z.number().int().min(1).max(200).default(30),
        offset: z.number().int().min(0).max(100000).default(0),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const resolved = args.stock?.trim() ? await resolveStocks(args.stock) : [];
      const result = await announcements.query({
        securities: resolved,
        tab: args.source,
        sort: args.sort,
        limit: args.limit,
        offset: args.offset,
        ...(args.keyword ? { keyword: args.keyword } : {}),
        ...(args.categories?.length ? { categories: args.categories } : {}),
        ...(args.start_date ? { startDate: args.start_date } : {}),
        ...(args.end_date ? { endDate: args.end_date } : {}),
        ...(args.market ? { plate: args.market } : {}),
      });
      await fillNames(result.items);
      const payload: Record<string, unknown> = {
        total: result.total,
        offset: args.offset,
        returned: result.items.length,
        has_more: result.nextOffset < result.total,
        complete: result.complete,
        announcements: result.items.map(publicAnnouncement),
      };
      // 上游行可能被丢弃（无附件、重复），续页必须用 next_offset 而不是 offset + returned
      if (result.nextOffset < result.total) payload.next_offset = result.nextOffset;
      if (resolved.length > 0) payload.securities = resolved.map(publicSecurity);
      if (result.warnings.length > 0) payload.warnings = result.warnings;
      return ok(payload);
    }),
  );

  server.registerTool(
    "read_document",
    {
      title: "Read an announcement or report",
      description:
        "Read the text of a CNINFO document (PDF, or HTML for older filings) given its URL from list_reports or search_announcements. Three modes: (1) no pages/query: overview with page count, table of contents and the opening pages; (2) query: find which pages mention the given words (space-separated, any match) with snippets, the efficient way to locate a section in a long report; (3) pages: full text of those pages, e.g. \"12-18\". Output is plain text capped at max_chars; it ends with the pages value to continue from. Scanned documents without a text layer return empty pages.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .max(300)
          .describe("Document URL on static.cninfo.com.cn (or its finalpage/... path)"),
        pages: z.string().max(100).optional().describe('Page ranges such as "5", "10-20" or "1-3,8"'),
        query: z.string().max(200).optional().describe("Words to locate inside the document"),
        max_chars: z.number().int().min(1000).max(200000).default(20000),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ url, pages, query, max_chars }) => {
      const document = await documents.text(url);
      const totalChars = document.pages.reduce((sum, page) => sum + page.length, 0);
      const head = [
        `${document.url}`,
        `${document.format} · ${document.pageCount} pages · ${totalChars} characters`,
      ];
      if (totalChars === 0) {
        head.push(
          "[warning] This document has no text layer (likely a scanned image); its content cannot be read as text.",
        );
      }
      if (document.failedPages?.length) {
        head.push(
          `[warning] Pages ${formatPageSpec(document.failedPages)} could not be parsed and are empty here.`,
        );
      }

      const wanted = pages?.trim() ? parsePageSpec(pages, document.pageCount) : undefined;
      if (query?.trim()) {
        const pool = wanted ?? document.pages.map((_, index) => index + 1);
        const subset = pool.map((page) => document.pages[page - 1] ?? "");
        const hits = searchPages(subset, query, 25).map((hit) => ({
          ...hit,
          page: pool[hit.page - 1]!,
        }));
        const lines = [
          ...head,
          `"${query}" found on ${hits.length} page(s)${wanted ? ` within pages ${formatPageSpec(wanted)}` : ""}`,
          ...hits.map(
            (hit) =>
              `\n[p.${hit.page}] ${hit.matches} match(es)\n${hit.snippets.map((s) => `  ${s}`).join("\n")}`,
          ),
        ];
        if (hits.length > 0) lines.push('\nRead a section with pages="<start>-<end>".');
        return textResult(lines.join("\n"));
      }

      const selection = wanted ?? document.pages.map((_, index) => index + 1);
      const parts: string[] = [];
      let included = 0;
      let used = 0;
      let truncatedPage: number | undefined;
      for (const page of selection) {
        const text = document.pages[page - 1] ?? "";
        const header = `\n--- page ${page} / ${document.pageCount} ---\n`;
        const room = max_chars - used - header.length;
        if (included > 0 && text.length > room) break;
        if (text.length > room) {
          // 第一页就超出上限时截断它，保证每次调用都有进展
          parts.push(header + text.slice(0, Math.max(0, room)));
          included += 1;
          truncatedPage = page;
          break;
        }
        parts.push(header + text);
        included += 1;
        used += header.length + text.length;
      }
      if (!wanted && document.outline.length > 0) {
        head.push(
          "Contents:",
          ...document.outline
            .filter((item) => item.level <= 2)
            .slice(0, 60)
            .map(
              (item) =>
                `${"  ".repeat(item.level - 1)}${item.title}${item.page ? ` (p.${item.page})` : ""}`,
            ),
        );
      }
      const tail: string[] = [];
      if (truncatedPage !== undefined) {
        tail.push(`\n[page ${truncatedPage} was cut at max_chars; raise max_chars to read all of it]`);
      }
      const remaining = selection.slice(included);
      if (remaining.length > 0) {
        // 续读提示取自剩余的选定页，稀疏的页码选择（"1-3,8,20-22"）也不会走偏
        const nextChunk = formatPageSpec(remaining.slice(0, Math.max(included, 1)));
        tail.push(
          `\n[${remaining.length} more page(s) not shown: continue with pages="${nextChunk}", or use query to jump to a topic]`,
        );
      }
      return textResult([...head, ...parts, ...tail].join("\n"));
    }),
  );

  server.registerTool(
    "get_financials",
    {
      title: "Get financial statements and key ratios",
      description:
        "Structured financial data for a Shanghai/Shenzhen/Beijing listed company, up to the five most recent periods of one period type: indicators (EPS, ROE, margins, growth, leverage, turnover), income (利润表), balance (资产负债表), cashflow (现金流量表). Statement amounts are in 万元 (10,000 CNY). Figures are condensed summaries from CNINFO; for line-item detail read the report itself with read_document.",
      inputSchema: {
        stock: stockSchema,
        statements: z
          .array(z.enum(["indicators", "income", "balance", "cashflow"]))
          .min(1)
          .max(4)
          .default(["indicators"]),
        period: z
          .enum(["annual", "semiannual", "q1", "q3"])
          .default("annual")
          .describe("Report period type; q1/semiannual/q3 values are cumulative year-to-date"),
        periods: z.number().int().min(1).max(10).default(5).describe("How many recent periods"),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ stock, statements, period, periods }) => {
      const security = await securities.resolve(stock);
      assertAShare(security);
      const unique = [...new Set(statements)] as Statement[];
      const settled = await Promise.allSettled(
        unique.map((statement) =>
          companyData.financials(security, statement, period as Period, periods),
        ),
      );
      const tables: unknown[] = [];
      const errors: Array<{ statement: string; error: string }> = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") tables.push(result.value);
        else errors.push({ statement: unique[index]!, error: errorMessage(result.reason) });
      });
      if (tables.length === 0 && errors.length > 0) {
        throw new CninfoError("UPSTREAM", errors.map((e) => e.error).join("; "), { retryable: true });
      }
      const payload: Record<string, unknown> = {
        security: publicSecurity(security),
        period,
        complete: errors.length === 0,
        statements: tables,
      };
      if (errors.length > 0) payload.errors = errors;
      return ok(payload);
    }),
  );

  server.registerTool(
    "get_company_data",
    {
      title: "Get company profile, shareholder and trading data",
      description: [
        "Structured company data for a Shanghai/Shenzhen/Beijing listed stock. Request one or more datasets in a single call (they are fetched concurrently):",
        Object.entries(DATASET_LABELS).map(([name, label]) => `${name}(${label})`).join(", ") + ".",
        "Rows are newest first; limit caps rows per dataset (top-10 holder tables return 10 rows per reporting date).",
      ].join(" "),
      inputSchema: {
        stock: stockSchema,
        datasets: z
          .array(z.enum(Object.keys(DATASET_LABELS) as [Dataset, ...Dataset[]]))
          .min(1)
          .max(8),
        limit: z.number().int().min(1).max(500).default(20),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ stock, datasets, limit }) => {
      const security = await securities.resolve(stock);
      assertAShare(security);
      const unique = [...new Set(datasets)];
      const settled = await Promise.allSettled(
        unique.map((dataset) => companyData.table(security, dataset, limit)),
      );
      const data: Record<string, unknown> = {};
      const errors: Array<{ dataset: string; error: string }> = [];
      settled.forEach((result, index) => {
        const dataset = unique[index]!;
        if (result.status === "fulfilled") {
          const { dataset: _name, ...table } = result.value;
          data[dataset] = table;
        } else {
          errors.push({ dataset, error: errorMessage(result.reason) });
        }
      });
      if (Object.keys(data).length === 0 && errors.length > 0) {
        throw new CninfoError("UPSTREAM", errors.map((e) => e.error).join("; "), { retryable: true });
      }
      const payload: Record<string, unknown> = {
        security: publicSecurity(security),
        complete: errors.length === 0,
        data,
      };
      if (errors.length > 0) payload.errors = errors;
      return ok(payload);
    }),
  );

  server.registerTool(
    "download_reports",
    {
      title: "Download periodic reports or prospectuses",
      description: `Save a company's reports to disk as PDF files and return their paths. Same selection as list_reports (full report bodies only). Files go to the server's download directory (${DOWNLOAD_DIR_ENV}, default ~/Downloads/cninfo-mcp); save_path may name a sub-directory inside it and anything outside is rejected. Files already present are not downloaded again. To read a report you do not need to download it: use read_document.`,
      inputSchema: {
        stock: stockSchema,
        report_type: z
          .string()
          .default("annual")
          .describe(`One of: ${Object.keys(REPORT_TYPES).join(", ")}`),
        year: z
          .number()
          .int()
          .min(1985)
          .max(2100)
          .optional()
          .describe("Fiscal year; omit to download every available year"),
        save_path: z.string().max(500).optional().describe("Sub-directory inside the download directory"),
      },
      annotations: WRITES_FILES,
    },
    guarded(async ({ stock, report_type, year, save_path }) => {
      const type = normalizeReportType(report_type);
      const directory = await resolveSaveDir(config.downloadDir, save_path);
      const security = await securities.resolve(stock);
      const listing = await listReports(
        announcements,
        security,
        type,
        year === undefined ? {} : { year },
      );
      await fillNames(listing.items);
      const outcome = await documents.download(
        listing.items.map((item) => ({
          url: item.url,
          code: item.code,
          name: item.name,
          title: item.title,
          id: item.id,
        })),
        directory,
      );
      const payload: Record<string, unknown> = {
        security: publicSecurity(security),
        report_type: type,
        year: year ?? null,
        // complete 只有在查询完整且全部文件就绪时才为 true
        complete: listing.complete && outcome.failures.length === 0,
        ...downloadPayload(outcome, directory),
      };
      if (listing.warnings.length > 0) payload.warnings = listing.warnings;
      return ok(payload);
    }),
  );

  server.registerTool(
    "download_documents",
    {
      title: "Download documents by URL",
      description: `Save specific CNINFO documents (URLs from list_reports or search_announcements) to the server's download directory (${DOWNLOAD_DIR_ENV}, default ~/Downloads/cninfo-mcp). save_path may name a sub-directory inside it. Each file is handled independently; failures are reported per URL.`,
      inputSchema: {
        urls: z.array(z.string().min(1).max(300)).min(1).max(50),
        save_path: z.string().max(500).optional().describe("Sub-directory inside the download directory"),
      },
      annotations: WRITES_FILES,
    },
    guarded(async ({ urls, save_path }) => {
      const directory = await resolveSaveDir(config.downloadDir, save_path);
      const unique = [...new Set(urls.map((url) => url.trim()))];
      const outcome = await documents.download(
        unique.map((url) => ({ url })),
        directory,
      );
      return ok({ complete: outcome.failures.length === 0, ...downloadPayload(outcome, directory) });
    }),
  );

  server.registerPrompt(
    "company_research",
    {
      title: "上市公司深度研究",
      description: "Build a structured research brief on a listed company from CNINFO disclosures",
      argsSchema: { stock: z.string().describe("股票代码或简称") },
    },
    ({ stock }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `请基于巨潮资讯的公开披露，对「${stock}」做一份结构化研究简报。步骤：`,
              "1. get_company_data 取 profile、top_shareholders、shareholder_count、dividends、pledges。",
              "2. get_financials 取 indicators、income、balance、cashflow 的近五年年报数据，并补充最近一期季报。",
              "3. list_reports 找到最新年报，用 read_document 的 query 定位并阅读「管理层讨论与分析」「主营业务分析」「风险」等章节。",
              "4. search_announcements 查看近六个月的重要公告（业绩预告、股权变动、增发、回购、风险提示、调研记录）。",
              "输出：业务与行业地位、财务质量与趋势（收入/利润/现金流/ROE/负债）、股东与治理、分红回报、近期催化与风险。",
              "所有结论注明数据来源（报告名称与页码或公告日期）；数据缺失或查询不完整时如实说明。不构成投资建议。",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "earnings_review",
    {
      title: "最新财报解读",
      description: "Review a company's latest periodic report against prior periods",
      argsSchema: {
        stock: z.string().describe("股票代码或简称"),
        report_type: z.string().optional().describe("annual / semiannual / q1 / q3，默认最新一期"),
      },
    },
    ({ stock, report_type }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `请解读「${stock}」${report_type ? `的 ${report_type} 报告` : "最新一期定期报告"}。步骤：`,
              "1. list_reports 找到目标报告（未指定类型时比较各类型最新披露日期，取最近的一份）。",
              "2. get_financials 取同一报告期类型的 indicators、income、cashflow，做同比对比。",
              "3. read_document 用 query 定位「主要会计数据」「经营情况讨论与分析」「非经常性损益」「分部/分产品」并阅读相关页。",
              "4. 如有业绩预告或更正公告，用 search_announcements 核对。",
              "输出：关键数据同比变化、增长或下滑的驱动因素、利润质量（现金流与非经常性损益）、管理层展望、需要关注的风险点；引用页码。不构成投资建议。",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
