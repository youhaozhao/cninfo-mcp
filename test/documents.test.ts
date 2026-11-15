import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  DocumentService,
  formatPageSpec,
  htmlToText,
  parsePageSpec,
  searchPages,
} from "../src/documents.ts";
import { CninfoError } from "../src/errors.ts";
import { fakeFetch, makePdf, tempDir, testClient, type Handler } from "./helpers.ts";

const STATIC = "https://static.cninfo.com.cn/";
const pdfResponse = (bytes: Uint8Array): Response =>
  new Response(bytes, { headers: { "content-type": "application/pdf" } });

async function setup(routes: Record<string, Handler>, cacheMaxBytes = 64 * 1024 * 1024) {
  const root = await tempDir();
  const { fetch, calls } = fakeFetch(
    Object.fromEntries(Object.entries(routes).map(([k, v]) => [STATIC + k, v])),
  );
  const documents = new DocumentService(testClient(fetch), path.join(root, "cache"), cacheMaxBytes);
  return { documents, calls, root, downloads: path.join(root, "downloads") };
}

test("parsePageSpec handles lists, ranges and clamping", () => {
  assert.deepEqual(parsePageSpec("3", 10), [3]);
  assert.deepEqual(parsePageSpec("1-3, 8，5-6", 10), [1, 2, 3, 5, 6, 8]);
  assert.deepEqual(parsePageSpec("9-20", 10), [9, 10]);
  assert.throws(() => parsePageSpec("abc", 10), CninfoError);
  assert.throws(() => parsePageSpec("5-2", 10), CninfoError);
  assert.throws(() => parsePageSpec("0", 10), CninfoError);
  assert.throws(() => parsePageSpec("11-12", 10), /outside the document/);
});

test("searchPages matches across line breaks and ranks by distinct terms", () => {
  const pages = [
    "目录\n第三节 管理层讨论与分析",
    "三、经营情况讨论与分析\n主营业\n务分析：毛利率 91.23%",
    "毛利率比上年减少，毛利率下降原因",
    "无关内容",
  ];
  const hits = searchPages(pages, "主营业务分析 毛利率", 10);
  assert.deepEqual(hits.map((hit) => [hit.page, hit.matches]), [
    [2, 2],
    [3, 2],
  ]);
  assert.match(hits[0]!.snippets[0]!, /主营业 务分析/);
  // with room for a single hit, the page matching both terms wins
  assert.deepEqual(searchPages(pages, "主营业务分析 毛利率", 1).map((hit) => hit.page), [2]);
  assert.deepEqual(searchPages(pages, "a.b(c", 5), []);
  assert.throws(() => searchPages(pages, "   ", 5), CninfoError);
});

test("htmlToText decodes GBK pages and strips markup", () => {
  const gbk = Uint8Array.from([
    ...Buffer.from('<html><head><meta charset="gb2312"><title>x</title></head><body><p>', "latin1"),
    0xc4, 0xea, 0xb1, 0xa8, // 年报
    ...Buffer.from("</p><script>evil()</script><div>1&nbsp;&lt;&#50;</div></body></html>", "latin1"),
  ]);
  assert.equal(htmlToText(gbk), "年报\n1 <2");
  assert.equal(htmlToText(new TextEncoder().encode("<p>纯 UTF-8</p>")), "纯 UTF-8");
  // hex entities decode; an out-of-range entity is left alone instead of throwing
  assert.equal(htmlToText(new TextEncoder().encode("<p>&#x4e2d;&#22269; a&#99999999;b</p>")), "中国 a&#99999999;b");
});

test("extracts text per page from a PDF and caches the result on disk", async () => {
  const pdf = makePdf(["Annual Report 2025", "Revenue grew 12 percent"]);
  const { documents, calls } = await setup({ "finalpage/2026-04-17/1.PDF": () => pdfResponse(pdf) });
  const first = await documents.text("finalpage/2026-04-17/1.PDF");
  assert.equal(first.url, STATIC + "finalpage/2026-04-17/1.PDF");
  assert.equal(first.pageCount, 2);
  assert.deepEqual(first.pages, ["Annual Report 2025", "Revenue grew 12 percent"]);
  // concurrent and repeated reads reuse the cached extraction
  const [again, concurrent] = await Promise.all([
    documents.text(STATIC + "finalpage/2026-04-17/1.PDF"),
    documents.text("finalpage/2026-04-17/1.PDF"),
  ]);
  assert.deepEqual(again.pages, first.pages);
  assert.deepEqual(concurrent.pages, first.pages);
  assert.equal(calls.length, 1);
});

test("a second service instance reads documents from the disk cache", async () => {
  const pdf = makePdf(["cached"]);
  const first = await setup({ "finalpage/a/2.PDF": () => pdfResponse(pdf) });
  await first.documents.text("finalpage/a/2.PDF");
  const offline = fakeFetch({});
  const second = new DocumentService(testClient(offline.fetch), path.join(first.root, "cache"), 1e9);
  assert.deepEqual((await second.text("finalpage/a/2.PDF")).pages, ["cached"]);
  assert.equal((await second.fetch("finalpage/a/2.PDF")).fromCache, true);
  assert.equal(offline.calls.length, 0);
});

test("rejects error pages served in place of a PDF and does not cache them", async () => {
  let attempt = 0;
  const pdf = makePdf(["ok"]);
  const { documents } = await setup({
    "finalpage/a/3.PDF": () => {
      attempt += 1;
      return attempt === 1 ? new Response("<html>请求过于频繁</html>") : pdfResponse(pdf);
    },
  });
  await assert.rejects(documents.fetch("finalpage/a/3.PDF"), /non-PDF/);
  assert.equal((await documents.fetch("finalpage/a/3.PDF")).fromCache, false);
});

test("reports unparseable PDFs and unsupported formats clearly", async () => {
  const { documents } = await setup({
    "finalpage/a/broken.PDF": () => pdfResponse(new TextEncoder().encode("%PDF-1.4 garbage")),
    "finalpage/a/old.doc": () => new Response(new Uint8Array([1, 2, 3])),
  });
  await assert.rejects(documents.text("finalpage/a/broken.PDF"), /Could not parse PDF/);
  await assert.rejects(documents.text("finalpage/a/old.doc"), /download_documents/);
  await assert.rejects(documents.text("https://evil.example.com/a.pdf"), CninfoError);
});

test("downloads with descriptive names, atomically, and skips existing files", async () => {
  const pdf = makePdf(["report"]);
  const { documents, calls, downloads } = await setup({
    "finalpage/2026-04-17/1225114741.PDF": () => pdfResponse(pdf),
  });
  const request = {
    url: "finalpage/2026-04-17/1225114741.PDF",
    code: "600519",
    name: "贵州茅台",
    title: "贵州茅台2025年年度报告: 全文?",
    id: "1225114741",
  };
  const first = await documents.download([request], downloads);
  assert.deepEqual(first.failures, []);
  const file = first.files[0]!;
  assert.equal(file.status, "downloaded");
  assert.equal(path.basename(file.path), "600519_贵州茅台_贵州茅台2025年年度报告 全文_1225114741.pdf");
  assert.deepEqual(new Uint8Array(await fs.readFile(file.path)), pdf);
  assert.deepEqual(await fs.readdir(downloads), [path.basename(file.path)]);

  const second = await documents.download([request], downloads);
  assert.equal(second.files[0]!.status, "already_exists");
  assert.equal(second.files[0]!.bytes, pdf.byteLength);
  assert.equal(calls.length, 1);
});

test("one failed download does not affect the others", async () => {
  const pdf = makePdf(["good"]);
  const { documents, downloads } = await setup({
    "finalpage/a/good.PDF": () => pdfResponse(pdf),
    "finalpage/a/bad.PDF": () => new Response("", { status: 500 }),
  });
  const outcome = await documents.download(
    [
      { url: "finalpage/a/good.PDF" },
      { url: "finalpage/a/bad.PDF", title: "坏文件" },
      { url: "finalpage/a/missing.PDF" },
      { url: "https://evil.example.com/x.pdf" },
    ],
    downloads,
  );
  assert.match(path.basename(outcome.files[0]!.path), /^good_[0-9a-f]{8}\.pdf$/);
  assert.deepEqual(outcome.failures.map((f) => f.url), [
    "finalpage/a/bad.PDF",
    "finalpage/a/missing.PDF",
    "https://evil.example.com/x.pdf",
  ]);
  assert.equal(outcome.failures[0]!.title, "坏文件");
  assert.equal((await fs.readdir(downloads)).length, 1);
});

test("URL-only downloads with the same file name do not collide", async () => {
  const { documents, downloads } = await setup({
    "finalpage/2024-01-01/1.PDF": () => pdfResponse(makePdf(["first"])),
    "finalpage/2025-01-01/1.PDF": () => pdfResponse(makePdf(["second"])),
  });
  const outcome = await documents.download(
    [{ url: "finalpage/2024-01-01/1.PDF" }, { url: "finalpage/2025-01-01/1.PDF" }],
    downloads,
  );
  assert.equal(new Set(outcome.files.map((f) => f.path)).size, 2);
  assert.deepEqual(outcome.files.map((f) => f.status), ["downloaded", "downloaded"]);
});

test("formatPageSpec compresses runs", () => {
  assert.equal(formatPageSpec([1, 2, 3, 8, 20, 21]), "1-3,8,20-21");
  assert.equal(formatPageSpec([5]), "5");
  assert.equal(formatPageSpec([]), "");
});

test("evicts least recently used documents when the cache exceeds its limit", async () => {
  const big = (fill: string): Uint8Array => makePdf([fill.repeat(3000)]);
  const { documents, root } = await setup(
    {
      "finalpage/a/1.PDF": () => pdfResponse(big("a")),
      "finalpage/a/2.PDF": () => pdfResponse(big("b")),
      "finalpage/a/3.PDF": () => pdfResponse(big("c")),
    },
    8000, // room for two ~3.6 KB documents, not three
  );
  const docsDir = path.join(root, "cache", "docs");
  await documents.fetch("finalpage/a/1.PDF");
  await documents.fetch("finalpage/a/2.PDF");
  const old = new Date(Date.now() - 60_000);
  for (const name of await fs.readdir(docsDir)) await fs.utimes(path.join(docsDir, name), old, old);
  await documents.fetch("finalpage/a/3.PDF");
  const remaining = await fs.readdir(docsDir);
  assert.equal(remaining.length, 1);
  assert.equal((await documents.fetch("finalpage/a/3.PDF")).fromCache, true);
});
