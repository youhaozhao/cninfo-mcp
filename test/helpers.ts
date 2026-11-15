import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config.ts";
import { HttpClient, type FetchLike, type HttpClientOptions } from "../src/http.ts";

export interface RecordedCall {
  url: string;
  method: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** 按 URL 前缀路由的假 fetch，并记录所有请求。 */
export function fakeFetch(routes: Record<string, Handler>): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init.method ?? "GET",
      form: Object.fromEntries(new URLSearchParams(typeof init.body === "string" ? init.body : "")),
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const match = Object.keys(routes)
      .filter((prefix) => input.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return new Response("not found", { status: 404 });
    return routes[match]!(call);
  };
  return { fetch, calls };
}

export function testClient(fetch: FetchLike, overrides: Partial<HttpClientOptions> = {}): HttpClient {
  return new HttpClient({
    concurrency: 4,
    minIntervalMs: 0,
    timeoutMs: 5000,
    maxAttempts: 3,
    userAgent: "test-agent",
    backoffMs: 1,
    fetch,
    sleep: async () => {},
    ...overrides,
  });
}

export async function tempDir(prefix = "cninfo-mcp-test-"): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export function testConfig(root: string): Config {
  return {
    downloadDir: path.join(root, "downloads"),
    cacheDir: path.join(root, "cache"),
    cacheMaxBytes: 64 * 1024 * 1024,
    concurrency: 4,
    minIntervalMs: 0,
    timeoutMs: 5000,
    maxAttempts: 3,
    userAgent: "test-agent",
  };
}

export const STOCK_LIST = {
  stockList: [
    { code: "600519", pinyin: "gzmt", category: "A股", orgId: "gssh0600519", zwjc: "贵州茅台" },
    { code: "000001", pinyin: "payh", category: "A股", orgId: "gssz0000001", zwjc: "平安银行" },
    { code: "000002", pinyin: "wka", category: "A股", orgId: "gssz0000002", zwjc: "万 科Ａ" },
    { code: "300750", pinyin: "ndsd", category: "A股", orgId: "GD165627", zwjc: "宁德时代" },
    { code: "688981", pinyin: "zxgj", category: "A股", orgId: "gshk0000981", zwjc: "中芯国际" },
    { code: "920185", pinyin: "btr", category: "A股", orgId: "gfbj0835185", zwjc: "贝特瑞" },
    { code: "835185", pinyin: "btr", category: "A股", orgId: "gfbj0835185", zwjc: "贝特瑞" },
    { code: "900901", pinyin: "ysbg", category: "B股", orgId: "gssh0600602", zwjc: "云赛B股" },
  ],
};

export const HK_LIST = {
  stockList: [
    { code: "00700", pinyin: "txkg", category: "港股", orgId: "gshk0000700", zwjc: "腾讯控股" },
    { code: "03750", pinyin: "ndsd", category: "港股", orgId: "GD165627", zwjc: "宁德时代" },
  ],
};

export const LIST_ROUTES: Record<string, Handler> = {
  "https://www.cninfo.com.cn/new/data/szse_stock.json": () => json(STOCK_LIST),
  "https://www.cninfo.com.cn/new/data/hke_stock.json": () => json(HK_LIST),
};

/** 北京时间某日零点的 epoch 毫秒。 */
export function shanghaiMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

export function rawAnnouncement(
  id: number,
  title: string,
  date: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    announcementId: String(id),
    secCode: "600519",
    secName: "贵州茅台",
    orgId: "gssh0600519",
    announcementTitle: title,
    announcementTime: shanghaiMidnight(date),
    adjunctUrl: `finalpage/${date}/${id}.PDF`,
    adjunctType: "PDF",
    adjunctSize: 100,
    ...extra,
  };
}

/** 生成一个带文本层的最小合法 PDF，每个字符串占一页。 */
export function makePdf(pageTexts: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`;
  const fontId = 3 + pageTexts.length * 2;
  pageTexts.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const escaped = text.replace(/[\\()]/g, "\\$&");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
