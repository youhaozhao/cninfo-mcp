import { TtlCache } from "./cache.ts";
import { CninfoError, errorMessage, invalid } from "./errors.ts";
import { API_ORIGIN, type HttpClient } from "./http.ts";
import type { Security } from "./securities.ts";

type Raw = Record<string, unknown>;

interface Envelope {
  code?: unknown;
  data?: { resultMsg?: unknown; resultCode?: unknown; total?: unknown; records?: unknown } | null;
}

const DATA_TTL_MS = 10 * 60 * 1000;

interface TableSpec {
  label: string;
  path: string;
  /** 上游字段 -> 输出列名；输出顺序即此处的声明顺序。 */
  fields: Record<string, string>;
  params?: Record<string, string | number>;
}

const HOLDER_FIELDS = {
  F001D: "截止日期",
  F005N: "名次",
  F002V: "股东名称",
  F003N: "持股数量(万股)",
  F004N: "持股比例(%)",
  F006V: "股份性质",
  F007V: "持股变动",
};

/** 巨潮个股数据页背后的表格型数据集。 */
export const TABLE_DATASETS = {
  executives: {
    label: "高管与董监事",
    path: "companyOverview/getCompanyExecutives",
    fields: {
      F002V: "姓名",
      F009V: "职务",
      F010V: "性别",
      F012V: "出生年份",
      F017V: "学历",
      F012N: "年薪(万元)",
      F005N: "持股数(股)",
    },
  },
  dividends: {
    label: "历史分红",
    path: "companyOverview/getCompanyHisDividend",
    fields: {
      F001V: "报告期",
      F007V: "分红方案",
      F018D: "股权登记日",
      F020D: "除权除息日",
      F023D: "派息日",
    },
  },
  share_structure: {
    label: "股本结构",
    path: "stockholderCapital/getStockStructure",
    fields: {
      VARYDATE: "变动日期",
      F002V: "变动原因",
      F003N: "总股本(万股)",
      F021N: "已流通股份(万股)",
      F022N: "人民币普通股/CDR(万股)",
      F023N: "境内上市外资股B股(万股)",
      F024N: "境外上市外资股H股(万股)",
      F028N: "流通受限股份(万股)",
    },
  },
  shareholder_count: {
    label: "股东人数",
    path: "stockholderCapital/getStockholderNum",
    fields: { ENDDATE: "截止日期", F001N: "股东人数(户)", F009N: "较上期变动(%)" },
  },
  top_shareholders: {
    label: "十大股东",
    path: "stockholderCapital/getTopTenStockholders",
    fields: HOLDER_FIELDS,
  },
  top_float_shareholders: {
    label: "十大流通股东",
    path: "stockholderCapital/getTopTenCirculatingStockholders",
    fields: HOLDER_FIELDS,
  },
  fund_holdings: {
    label: "基金持股",
    path: "stockholderCapital/getFundHoldings",
    fields: { ENDDATE: "报告期", F001N: "持股基金数(只)", F002N: "持股总数(股)" },
  },
  unlocks: {
    label: "限售解禁",
    path: "stockholderCapital/getLiftBan",
    fields: {
      F003D: "解除限售日期",
      F004N: "解除限售数量(万股)",
      F005N: "解除限售比例(%)",
    },
  },
  pledges: {
    label: "股权质押",
    path: "stockholderCapital/getEquityPledge",
    fields: {
      DECLAREDATE: "公告日期",
      F001V: "出质人",
      F003V: "质权人",
      F006N: "质押数量(万股)",
      F007N: "占总股本比例(%)",
      F012N: "质押解除数量(万股)",
    },
  },
  margin_trading: {
    label: "融资融券",
    path: "tradeInformation/getMarginTrading",
    fields: {
      TRADEDATE: "交易日期",
      F001N: "融资余额(元)",
      F002N: "融资买入额(元)",
      F004N: "融券余量(股)",
      F006N: "融券卖出量(股)",
      F008N: "融券余量金额(元)",
      F009N: "融资融券余额(元)",
    },
  },
  block_trades: {
    label: "大宗交易",
    path: "tradeInformation/getIntsDetail",
    fields: {
      TRADEDATE: "交易日期",
      F004N: "成交价格(元)",
      F005N: "成交数量(万股)",
      F006N: "成交金额(万元)",
      F002V: "买方营业部",
      F003V: "卖方营业部",
    },
  },
  shareholder_trades: {
    label: "股东增减持",
    path: "tradeInformation/getStockholederIncDecDetail",
    fields: {
      VARYDATE: "变动日期",
      F002V: "股东名称",
      F001C: "方向",
      F004N: "增减持数量(股)",
      F005N: "增减持比例(%)",
      F007V: "交易价格(元)",
    },
  },
  executive_trades: {
    label: "董监高持股变动",
    path: "tradeInformation/getExecutivesIncDecDetail",
    fields: {
      ENDDATE: "变动日期",
      DECLAREDATE: "公告日期",
      HUMANNAME: "变动人",
      F006N: "变动数量(股)",
      F008N: "成交均价(元)",
      F001V: "董监高姓名",
      F002V: "董监高职务",
      F003V: "与董监高关系",
      F010V: "变动原因",
    },
  },
} satisfies Record<string, TableSpec>;

export type TableDataset = keyof typeof TABLE_DATASETS;
export type Dataset = TableDataset | "profile" | "dragon_tiger";

export const DATASET_LABELS: Record<Dataset, string> = {
  profile: "公司概况",
  ...(Object.fromEntries(
    Object.entries(TABLE_DATASETS).map(([name, spec]) => [name, spec.label]),
  ) as Record<TableDataset, string>),
  dragon_tiger: "龙虎榜",
};

const PROFILE_FIELDS: Record<string, string> = {
  ORGNAME: "公司名称",
  F001V: "英文名称",
  F002V: "曾用简称",
  F052V: "关联证券",
  MARKET: "所属市场",
  F032V: "所属行业",
  F010D: "成立日期",
  F006D: "上市日期",
  F003V: "法人代表",
  F042V: "总经理",
  F018V: "董秘",
  F007N: "注册资本(万元)",
  F004V: "注册地址",
  F005V: "办公地址",
  F006V: "邮政编码",
  F013V: "联系电话",
  F014V: "传真",
  F011V: "官方网址",
  F012V: "电子邮箱",
  F044V: "入选指数",
  F015V: "主营业务",
  F016V: "经营范围",
  F017V: "机构简介",
};

const LISTING_FIELDS: Record<string, string> = {
  F007N: "每股面值(元)",
  F008N: "首发价格(元)",
  F028N: "首发募资净额(万元)",
  F047V: "首发主承销商",
};

const INDICATOR_FIELDS: Record<string, string> = {
  F004N: "基本每股收益(元)",
  F008N: "每股净资产(元)",
  F010N: "每股资本公积金(元)",
  F067N: "加权净资产收益率(%)",
  F078N: "毛利率(%)",
  F011N: "营业利润率(%)",
  F017N: "净利润率(%)",
  F016N: "总资产报酬率(%)",
  F052N: "营业收入增长率(%)",
  F058N: "营业利润增长率(%)",
  F053N: "净利润增长率(%)",
  F056N: "总资产增长率(%)",
  F054N: "净资产增长率(%)",
  F041N: "资产负债率(%)",
  F042N: "流动比率",
  F043N: "速动比率",
  F022N: "应收账款周转率(次)",
  F023N: "存货周转率(次)",
  F029N: "流动资产周转率(次)",
  F026N: "固定资产周转率(次)",
  F025N: "总资产周转率(次)",
};

export type Statement = "indicators" | "income" | "balance" | "cashflow";
export type Period = "annual" | "semiannual" | "q1" | "q3";

const STATEMENTS: Record<Statement, { label: string; path: string }> = {
  indicators: { label: "主要指标", path: "financialData/getMainIndicators" },
  income: { label: "利润表", path: "financialData/getIncomeStatement" },
  balance: { label: "资产负债表", path: "financialData/getBalanceSheets" },
  cashflow: { label: "现金流量表", path: "financialData/getCashFlowStatement" },
};

/** 上游用 year/middle/one/three 四个键区分报告期。 */
const PERIOD_KEYS: Record<Period, { key: string; monthDay: string; label: string }> = {
  annual: { key: "year", monthDay: "12-31", label: "年报" },
  semiannual: { key: "middle", monthDay: "06-30", label: "半年报" },
  q1: { key: "one", monthDay: "03-31", label: "一季报" },
  q3: { key: "three", monthDay: "09-30", label: "三季报" },
};

export interface TableResult {
  dataset: Dataset;
  label: string;
  total: number;
  rows: Raw[];
  truncated?: boolean;
}

export interface FinancialTable {
  statement: Statement;
  label: string;
  /** 金额单位；主要指标各行自带单位，此处为空。 */
  unit: string;
  periods: string[];
  /** 科目 -> 与 periods 对齐的数值。 */
  rows: Record<string, Array<number | null>>;
}

function cleanValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
  return text === "" || text === "--" ? null : text;
}

function mapRow(record: Raw, fields: Record<string, string>): Raw {
  const row: Raw = {};
  for (const [source, label] of Object.entries(fields)) {
    // 个别接口的字段名大小写不一致（VARYDATE / varydate）
    const value = cleanValue(record[source] ?? record[source.toLowerCase()]);
    if (value !== null && value !== undefined) row[label] = value;
  }
  return row;
}

export class CompanyDataService {
  private readonly http: HttpClient;
  private readonly cache = new TtlCache<Raw[]>(400);

  constructor(http: HttpClient) {
    this.http = http;
  }

  async table(security: Security, dataset: Dataset, limit: number): Promise<TableResult> {
    assertAShare(security);
    const label = DATASET_LABELS[dataset];
    if (dataset === "profile") {
      const rows = [await this.profile(security)];
      return { dataset, label, total: 1, rows };
    }
    if (dataset === "dragon_tiger") {
      const records = await this.records("tradeInformation/getPublicInfo", security.code, {
        page: 1,
        rows: Math.min(limit, 20),
      });
      const rows = records.map(dragonTigerRow);
      return { dataset, label, total: rows.length, rows };
    }
    const spec: TableSpec = TABLE_DATASETS[dataset];
    if (!spec) throw invalid(`Unknown dataset "${String(dataset)}"`);
    const records = await this.records(spec.path, security.code, spec.params);
    const rows = records.slice(0, limit).map((record) => {
      const row = mapRow(record, spec.fields);
      if (dataset === "shareholder_trades" && typeof row["方向"] === "string") {
        row["方向"] = row["方向"] === "B" ? "增持" : "减持";
      }
      return row;
    });
    const result: TableResult = { dataset, label, total: records.length, rows };
    if (records.length > rows.length) result.truncated = true;
    return result;
  }

  async financials(
    security: Security,
    statement: Statement,
    period: Period,
    maxPeriods: number,
  ): Promise<FinancialTable> {
    assertAShare(security);
    const spec = STATEMENTS[statement];
    const sign = await this.reportingSign(security.code);
    const records = await this.records(spec.path, security.code, { sign });
    const group = records[0]?.[PERIOD_KEYS[period].key];
    const list: Raw[] = Array.isArray(group) ? (group as Raw[]) : [];

    if (statement === "indicators") {
      const sorted = list
        .filter((item) => typeof item.ENDDATE === "string")
        .sort((a, b) => String(b.ENDDATE).localeCompare(String(a.ENDDATE)))
        .slice(0, maxPeriods);
      const rows: FinancialTable["rows"] = {};
      for (const [field, label] of Object.entries(INDICATOR_FIELDS)) {
        const values = sorted.map((item) => numberOrNull(item[field]));
        if (values.some((value) => value !== null)) rows[label] = values;
      }
      return {
        statement,
        label: spec.label,
        unit: "",
        periods: sorted.map((item) => String(item.ENDDATE)),
        rows,
      };
    }

    const years = new Set<string>();
    for (const item of list) {
      for (const key of Object.keys(item)) if (/^\d{4}$/.test(key)) years.add(key);
    }
    const ordered = [...years].sort().reverse().slice(0, maxPeriods);
    const rows: FinancialTable["rows"] = {};
    for (const item of list) {
      const name = typeof item.index === "string" ? item.index.trim() : "";
      if (!name) continue;
      const values = ordered.map((year) => numberOrNull(item[year]));
      // 全空的行是上游的分组标题（"资产类科目"）或该行业不适用的科目
      if (values.some((value) => value !== null)) rows[name] = values;
    }
    return {
      statement,
      label: spec.label,
      unit: "万元",
      periods: ordered.map((year) => `${year}-${PERIOD_KEYS[period].monthDay}`),
      rows,
    };
  }

  private async profile(security: Security): Promise<Raw> {
    const records = await this.records("companyOverview/getCompanyIntroduction", security.code);
    const record = records[0] ?? {};
    const basic = firstObject(record.basicInformation);
    const listing = firstObject(record.listingInformation);
    return {
      证券代码: security.code,
      证券简称: security.name,
      ...mapRow(basic, PROFILE_FIELDS),
      ...mapRow(listing, LISTING_FIELDS),
    };
  }

  /** 财务报表模板标识（一般企业、银行、保险、证券各不相同），随公司固定，缓存较久。 */
  private async reportingSign(code: string): Promise<number> {
    const records = await this.records("companyOverview/getCompanyInfo", code);
    const sign = Number(records[0]?.F002N);
    return Number.isFinite(sign) && sign > 0 ? sign : 1;
  }

  private records(
    path: string,
    code: string,
    params: Record<string, string | number> = {},
  ): Promise<Raw[]> {
    const key = JSON.stringify([path, code, params]);
    return this.cache.getOrLoad(key, DATA_TTL_MS, async () => {
      try {
        const body = await this.http.getJson<Envelope>(`${API_ORIGIN}/data20/${path}`, {
          query: { scode: code, ...params },
          validate: (json) => {
            const data = json?.data;
            // 上游内部超时会返回 200 + resultMsg=fail，重试通常即可恢复
            if (!data || !Array.isArray(data.records) || data.resultMsg !== "success") {
              throw new CninfoError(
                "UPSTREAM",
                `CNINFO data service returned ${String(data?.resultMsg ?? "an invalid response")}`,
                { retryable: true },
              );
            }
          },
        });
        return body.data!.records as Raw[];
      } catch (error) {
        throw new CninfoError("UPSTREAM", `${path}: ${errorMessage(error)}`, { cause: error });
      }
    });
  }
}

/** 结构化数据只覆盖沪深北上市公司；港股、基金、债券直接给出明确的输入错误。 */
export function assertAShare(security: Security): void {
  if (security.column !== "szse") {
    throw invalid(
      `Company data is available for Shanghai, Shenzhen and Beijing listed stocks, not for ${security.board} securities`,
    );
  }
}

function firstObject(value: unknown): Raw {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" ? (value[0] as Raw) : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dragonTigerRow(record: Raw): Raw {
  const detail = Array.isArray(record.detail) ? (record.detail as Raw[]) : [];
  return {
    交易日期: record.tradeTime,
    上榜原因: record.type,
    "买入合计(元)": record.buyTotal,
    "卖出合计(元)": record.sellTotal,
    买入前五: detail
      .filter((item) => item.buyOrgName)
      .map((item) => ({
        营业部: item.buyOrgName,
        "买入金额(元)": item.buyOrgBuyTotal,
        "卖出金额(元)": item.buyOrgSellTotal,
      })),
    卖出前五: detail
      .filter((item) => item.sellOrgName)
      .map((item) => ({
        营业部: item.sellOrgName,
        "买入金额(元)": item.sellOrgBuyTotal,
        "卖出金额(元)": item.sellOrgSellTotal,
      })),
  };
}
