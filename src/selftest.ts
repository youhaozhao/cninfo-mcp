import { existsSync } from "node:fs";
import path from "node:path";
import { extractPdf, pdfjsAssetDir } from "./documents.ts";

/** 生成一个带文本层的最小 PDF，每个字符串占一页（仅限 ASCII，不含括号和反斜杠）。 */
export function makeTinyPdf(pageTexts: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = pageTexts.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`;
  const fontId = 3 + pageTexts.length * 2;
  pageTexts.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
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

/**
 * 离线自检：用内置的最小 PDF 走一遍文本提取，确认随包分发的 pdf.js 及其资源可用。
 * 不联网，供 `cninfo-mcp selftest` 和 CI 对打包产物做冒烟测试。
 */
export async function runSelfTest(): Promise<string> {
  const expected = ["cninfo-mcp selftest page one", "page two 2025"];
  const document = await extractPdf("selftest://tiny.pdf", makeTinyPdf(expected));
  if (document.failedPages?.length || JSON.stringify(document.pages) !== JSON.stringify(expected)) {
    throw new Error(`PDF text extraction returned ${JSON.stringify(document.pages)}`);
  }
  const assets = pdfjsAssetDir();
  for (const required of ["cmaps/GBK-EUC-H.bcmap", "standard_fonts"]) {
    if (!existsSync(path.join(assets, required))) {
      throw new Error(`pdf.js asset ${required} is missing from ${assets}`);
    }
  }
  return `PDF text extraction OK (${document.pageCount} pages; assets in ${assets})`;
}
