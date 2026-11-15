import { TtlCache } from "./cache.ts";
import { parseDate, shanghaiDateTime } from "./dates.ts";
import { CninfoError, errorMessage, invalid } from "./errors.ts";
import { API_ORIGIN, STATIC_ORIGIN, assertAllowedUrl, type HttpClient } from "./http.ts";
import type { Security } from "./securities.ts";

/** 上游单页固定最多 30 条，传更大的 pageSize 也不会多给。 */
export const PAGE_SIZE = 30;
/** 单次查询最多翻的页数，防止异常 total 造成失控翻页。 */
export const MAX_PAGES = 100;

const QUERY_URL = `${API_ORIGIN}/new/hisAnnouncement/query`;
const RESULT_TTL_MS = 60 * 1000;

/** 沪深北公告分类：友好名称 -> 巨潮 category 参数。 */
export const CATEGORIES: Record<string, { id: string; label: string }> = {
  annual_report: { id: "category_ndbg_szsh", label: "年报" },
  semiannual_report: { id: "category_bndbg_szsh", label: "半年报" },
  q1_report: { id: "category_yjdbg_szsh", label: "一季报" },
  q3_report: { id: "category_sjdbg_szsh", label: "三季报" },
  earnings_forecast: { id: "category_yjygjxz_szsh", label: "业绩预告" },
  dividend: { id: "category_qyfpxzcs_szsh", label: "权益分派" },
  board: { id: "category_dshgg_szsh", label: "董事会" },
  supervisory_board: { id: "category_jshgg_szsh", label: "监事会" },
  shareholder_meeting: { id: "category_gddh_szsh", label: "股东会" },
  operations: { id: "category_rcjy_szsh", label: "日常经营" },
  governance: { id: "category_gszl_szsh", label: "公司治理" },
  intermediary: { id: "category_zj_szsh", label: "中介报告" },
  ipo: { id: "category_sf_szsh", label: "首发" },
  placement: { id: "category_zf_szsh", label: "增发" },
  equity_incentive: { id: "category_gqjl_szsh", label: "股权激励" },
  rights_issue: { id: "category_pg_szsh", label: "配股" },
  unlock: { id: "category_jj_szsh", label: "解禁" },
  corporate_bond: { id: "category_gszq_szsh", label: "公司债" },
  convertible_bond: { id: "category_kzzq_szsh", label: "可转债" },
  other_financing: { id: "category_qtrz_szsh", label: "其他融资" },
  equity_change: { id: "category_gqbd_szsh", label: "股权变动" },
  correction: { id: "category_bcgz_szsh", label: "补充更正" },
  clarification: { id: "category_cqdq_szsh", label: "澄清致歉" },
  risk_warning: { id: "category_fxts_szsh", label: "风险提示" },
  st_delisting: { id: "category_tbclts_szsh", label: "特别处理和退市" },
  delisting_period: { id: "category_tszlq_szsh", label: "退市整理期" },
};

/** 投资者关系（调研）页签下的分类。 */
export const RELATION_CATEGORIES: Record<string, { id: string; label: string }> = {
  research: { id: "category_dyhd_szdy", label: "调研活动" },
  roadshow: { id: "category_lyhd_szdy", label: "路演活动" },
  media_interview: { id: "category_mdcf_szdy", label: "媒体采访" },
  ir_policy: { id: "category_glzd_szdy", label: "管理制度" },
};

export const PLATES: Record<string, string> = {
  sh: "沪市",
  shmb: "沪主板",
  shkcp: "科创板",
  sz: "深市",
  szmb: "深主板",
  szcy: "创业板",
  bj: "北交所",
};

export type AnnouncementTab = "announcements" | "investor_relations";

export interface AnnouncementQuery {
  securities?: Security[];
  /** 不指定证券做全市场查询时使用，默认沪深北（szse）。 */
  column?: string;
  tab?: AnnouncementTab;
  /** 友好分类名、中文名或原始 category_* 标识。 */
  categories?: string[];
  /** 标题关键字。 */
  keyword?: string;
  startDate?: string;
  endDate?: string;
  plate?: string;
  sort?: "newest" | "oldest";
  limit: number;
  offset?: number;
}

export interface Announcement {
  id: string;
  code: string;
  name: string;
  title: string;
  /** 披露日期（北京时间）。 */
  date: string;
  /** 披露时刻，仅当上游提供了非零点时间时存在。 */
  time?: string;
  url: string;
  format: string;
  size_kb?: number;
  org_id?: string;
}

export interface AnnouncementResult {
  /** 上游报告的命中总数。 */
  total: number;
  items: Announcement[];
  /** false 表示有分页抓取失败，items 不完整。 */
  complete: boolean;
  warnings: string[];
  /**
   * 继续翻页应使用的 offset（按上游原始行计）。上游行可能因缺附件或重复而被丢弃，
   * 所以它不一定等于 offset + items.length。
   */
  nextOffset: number;
}

interface RawAnnouncement {
  announcementId?: unknown;
  secCode?: unknown;
  secName?: unknown;
  orgId?: unknown;
  announcementTitle?: unknown;
  announcementTime?: unknown;
  adjunctUrl?: unknown;
  adjunctType?: unknown;
  adjunctSize?: unknown;
}

interface RawPage {
  totalAnnouncement?: unknown;
  totalRecordNum?: unknown;
  announcements?: unknown;
}

/** 把分类写法（友好名 / 中文名 / category_*）解析为上游标识。 */
export function resolveCategory(value: string, tab: AnnouncementTab): string {
  const table = tab === "investor_relations" ? RELATION_CATEGORIES : CATEGORIES;
  const key = value.trim();
  const lower = key.toLowerCase();
  if (table[lower]) return table[lower].id;
  for (const entry of Object.values(table)) {
    if (entry.id === lower || entry.label === key) return entry.id;
  }
  // 基金、债券、三板等栏目有各自的 category_* 标识，原样放行
  if (/^category_[a-z0-9_]+$/.test(lower)) return lower;
  throw invalid(
    `Unknown category "${value}". Supported: ${Object.entries(table)
      .map(([name, entry]) => `${name} (${entry.label})`)
      .join(", ")}`,
  );
}

/** 去掉高亮标签并解码少量实体，得到干净的标题。 */
export function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<\/?em>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把公告附件路径解析为 static.cninfo.com.cn 上的绝对 HTTPS URL。 */
export function resolveDocumentUrl(value: string): string {
  const text = value.trim();
  if (!text || /[\s\\\x00-\x1f\x7f]/.test(text)) {
    throw new CninfoError("FORBIDDEN_URL", "Invalid document URL");
  }
  const url = assertAllowedUrl(text, `${STATIC_ORIGIN}/`);
  if (url.hostname !== "static.cninfo.com.cn") {
    throw new CninfoError(
      "FORBIDDEN_URL",
      "Document URLs must be on https://static.cninfo.com.cn",
    );
  }
  return url.href;
}

export function normalizeAnnouncement(raw: RawAnnouncement): Announcement | undefined {
  const adjunct = typeof raw.adjunctUrl === "string" ? raw.adjunctUrl : "";
  if (!adjunct) return undefined;
  let url: string;
  try {
    url = resolveDocumentUrl(adjunct);
  } catch {
    return undefined;
  }
  const epoch = typeof raw.announcementTime === "number" ? raw.announcementTime : Number.NaN;
  const when = Number.isFinite(epoch) ? shanghaiDateTime(epoch) : undefined;
  const extension = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1] ?? "";
  const announcement: Announcement = {
    id: String(raw.announcementId ?? ""),
    code: typeof raw.secCode === "string" ? raw.secCode : "",
    name: typeof raw.secName === "string" ? raw.secName.replace(/\s+/g, "") : "",
    title: cleanTitle(raw.announcementTitle),
    date: when?.date ?? "",
    url,
    format: (typeof raw.adjunctType === "string" && raw.adjunctType
      ? raw.adjunctType
      : extension
    ).toUpperCase(),
  };
  if (when && when.time !== "00:00") announcement.time = when.time;
  if (typeof raw.adjunctSize === "number" && raw.adjunctSize > 0) {
    announcement.size_kb = raw.adjunctSize;
  }
  if (typeof raw.orgId === "string" && raw.orgId) announcement.org_id = raw.orgId;
  return announcement;
}

export class AnnouncementService {
  private readonly http: HttpClient;
  private readonly cache = new TtlCache<AnnouncementResult>(200);

  constructor(http: HttpClient) {
    this.http = http;
  }

  /**
   * 查询公告。先取第一页得到 total，再并发抓取其余所需分页
   * （并发度由 HttpClient 全局限制），最后按公告 ID 去重。
   */
  async query(query: AnnouncementQuery): Promise<AnnouncementResult> {
    const form = buildForm(query);
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, query.limit);
    const key = JSON.stringify([form, offset, limit]);
    const result = await this.cache.getOrLoad(key, RESULT_TTL_MS, () =>
      this.run(form, offset, limit, query),
    );
    // 不完整的结果不留在缓存里：下一次调用应当重新尝试失败的分页
    if (!result.complete) this.cache.delete(key);
    return result;
  }

  private async run(
    form: Record<string, string | number>,
    offset: number,
    limit: number,
    query: AnnouncementQuery,
  ): Promise<AnnouncementResult> {
    const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
    const first = await this.fetchPage(form, firstPage);
    const warnings: string[] = [];
    const wantedEnd = Math.min(first.total, offset + limit);
    let lastPage = Math.max(firstPage, Math.ceil(wantedEnd / PAGE_SIZE));
    if (lastPage - firstPage + 1 > MAX_PAGES) {
      lastPage = firstPage + MAX_PAGES - 1;
      warnings.push(
        `Result capped at ${MAX_PAGES * PAGE_SIZE} announcements; narrow the date range or add filters`,
      );
    }

    const pages = new Map<number, RawAnnouncement[]>([[firstPage, first.items]]);
    let complete = true;
    const rest: number[] = [];
    for (let page = firstPage + 1; page <= lastPage; page++) rest.push(page);
    const settled = await Promise.allSettled(rest.map((page) => this.fetchPage(form, page)));
    settled.forEach((result, index) => {
      const page = rest[index]!;
      if (result.status === "fulfilled") {
        pages.set(page, result.value.items);
      } else {
        complete = false;
        warnings.push(`Page ${page} failed: ${errorMessage(result.reason)}`);
      }
    });

    const allowedOrgIds = query.securities?.length
      ? new Set(query.securities.map((s) => s.orgId))
      : undefined;
    const seen = new Set<string>();
    const items: Announcement[] = [];
    // 没有提前凑满 limit 时，窗口内的原始行已全部看过
    let nextOffset = Math.min(first.total, lastPage * PAGE_SIZE);
    scan: for (let page = firstPage; page <= lastPage; page++) {
      const rows = pages.get(page) ?? [];
      for (let index = 0; index < rows.length; index++) {
        const position = (page - 1) * PAGE_SIZE + index; // 该行在上游结果中的 0 起始位置
        if (position < offset) continue;
        const item = normalizeAnnouncement(rows[index]!);
        if (!item) continue;
        // 防御：按 orgId 查询时丢弃上游偶发混入的其他公司记录
        if (allowedOrgIds && item.org_id && !allowedOrgIds.has(item.org_id)) continue;
        const dedupeKey = item.id || item.url;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        items.push(item);
        if (items.length >= limit) {
          nextOffset = position + 1;
          break scan;
        }
      }
    }
    return { total: first.total, items, complete, warnings, nextOffset: Math.max(offset, nextOffset) };
  }

  private async fetchPage(
    form: Record<string, string | number>,
    page: number,
  ): Promise<{ total: number; items: RawAnnouncement[] }> {
    const json = await this.http.postForm<RawPage>(
      QUERY_URL,
      { ...form, pageNum: page },
      {
        validate: (body) => {
          const list = (body as RawPage | null)?.announcements;
          if (
            body === null ||
            typeof body !== "object" ||
            !("announcements" in body) ||
            (list !== null && !Array.isArray(list))
          ) {
            throw new CninfoError("UPSTREAM", "Unexpected announcement response", {
              retryable: true,
            });
          }
        },
      },
    );
    const items = (json.announcements as RawAnnouncement[] | null) ?? [];
    const total = Number(json.totalAnnouncement ?? json.totalRecordNum ?? items.length);
    return { total: Number.isFinite(total) ? total : items.length, items };
  }
}

function buildForm(query: AnnouncementQuery): Record<string, string | number> {
  const tab = query.tab ?? "announcements";
  const securities = query.securities ?? [];
  const columns = new Set(securities.map((s) => s.column));
  if (columns.size > 1) {
    throw invalid(
      "All stocks in one query must be from the same market group (A-share vs Hong Kong vs fund)",
    );
  }
  const column = securities[0]?.column ?? query.column ?? "szse";

  let seDate = "";
  if (query.startDate || query.endDate) {
    const start = query.startDate ? parseDate(query.startDate, "start_date") : "2000-01-01";
    const end = query.endDate ? parseDate(query.endDate, "end_date") : "2099-12-31";
    if (start > end) throw invalid("start_date must not be after end_date");
    seDate = `${start}~${end}`;
  }

  const plate = query.plate?.trim().toLowerCase() ?? "";
  if (plate && !PLATES[plate]) {
    throw invalid(`Unknown market "${query.plate}". Supported: ${Object.keys(PLATES).join(", ")}`);
  }
  const keyword = query.keyword?.trim() ?? "";
  if (keyword.length > 100) throw invalid("keyword is too long");

  return {
    pageNum: 1,
    pageSize: PAGE_SIZE,
    column,
    tabName: tab === "investor_relations" ? "relation" : "fulltext",
    plate,
    stock: securities
      .flatMap((s) => [s.code, ...(s.aliases ?? [])].map((code) => `${code},${s.orgId}`))
      .join(";"),
    searchkey: keyword,
    secid: "",
    category: (query.categories ?? []).map((c) => resolveCategory(c, tab)).join(";"),
    trade: "",
    seDate,
    sortName: query.sort === "oldest" ? "time" : "",
    sortType: query.sort === "oldest" ? "asc" : "",
    isHLtitle: "false",
  };
}
