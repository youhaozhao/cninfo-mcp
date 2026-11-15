import { errorMessage } from "./errors.ts";
import { listReports } from "./reports.ts";
import type { Services } from "./server.ts";

/** 各市场的稳定探测标的：上市多年、年报齐全，任一成功即视为该项连通。 */
const MARKET_PROBES: Record<string, string[]> = {
  "沪市 SSE": ["600519", "601398"],
  "深市 SZSE": ["000001", "000333"],
  "北交所 BSE": ["920185", "920019"],
};

export interface ProbeLine {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 实际访问巨潮的各类接口，逐项报告是否可用。
 * 供 `cninfo-mcp probe` 自检和 CI 的定时连通性监控使用。
 */
export async function runProbe(services: Services): Promise<ProbeLine[]> {
  const lines: ProbeLine[] = [];
  for (const [market, codes] of Object.entries(MARKET_PROBES)) {
    const details: string[] = [];
    let ok = false;
    for (const code of codes) {
      try {
        const security = await services.securities.resolve(code);
        const listing = await listReports(services.announcements, security, "annual");
        details.push(`${code}=${listing.items.length}${listing.complete ? "" : "(partial)"}`);
        if (listing.items.length > 0 && listing.complete) ok = true;
      } catch (error) {
        details.push(`${code}!ERR(${errorMessage(error)})`);
      }
      if (ok) break;
    }
    lines.push({ name: `年报查询 ${market}`, ok, detail: details.join(", ") });
  }

  const check = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      lines.push({ name, ok: true, detail: await run() });
    } catch (error) {
      lines.push({ name, ok: false, detail: errorMessage(error) });
    }
  };

  await check("财务数据 data20", async () => {
    const security = await services.securities.resolve("600519");
    const table = await services.companyData.financials(security, "income", "annual", 3);
    if (table.periods.length === 0 || Object.keys(table.rows).length === 0) {
      throw new Error("income statement is empty");
    }
    return `${table.periods.length} periods, ${Object.keys(table.rows).length} rows`;
  });

  await check("文档读取 static", async () => {
    const security = await services.securities.resolve("600519");
    const listing = await listReports(services.announcements, security, "q3");
    const latest = listing.items[0];
    if (!latest) throw new Error("no quarterly report found to read");
    const document = await services.documents.text(latest.url);
    const chars = document.pages.reduce((sum, page) => sum + page.length, 0);
    if (chars === 0) throw new Error(`no text extracted from ${latest.url}`);
    return `${latest.title}: ${document.pageCount} pages, ${chars} chars`;
  });

  return lines;
}
