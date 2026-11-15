import path from "node:path";
import { TtlCache, readJsonFile, writeFileAtomic } from "./cache.ts";
import { CninfoError, errorMessage, invalid } from "./errors.ts";
import { API_ORIGIN, type HttpClient } from "./http.ts";

export type Market = "SH" | "SZ" | "BJ" | "HK" | "FUND" | "BOND" | "OTHER";

export interface Security {
  code: string;
  name: string;
  orgId: string;
  /** 巨潮的证券类别，如 A股 / B股 / 港股 / ETF。 */
  category: string;
  market: Market;
  /** 板块：沪主板、科创板、深主板、创业板、北交所、港股…… */
  board: string;
  /** 公告查询接口的 column 参数。 */
  column: string;
  pinyin?: string;
  delisted?: boolean;
  /**
   * 同一发行人在同一栏目下的其他代码（A+B 股、北交所新旧代码）。
   * 巨潮把公告挂在其中一个代码下，按公司查询时要把它们一并带上。
   */
  aliases?: string[];
}

interface RawSecurity {
  code?: unknown;
  zwjc?: unknown;
  orgId?: unknown;
  category?: unknown;
  pinyin?: unknown;
  type?: unknown;
  delisted?: unknown;
}

const LIST_TTL_MS = 12 * 60 * 60 * 1000;
const LISTS = {
  a: "szse_stock.json", // 名字叫 szse，实际覆盖沪、深、北三地的 A/B 股
  hk: "hke_stock.json",
} as const;
type ListName = keyof typeof LISTS;

const COLUMN_BY_TYPE: Record<string, string> = {
  shj: "szse",
  hke: "hke",
  fund: "fund",
  bond: "bond",
  third: "third",
};

/** 由代码和类别推断交易所与板块。 */
export function classifySecurity(
  code: string,
  category: string,
  type?: string,
): Pick<Security, "market" | "board" | "column"> {
  if (type === "hke" || category === "港股") return { market: "HK", board: "港股", column: "hke" };
  if (type === "fund") return { market: "FUND", board: category || "基金", column: "fund" };
  if (type === "bond") return { market: "BOND", board: category || "债券", column: "bond" };
  if (type === "third") return { market: "OTHER", board: "三板", column: "third" };
  if (/^\d{6}$/.test(code)) {
    if (/^68[89]/.test(code)) return { market: "SH", board: "科创板", column: "szse" };
    if (/^900/.test(code)) return { market: "SH", board: "沪市B股", column: "szse" };
    if (/^6/.test(code)) return { market: "SH", board: "沪主板", column: "szse" };
    if (/^30/.test(code)) return { market: "SZ", board: "创业板", column: "szse" };
    if (/^20/.test(code)) return { market: "SZ", board: "深市B股", column: "szse" };
    if (/^00/.test(code)) return { market: "SZ", board: "深主板", column: "szse" };
    // 4/8 为原新三板平移代码，92 为 2024 年启用的北交所新代码段
    if (/^(4|8|92)/.test(code)) return { market: "BJ", board: "北交所", column: "szse" };
  }
  return { market: "OTHER", board: category || "其他", column: COLUMN_BY_TYPE[type ?? ""] ?? "szse" };
}

function toSecurity(raw: RawSecurity): Security | undefined {
  const code = typeof raw.code === "string" ? raw.code.trim() : "";
  const orgId = typeof raw.orgId === "string" ? raw.orgId.trim() : "";
  if (!code || !orgId) return undefined;
  const category = typeof raw.category === "string" ? raw.category : "";
  const type = typeof raw.type === "string" ? raw.type : undefined;
  const security: Security = {
    code,
    name: typeof raw.zwjc === "string" ? raw.zwjc.trim() : "",
    orgId,
    category,
    ...classifySecurity(code, category, type),
  };
  if (typeof raw.pinyin === "string" && raw.pinyin) security.pinyin = raw.pinyin.toLowerCase();
  if (raw.delisted === "true" || raw.delisted === true) security.delisted = true;
  return security;
}

/** 名称比较用的规范化：去空白、全角转半角、统一大小写（"万 科Ａ" == "万科A"）。 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toUpperCase();
}

interface ParsedQuery {
  text: string;
  /** 纯数字代码（已去掉交易所前后缀）。 */
  code?: string;
  marketHint?: Market;
}

/** 解析 "600519"、"sh600519"、"600519.SH"、"00700.HK"、"贵州茅台" 等写法。 */
export function parseSecurityQuery(input: string): ParsedQuery {
  const text = input.normalize("NFKC").trim();
  if (!text) throw invalid("stock must not be empty");
  if (text.length > 40) throw invalid("stock is too long");
  const upper = text.toUpperCase();
  const hints: Record<string, Market> = { SH: "SH", SS: "SH", SZ: "SZ", BJ: "BJ", HK: "HK" };
  let match = /^(\d{1,6})\.(SH|SS|SZ|BJ|HK)$/.exec(upper);
  if (match) return finishParsed(text, match[1]!, hints[match[2]!]);
  match = /^(SH|SZ|BJ|HK)\.?(\d{1,6})$/.exec(upper);
  if (match) return finishParsed(text, match[2]!, hints[match[1]!]);
  if (/^\d{1,6}$/.test(upper)) return finishParsed(text, upper, undefined);
  return { text };
}

function finishParsed(text: string, digits: string, marketHint: Market | undefined): ParsedQuery {
  if (marketHint === "HK" || digits.length <= 5) {
    if (digits.length > 5) throw invalid(`"${text}" is not a valid Hong Kong stock code`);
    return { text, code: digits.padStart(5, "0"), marketHint: "HK" };
  }
  return marketHint ? { text, code: digits, marketHint } : { text, code: digits };
}

interface Directory {
  all: Security[];
  byCode: Map<string, Security>;
  byName: Map<string, Security>;
}

interface DiskList {
  fetchedAt: number;
  stockList: RawSecurity[];
}

/**
 * 证券目录：把代码/简称/拼音解析为巨潮的 orgId。
 *
 * 有了 orgId，公告查询只需一次请求就能精确命中一家公司（沪深北通用），
 * 不必像按关键字搜索那样分别扫描各交易所再过滤。目录在内存和磁盘各缓存一份，
 * 上游不可用时退回磁盘上的旧副本。
 */
export class SecurityDirectory {
  private readonly http: HttpClient;
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly lists = new TtlCache<Directory>(8);
  private readonly lookups = new TtlCache<Security[]>(500);

  constructor(http: HttpClient, cacheDir: string, now: () => number = Date.now) {
    this.http = http;
    this.cacheDir = cacheDir;
    this.now = now;
  }

  /** 精确解析为唯一证券；无法唯一确定时抛出带候选的错误。 */
  async resolve(input: string): Promise<Security> {
    const query = parseSecurityQuery(input);
    if (query.code) {
      const list: ListName = query.marketHint === "HK" ? "hk" : "a";
      const hit = (await this.directory(list)).byCode.get(query.code);
      if (hit) return hit;
      // 目录没有的（基金、债券、已退市、刚上市）交给联想接口
      const remote = await this.remoteSearch(query.code);
      const exact = remote.find((s) => s.code === query.code);
      if (exact) return exact;
      throw new CninfoError("NOT_FOUND", `No security found for code "${input}"`);
    }

    const wanted = normalizeName(query.text);
    for (const list of ["a", "hk"] as const) {
      const hit = (await this.directory(list)).byName.get(wanted);
      if (hit) return hit;
    }
    const remote = await this.remoteSearch(query.text);
    const exact = remote.filter((s) => normalizeName(s.name) === wanted);
    const pool = exact.length > 0 ? exact : remote;
    if (pool.length === 0) {
      throw new CninfoError("NOT_FOUND", `No security found for "${input}"`);
    }
    // 同一家公司的 A/H 两地上市共用 orgId：优先取 A 股
    const sameIssuer = pool.every((s) => s.orgId === pool[0]!.orgId);
    if (pool.length === 1 || sameIssuer) {
      return pool.find((s) => s.column === "szse") ?? pool[0]!;
    }
    throw new CninfoError(
      "AMBIGUOUS",
      `"${input}" matches several securities; pass an exact code instead`,
      { details: { candidates: pool.slice(0, 10).map(publicSecurity) } },
    );
  }

  /** 模糊搜索：先查本地目录（代码、简称、拼音首字母），没有结果再问联想接口。 */
  async search(input: string, limit = 10): Promise<Security[]> {
    const parsed = parseSecurityQuery(input);
    // 裸数字在搜索里是代码片段（"0000"、"6005"），不能像精确解析那样补零当作港股代码
    const bareDigits = /^\d+$/.test(parsed.text);
    const query = bareDigits ? { text: parsed.text, code: parsed.text } : parsed;
    const needle = normalizeName(query.code ?? query.text);
    const lower = needle.toLowerCase();
    const scored: Array<{ score: number; security: Security }> = [];
    const settled = await Promise.allSettled([this.directory("a"), this.directory("hk")]);
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const security of result.value.all) {
        const score = matchScore(security, needle, lower, bareDigits ? undefined : parsed.marketHint);
        if (score > 0) scored.push({ score, security });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.security.code.localeCompare(b.security.code));
    const local = scored.slice(0, limit).map((entry) => entry.security);
    if (local.length > 0 && (scored[0]!.score >= 60 || local.length >= limit)) return local;

    let remote: Security[] = [];
    try {
      remote = await this.remoteSearch(query.code ?? query.text);
    } catch (error) {
      if (local.length === 0) throw error;
    }
    const seen = new Set(local.map((s) => `${s.column}:${s.code}`));
    for (const security of remote) {
      const key = `${security.column}:${security.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        local.push(security);
      }
    }
    return local.slice(0, limit);
  }

  /** 后台预热 A 股目录，让第一次工具调用不必等待目录下载。失败时静默，留给实际调用去重试。 */
  prewarm(): void {
    void this.directory("a").catch(() => {});
  }

  /** 由代码取简称（用于补全上游缺失的 secName），目录未加载成功时返回 undefined。 */
  async nameOf(code: string): Promise<string | undefined> {
    try {
      const list: ListName = code.length === 5 ? "hk" : "a";
      return (await this.directory(list)).byCode.get(code)?.name;
    } catch {
      return undefined;
    }
  }

  private remoteSearch(keyword: string): Promise<Security[]> {
    return this.lookups.getOrLoad(keyword, 60 * 60 * 1000, async () => {
      const hits = await this.http.postForm<unknown>(
        `${API_ORIGIN}/new/information/topSearch/query`,
        { keyWord: keyword, maxNum: 10 },
        {
          validate: (json) => {
            if (!Array.isArray(json)) {
              throw new CninfoError("UPSTREAM", "Unexpected security search response", {
                retryable: true,
              });
            }
          },
        },
      );
      return (hits as RawSecurity[])
        .map(toSecurity)
        .filter((s): s is Security => s !== undefined);
    });
  }

  private directory(list: ListName): Promise<Directory> {
    return this.lists.getOrLoad(list, LIST_TTL_MS, async () => {
      const file = path.join(this.cacheDir, "lists", LISTS[list]);
      const disk = await readJsonFile<DiskList>(file);
      const diskUsable = disk && Array.isArray(disk.stockList) && disk.stockList.length > 0;
      if (diskUsable && this.now() - disk.fetchedAt < LIST_TTL_MS) {
        return buildDirectory(disk.stockList);
      }
      try {
        const json = await this.http.getJson<{ stockList?: RawSecurity[] }>(
          `${API_ORIGIN}/new/data/${LISTS[list]}`,
          {
            validate: (body) => {
              if (!Array.isArray(body?.stockList) || body.stockList.length === 0) {
                throw new CninfoError("UPSTREAM", "Security list is empty", { retryable: true });
              }
            },
          },
        );
        const stockList = json.stockList!;
        const payload: DiskList = { fetchedAt: this.now(), stockList };
        // 磁盘缓存只是优化，写失败（只读目录等）不影响结果
        await writeFileAtomic(file, JSON.stringify(payload)).catch(() => {});
        return buildDirectory(stockList);
      } catch (error) {
        if (diskUsable) return buildDirectory(disk.stockList);
        throw new CninfoError(
          "UPSTREAM",
          `Could not load the CNINFO security list: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    });
  }
}

function buildDirectory(raw: RawSecurity[]): Directory {
  const all: Security[] = [];
  const byCode = new Map<string, Security>();
  const byName = new Map<string, Security>();
  const byIssuer = new Map<string, Security[]>();
  for (const item of raw) {
    const security = toSecurity(item);
    if (!security) continue;
    all.push(security);
    byCode.set(security.code, security);
    const name = normalizeName(security.name);
    // 北交所新旧代码同名：保留先出现的（新代码排在前面）
    if (name && !byName.has(name)) byName.set(name, security);
    const group = byIssuer.get(security.orgId);
    if (group) group.push(security);
    else byIssuer.set(security.orgId, [security]);
  }
  for (const group of byIssuer.values()) {
    // 上限只是防御异常数据：正常情况下一个发行人最多两三个代码
    if (group.length < 2 || group.length > 6) continue;
    for (const security of group) {
      security.aliases = group.filter((other) => other !== security).map((other) => other.code);
    }
  }
  return { all, byCode, byName };
}

function matchScore(
  security: Security,
  needle: string,
  lower: string,
  marketHint: Market | undefined,
): number {
  if (marketHint && security.market !== marketHint) return 0;
  const name = normalizeName(security.name);
  if (security.code === needle) return 100;
  if (name === needle) return 95;
  if (/^\d+$/.test(needle)) {
    if (security.code.startsWith(needle)) return 80;
    return security.code.includes(needle) && needle.length >= 3 ? 30 : 0;
  }
  if (name.startsWith(needle)) return 75;
  if (name.includes(needle)) return 60;
  if (security.pinyin === lower) return 70;
  if (security.pinyin?.startsWith(lower) && lower.length >= 2) return 40;
  return 0;
}

/** 对外输出的证券信息（不含 orgId、column 等只在内部查询时用到的字段）。 */
export function publicSecurity(security: Security): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: security.code,
    name: security.name,
    market: security.market,
    board: security.board,
    category: security.category,
  };
  if (security.delisted) out.delisted = true;
  return out;
}
