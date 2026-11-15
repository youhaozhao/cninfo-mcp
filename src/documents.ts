import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveDocumentUrl } from "./announcements.ts";
import { Mutex, readJsonFile, writeFileAtomic } from "./cache.ts";
import { CninfoError, errorMessage, invalid } from "./errors.ts";
import type { HttpClient } from "./http.ts";
import { safeFileStem } from "./paths.ts";

/** 单个文档的大小上限：年报通常 1–20 MB，招股书可达上百 MB。 */
const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;
const DOCUMENT_TIMEOUT_MS = 180 * 1000;
const TEXT_CACHE_VERSION = 1;
const HTML_PAGE_CHARS = 4000;
const MAX_OUTLINE_ITEMS = 200;

export interface OutlineItem {
  title: string;
  level: number;
  page?: number;
}

export interface DocumentText {
  url: string;
  format: string;
  pageCount: number;
  /** 每页文本；下标 0 对应第 1 页。 */
  pages: string[];
  outline: OutlineItem[];
  /** 解析失败的页码；存在时结果不写入缓存，下次读取会重新解析。 */
  failedPages?: number[];
}

interface CachedText extends DocumentText {
  v: number;
}

export interface FetchedDocument {
  url: string;
  /** 由 URL 扩展名得到的大写格式：PDF、HTML、DOC…… */
  format: string;
  bytes: Uint8Array;
  fromCache: boolean;
}

export interface DownloadRequest {
  url: string;
  code?: string;
  name?: string;
  title?: string;
  id?: string;
}

export interface DownloadedFile {
  url: string;
  path: string;
  bytes: number;
  /** already_exists：目标文件已在磁盘上，未重新下载。 */
  status: "downloaded" | "already_exists";
  title?: string;
}

export interface DownloadFailure {
  url: string;
  title?: string;
  error: string;
}

export interface DownloadOutcome {
  files: DownloadedFile[];
  failures: DownloadFailure[];
}

export interface PageHit {
  page: number;
  matches: number;
  snippets: string[];
}

function formatOf(url: string): string {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname)?.[1] ?? "";
  const upper = extension.toUpperCase();
  return upper === "HTM" ? "HTML" : upper || "BIN";
}

function isPdf(bytes: Uint8Array): boolean {
  // 规范允许 %PDF- 头出现在前 1024 字节内
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  return head.includes("%PDF-");
}

/** 解析 "3"、"5-12"、"1-3,8,20-22" 形式的页码范围，返回升序去重的页码。 */
export function parsePageSpec(spec: string, pageCount: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(/[,，;；]/)) {
    const text = part.trim();
    if (!text) continue;
    const match = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(text);
    if (!match) throw invalid(`Invalid pages value "${spec}". Use forms like "5", "10-20" or "1-3,8"`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start) throw invalid(`Invalid page range "${text}"`);
    for (let page = start; page <= Math.min(end, pageCount); page++) pages.add(page);
  }
  if (pages.size === 0) {
    throw invalid(`pages "${spec}" is outside the document (it has ${pageCount} pages)`);
  }
  return [...pages].sort((a, b) => a - b);
}

/** 把页码列表压缩成 "1-3,8,20-22" 形式。 */
export function formatPageSpec(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i]!;
    let end = start;
    while (pages[i + 1] === end + 1) end = pages[++i]!;
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(",");
}

/** 关键字匹配允许字符间夹杂空白：PDF 文本层常在中文词中间断行或插入空格。 */
function termPattern(term: string): RegExp {
  const chars = [...term].map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(chars.join("\\s*"), "gi");
}

/** 在各页中查找关键字（空格分隔的多个词任一命中即可），返回带上下文片段的命中页。 */
export function searchPages(pages: string[], query: string, maxHits: number): PageHit[] {
  const terms = [...new Set(query.normalize("NFKC").split(/\s+/).filter(Boolean))].slice(0, 8);
  if (terms.length === 0) throw invalid("query must not be empty");
  const patterns = terms.map(termPattern);
  const hits: Array<PageHit & { distinct: number }> = [];
  pages.forEach((raw, index) => {
    const text = raw.normalize("NFKC");
    let matches = 0;
    let distinct = 0;
    const snippets: string[] = [];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let found = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        found += 1;
        if (snippets.length < 3 && found <= 2) {
          const start = Math.max(0, match.index - 60);
          const end = Math.min(text.length, match.index + match[0].length + 100);
          snippets.push(
            (start > 0 ? "…" : "") +
              text.slice(start, end).replace(/\s+/g, " ").trim() +
              (end < text.length ? "…" : ""),
          );
        }
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
      if (found > 0) distinct += 1;
      matches += found;
    }
    if (matches > 0) hits.push({ page: index + 1, matches, snippets, distinct });
  });
  // 先按命中的不同关键词数、再按命中次数取前 N，最后按页码排列便于顺序阅读
  return hits
    .sort((a, b) => b.distinct - a.distinct || b.matches - a.matches || a.page - b.page)
    .slice(0, maxHits)
    .sort((a, b) => a.page - b.page)
    .map(({ page, matches, snippets }) => ({ page, matches, snippets }));
}

function tidyPageText(text: string): string {
  return text
    .replace(/[ \t　]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 把早期 HTML 公告转成纯文本（巨潮 2000 年代的公告多为 GBK 编码的 HTML）。 */
export function htmlToText(bytes: Uint8Array): string {
  const sniff = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 2048))
    .toString("latin1")
    .toLowerCase();
  let html: string | undefined;
  if (!/charset\s*=\s*["']?(gb2312|gbk|gb18030)/.test(sniff)) {
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      html = undefined;
    }
  }
  html ??= new TextDecoder("gb18030").decode(bytes);
  const entities: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ensp: " ", emsp: " ",
  };
  return tidyPageText(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/table)\b[^>]*>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code: string) => {
        const point = /^x/i.test(code) ? Number.parseInt(code.slice(1), 16) : Number(code);
        // 超出 Unicode 范围的实体原样保留，不能让一个坏实体毁掉整篇文档
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : whole;
      })
      .replace(/&([a-z]+);/gi, (whole, name: string) => entities[name.toLowerCase()] ?? whole),
  );
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + size / 2) end = newline + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

/** 抓取、缓存、解析和保存巨潮上的公告文档。 */
export class DocumentService {
  private readonly http: HttpClient;
  private readonly docsDir: string;
  private readonly cacheMaxBytes: number;
  private readonly parser = new Mutex();
  private readonly inflight = new Map<string, Promise<FetchedDocument>>();
  private readonly textInflight = new Map<string, Promise<DocumentText>>();
  private pruning = false;

  constructor(http: HttpClient, cacheDir: string, cacheMaxBytes: number) {
    this.http = http;
    this.docsDir = path.join(cacheDir, "docs");
    this.cacheMaxBytes = cacheMaxBytes;
  }

  private cachePath(url: string, suffix: string): string {
    const digest = createHash("sha256").update(url).digest("hex").slice(0, 40);
    return path.join(this.docsDir, `${digest}${suffix}`);
  }

  /** 取文档字节：优先磁盘缓存，否则下载并写入缓存。同一 URL 的并发请求合并为一次。 */
  async fetch(rawUrl: string): Promise<FetchedDocument> {
    const url = resolveDocumentUrl(rawUrl);
    const pending = this.inflight.get(url);
    if (pending) return pending;
    const promise = this.fetchUncached(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, promise);
    return promise;
  }

  private async fetchUncached(url: string): Promise<FetchedDocument> {
    const format = formatOf(url);
    const file = this.cachePath(url, `.${format.toLowerCase()}`);
    try {
      const bytes = await fs.readFile(file);
      if (bytes.byteLength > 0) {
        // 刷新 mtime，淘汰时按最久未使用处理
        const now = new Date();
        await fs.utimes(file, now, now).catch(() => {});
        return { url, format, bytes, fromCache: true };
      }
    } catch {
      // 未缓存
    }
    const response = await this.http.getBytes(url, {
      maxBytes: MAX_DOCUMENT_BYTES,
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      headers: { Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8" },
    });
    const bytes = response.body;
    if (bytes.byteLength === 0) {
      throw new CninfoError("UPSTREAM", "CNINFO returned an empty document", { retryable: false });
    }
    if (format === "PDF" && !isPdf(bytes)) {
      // 限流或文件缺失时静态站会返回 HTML 错误页，不能当作 PDF 落盘
      throw new CninfoError("UPSTREAM", "CNINFO returned a non-PDF response for a PDF document");
    }
    // 缓存只是优化：目录不可写时仍然返回内容
    await writeFileAtomic(file, bytes)
      .then(() => this.prune())
      .catch(() => {});
    return { url, format, bytes, fromCache: false };
  }

  /** 提取文档文本层（按页）。结果缓存在磁盘上，同一文档再次读取不需要重新解析。 */
  async text(rawUrl: string): Promise<DocumentText> {
    const url = resolveDocumentUrl(rawUrl);
    const pending = this.textInflight.get(url);
    if (pending) return pending;
    const promise = this.textUncached(url).finally(() => this.textInflight.delete(url));
    this.textInflight.set(url, promise);
    return promise;
  }

  private async textUncached(url: string): Promise<DocumentText> {
    const textFile = this.cachePath(url, ".text.json");
    const cached = await readJsonFile<CachedText>(textFile);
    if (cached?.v === TEXT_CACHE_VERSION && Array.isArray(cached.pages)) {
      const { v: _version, ...document } = cached;
      return document;
    }
    const fetched = await this.fetch(url);
    let document: DocumentText;
    if (fetched.format === "PDF") {
      document = await this.parser.run(() => extractPdf(url, fetched.bytes));
    } else if (fetched.format === "HTML" || fetched.format === "TXT") {
      const pages = chunkText(htmlToText(fetched.bytes), HTML_PAGE_CHARS);
      document = { url, format: fetched.format, pageCount: pages.length, pages, outline: [] };
    } else {
      throw new CninfoError(
        "UNSUPPORTED",
        `Cannot extract text from ${fetched.format} documents; use download_documents to save the file instead`,
      );
    }
    // 有页解析失败时不缓存：失败可能是暂时的，不能把残缺文本永久当作结果
    if (!document.failedPages?.length) {
      const payload: CachedText = { v: TEXT_CACHE_VERSION, ...document };
      await writeFileAtomic(textFile, JSON.stringify(payload)).catch(() => {});
    }
    return document;
  }

  /** 把文档保存到目录。逐个独立处理：单个失败不影响其余文件。 */
  async download(requests: DownloadRequest[], directory: string): Promise<DownloadOutcome> {
    const files: DownloadedFile[] = [];
    const failures: DownloadFailure[] = [];
    // 网络并发由 HttpClient 统一限制，这里可以直接全部发起
    const settled = await Promise.allSettled(
      requests.map((request) => this.downloadOne(request, directory)),
    );
    settled.forEach((result, index) => {
      const request = requests[index]!;
      if (result.status === "fulfilled") {
        files.push(result.value);
      } else {
        const failure: DownloadFailure = { url: request.url, error: errorMessage(result.reason) };
        if (request.title) failure.title = request.title;
        failures.push(failure);
      }
    });
    return { files, failures };
  }

  private async downloadOne(request: DownloadRequest, directory: string): Promise<DownloadedFile> {
    const url = resolveDocumentUrl(request.url);
    const format = formatOf(url);
    const basename = path.posix.basename(new URL(url).pathname).replace(/\.[^.]*$/, "");
    // 没有公告 ID 时只能用 URL 的文件名；补一段 URL 摘要，避免不同目录下的同名文件互相顶替
    const id = request.id
      ? safeFileStem(request.id, 40)
      : `${safeFileStem(basename, 40)}_${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
    const prefix = [request.code, request.name, request.title].filter(Boolean).join("_");
    // 文件名带公告 ID：标题相同的不同公告不会互相覆盖，重复下载同一公告则命中同一文件
    const stem = prefix ? `${safeFileStem(prefix, 180)}_${id}` : id;
    const target = path.join(directory, `${stem}.${format.toLowerCase()}`);
    const result: DownloadedFile = { url, path: target, bytes: 0, status: "downloaded" };
    if (request.title) result.title = request.title;

    const existing = await fs.stat(target).catch(() => undefined);
    if (existing?.isFile() && existing.size > 0) {
      result.bytes = existing.size;
      result.status = "already_exists";
      return result;
    }
    const fetched = await this.fetch(url);
    await writeFileAtomic(target, fetched.bytes);
    result.bytes = fetched.bytes.byteLength;
    return result;
  }

  /** 缓存超出上限时按最久未使用淘汰到上限的 80%。 */
  private async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      const names = await fs.readdir(this.docsDir);
      const entries: Array<{ file: string; size: number; mtime: number }> = [];
      let total = 0;
      for (const name of names) {
        const file = path.join(this.docsDir, name);
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat?.isFile()) continue;
        // 清理崩溃时遗留的临时文件
        if (name.endsWith(".tmp")) {
          if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
            await fs.rm(file, { force: true }).catch(() => {});
          }
          continue;
        }
        entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
        total += stat.size;
      }
      if (total <= this.cacheMaxBytes) return;
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const entry of entries) {
        if (total <= this.cacheMaxBytes * 0.8) break;
        await fs.rm(entry.file, { force: true }).catch(() => {});
        total -= entry.size;
      }
    } catch {
      // 淘汰失败不影响主流程
    } finally {
      this.pruning = false;
    }
  }
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: PdfOutlineNode[];
}

interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<{
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
    cleanup(): void;
  }>;
  getOutline(): Promise<PdfOutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfJs {
  getDocument(source: Record<string, unknown>): PdfLoadingTask;
}

let pdfjsPromise: Promise<{ pdfjs: PdfJs; assets: string }> | undefined;

/** 按需加载 pdf.js：它体积较大，只在第一次读取 PDF 时才付出加载成本。 */
function loadPdfjs(): Promise<{ pdfjs: PdfJs; assets: string }> {
  pdfjsPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const assets = path.resolve(path.dirname(entry), "..", "..");
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
    return { pdfjs, assets };
  })();
  pdfjsPromise.catch(() => {
    pdfjsPromise = undefined;
  });
  return pdfjsPromise;
}

async function extractPdf(url: string, bytes: Uint8Array): Promise<DocumentText> {
  const { pdfjs, assets } = await loadPdfjs();
  // pdf.js 会接管传入的缓冲区，给它一份副本以免影响调用方持有的数据
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // 中文 PDF 常依赖预定义 CMap（如 GBK-EUC-H），缺失会得到乱码
    cMapUrl: path.join(assets, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(assets, "standard_fonts") + path.sep,
    wasmUrl: path.join(assets, "wasm") + path.sep,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    let pdf: PdfDocument;
    try {
      pdf = await task.promise;
    } catch (error) {
      throw new CninfoError("UPSTREAM", `Could not parse PDF: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const pages: string[] = [];
    const failedPages: number[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      try {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          text += item.str;
          if (item.hasEOL) text += "\n";
        }
        pages.push(tidyPageText(text));
        page.cleanup();
      } catch {
        // 单页损坏不应让整份文档不可读
        pages.push("");
        failedPages.push(number);
      }
      // 定期让出事件循环，解析大文件期间服务器仍能响应其他请求
      if (number % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (pdf.numPages > 0 && failedPages.length === pdf.numPages) {
      throw new CninfoError("UPSTREAM", "Could not extract text from any page of the PDF", {
        retryable: true,
      });
    }
    const outline = await readOutline(pdf).catch(() => []);
    const document: DocumentText = { url, format: "PDF", pageCount: pdf.numPages, pages, outline };
    if (failedPages.length > 0) document.failedPages = failedPages;
    return document;
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function readOutline(pdf: PdfDocument): Promise<OutlineItem[]> {
  const root = await pdf.getOutline();
  const items: OutlineItem[] = [];
  const visit = async (nodes: PdfOutlineNode[], level: number): Promise<void> => {
    for (const node of nodes) {
      if (items.length >= MAX_OUTLINE_ITEMS) return;
      const title = (node.title ?? "").replace(/\s+/g, " ").trim();
      // Word 导出的 PDF 常带内部书签（OLE_LINK、_Toc 等），对读者没有意义
      if (title && !/^(OLE_LINK|_Toc|_Hlk|_Ref|_GoBack)/i.test(title)) {
        const item: OutlineItem = { title: title.slice(0, 80), level };
        try {
          const dest = typeof node.dest === "string" ? await pdf.getDestination(node.dest) : node.dest;
          if (Array.isArray(dest) && dest[0]) item.page = (await pdf.getPageIndex(dest[0])) + 1;
        } catch {
          // 目标解析失败时仍保留标题
        }
        items.push(item);
      }
      if (node.items?.length && level < 3) await visit(node.items, level + 1);
    }
  };
  if (root) await visit(root, 1);
  return items;
}
