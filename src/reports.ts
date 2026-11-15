import type { Announcement, AnnouncementService } from "./announcements.ts";
import { invalid } from "./errors.ts";
import type { Security } from "./securities.ts";

export type ReportType = "annual" | "semiannual" | "q1" | "q3" | "prospectus";

/**
 * main 为报告全文；revised 为修订/更新后的全文；其余为变体：
 * summary 摘要（含季报的"正文"简版）、english 英文版、h_share 同一公司按港股规则编制的版本。
 */
export type ReportKind = "main" | "revised" | "summary" | "english" | "h_share" | "other";

export const REPORT_TYPES: Record<ReportType, { label: string; category: string }> = {
  annual: { label: "年度报告", category: "category_ndbg_szsh" },
  semiannual: { label: "半年度报告", category: "category_bndbg_szsh" },
  q1: { label: "第一季度报告", category: "category_yjdbg_szsh" },
  q3: { label: "第三季度报告", category: "category_sjdbg_szsh" },
  prospectus: { label: "招股说明书", category: "" },
};

const ALIASES: Record<string, ReportType> = {
  annual: "annual",
  annual_report: "annual",
  yearly: "annual",
  ndbg: "annual",
  年报: "annual",
  年度报告: "annual",
  semiannual: "semiannual",
  semi_annual: "semiannual",
  half_year: "semiannual",
  "half-year": "semiannual",
  interim: "semiannual",
  bndbg: "semiannual",
  半年度报告: "semiannual",
  半年报: "semiannual",
  中报: "semiannual",
  中期报告: "semiannual",
  q1: "q1",
  first_quarter: "q1",
  yjdbg: "q1",
  一季报: "q1",
  第一季度报告: "q1",
  q3: "q3",
  third_quarter: "q3",
  sjdbg: "q3",
  三季报: "q3",
  第三季度报告: "q3",
  prospectus: "prospectus",
  ipo: "prospectus",
  招股书: "prospectus",
  招股说明书: "prospectus",
  招股意向书: "prospectus",
};

export function normalizeReportType(value: string | undefined): ReportType {
  const key = (value ?? "annual").trim().toLowerCase().replace(/\s+/g, "_");
  const type = ALIASES[key];
  if (!type) {
    throw invalid(
      `Unsupported report_type "${value}". Supported: ${Object.keys(REPORT_TYPES).join(", ")}`,
    );
  }
  return type;
}

const PERIODIC_NAMES: Record<Exclude<ReportType, "prospectus">, string> = {
  annual: "年度报告|年报",
  semiannual: "半年度报告|半年报|中期报告",
  q1: "第一季度报告|一季度报告|第一季度季度报告|第一季度季报|一季报",
  q3: "第三季度报告|三季度报告|第三季度季度报告|第三季度季报|三季报",
};

const PERIODIC_PATTERNS = Object.fromEntries(
  Object.entries(PERIODIC_NAMES).map(([type, names]) => [
    type,
    // 前缀 + 年份 + 报告名 + 可选的"摘要/全文"等 + 若干括注，且必须到标题结尾。
    // 年份后的"年度"只对半年报有意义（"2006年度中期报告"）；年报的"年度"属于报告名本身
    new RegExp(
      `^(.*?)(\\d{4})${type === "semiannual" ? "(?:年度|年)?" : "年?"}(?:${names})(摘要|全文|正文)?((?:\\([^()]*\\))*)$`,
    ),
  ]),
) as Record<Exclude<ReportType, "prospectus">, RegExp>;

/** 标题前缀出现这些词说明它是"关于某报告的公告"，而不是报告本身。 */
const NOTICE_WORDS = ["关于", "取消", "说明", "提示", "致歉", "确认意见", "更正", "补充", "公告"];

const PROSPECTUS_EXCLUDED = [
  "摘要", "确认意见", "取消", "更正", "补充", "说明", "提示", "致歉", "修订", "英文",
  "关于", "意见", "核查", "验证", "问询", "回复", "公告", "审计报告", "附件", "附录",
];

export interface ReportClassification {
  kind: ReportKind;
  /** 报告期年份（定期报告取自标题）。 */
  year?: number;
}

/** NFKC 会把全角括号、全角字母统一成半角，后面的规则只需处理一种写法。 */
function compact(title: string): string {
  return title.normalize("NFKC").replace(/\s+/g, "");
}

/**
 * 判断公告标题是否为指定类型的报告，并区分正文、修订稿、摘要、英文版。
 * 不是该类型的报告（包括"关于年报的更正公告"之类）返回 undefined。
 */
export function classifyReportTitle(
  title: string,
  type: ReportType,
): ReportClassification | undefined {
  const text = compact(title);
  if (type === "prospectus") {
    if (!/^.*?(?:招股说明书|招股意向书|招股书)(?:\([^()]+\))*$/.test(text)) return undefined;
    const remainder = text.replace(/招股说明书|招股意向书|招股书/g, "");
    if (PROSPECTUS_EXCLUDED.some((word) => remainder.includes(word))) return undefined;
    return { kind: "main" };
  }

  const match = PERIODIC_PATTERNS[type].exec(text);
  if (!match) return undefined;
  const [, rawPrefix = "", yearText = "", tail = "", notes = ""] = match;
  // 两地上市公司会把港股版报告以"H股公告-2022年度报告"的标题同时披露在 A 股
  const hShare = /^(.*?)(?:H股|港股)公告[-—–:]*$/.exec(rawPrefix);
  const prefix = hShare ? (hShare[1] ?? "") : rawPrefix;
  if (NOTICE_WORDS.some((word) => prefix.includes(word))) return undefined;
  // 先收集全部特征再按固定优先级定性，结果不依赖括注的先后顺序
  const flags = new Set<ReportKind>();
  if (hShare) flags.add("h_share");
  // 深市季报分"全文"和登报用的简版"正文"，后者按摘要对待
  if (tail === "摘要" || (tail === "正文" && (type === "q1" || type === "q3"))) flags.add("summary");
  for (const note of notes.matchAll(/\(([^()]*)\)/g)) {
    const content = note[1] ?? "";
    if (content.includes("已取消")) flags.add("other");
    else if (content.includes("摘要")) flags.add("summary");
    else if (/英文|English/i.test(content)) flags.add("english");
    else if (/更新|修订|更正|修改|补充|调整/.test(content)) flags.add("revised");
    else if (!/全文|正文|中文|[AHB]股|境内|公告版/.test(content)) flags.add("other");
  }
  const precedence: ReportKind[] = ["other", "summary", "english", "h_share", "revised"];
  const kind = precedence.find((candidate) => flags.has(candidate)) ?? "main";
  return { kind, year: Number(yearText) };
}

export interface ReportItem extends Announcement {
  report_type: ReportType;
  kind: ReportKind;
  /** 报告期年份；招股书为披露年份。 */
  year?: number;
}

export interface ReportListing {
  items: ReportItem[];
  complete: boolean;
  warnings: string[];
}

export interface ReportListOptions {
  year?: number;
  /** true 时一并返回摘要、英文版等非正文变体。 */
  includeVariants?: boolean;
}

/** 列出一家公司某类报告。按 orgId 精确查询，一条请求链即可覆盖沪深北。 */
export async function listReports(
  announcements: AnnouncementService,
  security: Security,
  type: ReportType,
  options: ReportListOptions = {},
): Promise<ReportListing> {
  if (security.column !== "szse") {
    throw invalid(
      `Report listing supports Shanghai, Shenzhen and Beijing listed companies; for ${security.board} securities use search_announcements with a keyword instead`,
    );
  }
  const { year, includeVariants = false } = options;
  if (year !== undefined && (!Number.isInteger(year) || year < 1985 || year > 2100)) {
    throw invalid("year must be a four-digit year");
  }
  const spec = REPORT_TYPES[type];
  const result = await announcements.query(
    type === "prospectus"
      ? { securities: [security], keyword: "招股", limit: 3000 }
      : { securities: [security], categories: [spec.category], limit: 3000 },
  );

  const items: ReportItem[] = [];
  for (const announcement of result.items) {
    const classified = classifyReportTitle(announcement.title, type);
    if (!classified) continue;
    if (!includeVariants && classified.kind !== "main" && classified.kind !== "revised") continue;
    const itemYear = classified.year ?? (Number(announcement.date.slice(0, 4)) || undefined);
    if (year !== undefined && itemYear !== year) continue;
    const item: ReportItem = { ...announcement, report_type: type, kind: classified.kind };
    if (itemYear !== undefined) item.year = itemYear;
    items.push(item);
  }
  items.sort(
    (a, b) =>
      (b.year ?? 0) - (a.year ?? 0) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
  return { items, complete: result.complete, warnings: result.warnings };
}
