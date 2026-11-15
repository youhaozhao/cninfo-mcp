# 工具与配置参考

所有 `stock` 参数都接受代码或简称：`600519`、`000001.SZ`、`sh600519`、`920185`（北交所新旧代码均可）、`00700.HK`、`贵州茅台`。

## 查找与检索

### `search_securities`

按代码、简称或拼音首字母查找证券。覆盖沪、深、北交所的 A 股和 B 股以及港股；基金和债券可按完整代码查到。

- `query`（必填）：代码、简称片段或拼音首字母，如 `茅台`、`gzmt`、`6005`
- `limit`（可选）：返回条数，默认 10

### `list_reports`

列出一家公司的定期报告或招股书。

- `stock`（必填）
- `report_type`（可选）：报告类型，默认 `annual`
- `year`（可选）：报告期年份；招股书按披露年份。省略则返回全部年份
- `include_variants`（可选）：是否同时返回摘要、英文版等变体，默认 `false`

`report_type` 的取值（中文别名如“年报”“半年报”也可以）：

| 取值 | 报告 |
| --- | --- |
| `annual` | 年度报告 |
| `semiannual` | 半年度报告（中报） |
| `q1` | 第一季度报告 |
| `q3` | 第三季度报告 |
| `prospectus` | 招股说明书 / 招股意向书 |

每条结果带 `kind` 字段：

| `kind` | 含义 | 默认返回 |
| --- | --- | --- |
| `main` | 报告全文 | 是 |
| `revised` | 更新后 / 修订后的全文 | 是 |
| `summary` | 摘要（含深市季报的“正文”简版） | 否 |
| `english` | 英文版 | 否 |
| `h_share` | 两地上市公司按港股规则编制的版本 | 否 |
| `other` | 已取消等其他情况 | 否 |

“关于年报的更正公告”这类并非报告本身的公告不会出现在结果里。

### `search_announcements`

检索公告，默认按披露时间从新到旧。

- `stock`（可选）：代码或简称，多个用逗号分隔（最多 10 个）。省略即全市场检索
- `keyword`（可选）：标题关键字，如 `回购`
- `categories`（可选）：公告分类，见下表，中英文名均可
- `start_date` / `end_date`（可选）：`YYYY-MM-DD`，北京时间，含首尾
- `market`（可选）：全市场检索时的板块筛选——`sh` 沪市、`shmb` 沪主板、`shkcp` 科创板、`sz` 深市、`szmb` 深主板、`szcy` 创业板、`bj` 北交所
- `source`（可选）：`announcements`（默认）或 `investor_relations`（调研 / 投资者关系活动记录）
- `sort`（可选）：`newest`（默认）或 `oldest`
- `limit`（可选）：默认 30，最大 200
- `offset`（可选）：翻页位置

返回 `total`（命中总数）；还有更多结果时带 `next_offset`，把它作为下一次调用的 `offset`。

公告分类：

| 名称 | 分类 | 名称 | 分类 |
| --- | --- | --- | --- |
| `annual_report` | 年报 | `equity_incentive` | 股权激励 |
| `semiannual_report` | 半年报 | `rights_issue` | 配股 |
| `q1_report` | 一季报 | `unlock` | 解禁 |
| `q3_report` | 三季报 | `corporate_bond` | 公司债 |
| `earnings_forecast` | 业绩预告 | `convertible_bond` | 可转债 |
| `dividend` | 权益分派 | `other_financing` | 其他融资 |
| `board` | 董事会 | `equity_change` | 股权变动 |
| `supervisory_board` | 监事会 | `correction` | 补充更正 |
| `shareholder_meeting` | 股东会 | `clarification` | 澄清致歉 |
| `operations` | 日常经营 | `risk_warning` | 风险提示 |
| `governance` | 公司治理 | `st_delisting` | 特别处理和退市 |
| `intermediary` | 中介报告 | `delisting_period` | 退市整理期 |
| `ipo` | 首发 | `placement` | 增发 |

`source=investor_relations` 时的分类：`research` 调研活动、`roadshow` 路演活动、`media_interview` 媒体采访、`ir_policy` 管理制度。

分类只适用于沪、深、北交所；港股公告请用 `keyword` 检索。

## 阅读

### `read_document`

阅读公告或报告正文（PDF；早期公告为 HTML）。结果是纯文本。

- `url`（必填）：`list_reports` 或 `search_announcements` 返回的文档地址
- `pages`（可选）：页码范围，如 `5`、`10-20`、`1-3,8`
- `query`（可选）：要在文档内定位的关键字，空格分隔，任一命中即可
- `max_chars`（可选）：输出字数上限，默认 20000

三种用法：

1. 只给 `url`：返回页数、目录和开头几页。
2. 给 `query`：返回命中的页码和上下文片段，用来在长报告里定位章节。
3. 给 `pages`：返回这些页的全文。超出 `max_chars` 时，结果末尾会给出继续读取用的 `pages` 值。

## 结构化数据

仅支持沪、深、北交所上市公司。

### `get_financials`

- `stock`（必填）
- `statements`（可选）：`indicators` 主要指标、`income` 利润表、`balance` 资产负债表、`cashflow` 现金流量表，可多选，默认 `indicators`
- `period`（可选）：`annual`（默认）、`semiannual`、`q1`、`q3`；季报和半年报为年初至报告期末的累计值
- `periods`（可选）：返回最近几期，默认 5（上游最多提供 5 期）

报表金额单位为万元，是巨潮个股页的精简口径（主要科目）；需要完整科目请用 `read_document` 读报告原文。

### `get_company_data`

- `stock`（必填）
- `datasets`（必填）：一次可取多个数据集（最多 8 个），并发获取
- `limit`（可选）：每个数据集返回的行数，默认 20

| 数据集 | 内容 | 数据集 | 内容 |
| --- | --- | --- | --- |
| `profile` | 公司概况 | `unlocks` | 限售解禁 |
| `executives` | 高管与董监事 | `pledges` | 股权质押 |
| `dividends` | 历史分红 | `margin_trading` | 融资融券 |
| `share_structure` | 股本结构 | `block_trades` | 大宗交易 |
| `shareholder_count` | 股东人数 | `shareholder_trades` | 股东增减持 |
| `top_shareholders` | 十大股东 | `executive_trades` | 董监高持股变动 |
| `top_float_shareholders` | 十大流通股东 | `dragon_tiger` | 龙虎榜 |
| `fund_holdings` | 基金持股 | | |

## 下载

### `download_reports`

把定期报告或招股书的 PDF 保存到下载目录，选取规则与 `list_reports` 相同（只下载报告全文）。

- `stock`（必填）
- `report_type`（可选）：默认 `annual`
- `year`（可选）：省略则下载全部年份
- `save_path`（可选）：下载根目录下的子目录，如 `annual/2024`；根目录之外的路径会被拒绝

### `download_documents`

- `urls`（必填）：文档地址列表（最多 50 个）
- `save_path`（可选）：同上

文件名为 `代码_简称_标题_公告ID.pdf`。目标文件已存在时不会重新下载；每个文件独立处理，失败的在 `failures` 里逐条列出。

## 提示词模板

- `company_research`：上市公司深度研究
- `earnings_review`：最新财报解读

## 结果完整性

涉及多次上游请求的结果都带 `complete` 字段。部分分页、部分数据集或部分文件失败时，已取得的内容照常返回，同时 `complete` 为 `false` 并附带 `warnings` / `errors`。

## 配置

全部通过环境变量设置，都可以省略：

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `CNINFO_MCP_DOWNLOAD_DIR` | 下载根目录，下载工具只能写入这个目录 | `~/Downloads/cninfo-mcp` |
| `CNINFO_MCP_CACHE_DIR` | 证券列表、已读取文档及其文本的缓存目录 | 系统缓存目录下的 `cninfo-mcp` |
| `CNINFO_MCP_CACHE_MAX_MB` | 文档缓存上限，超出后淘汰最久未使用的文件 | `1024` |
| `CNINFO_MCP_CONCURRENCY` | 同时向巨潮发起的请求数（1–8） | `4` |
| `CNINFO_MCP_TIMEOUT_MS` | 单次请求超时（毫秒） | `30000` |
| `CNINFO_MCP_DEBUG` | 设为 `1` 时在 stderr 打印上游请求、重试与限流 | 未设置 |

命令行：

```bash
npx -y @youhaozhao/cninfo-mcp            # 启动 MCP 服务器（stdio）
npx -y @youhaozhao/cninfo-mcp probe      # 联网自检：公告查询、财务数据、文档读取
npx -y @youhaozhao/cninfo-mcp selftest   # 离线自检：安装本身（PDF 文本提取）是否可用
```

## 数据范围与限制

- 公告检索：沪、深、北交所上市公司（含 B 股），以及港股公告；基金、债券可按代码检索公告。
- `list_reports`、`get_financials`、`get_company_data`：沪、深、北交所上市公司。
- 公告按标题关键字检索，不支持跨公告的全文检索；读取单个文档时可以在文档内按关键字定位。
- 扫描件（部分早期公告）没有文本层，无法读出正文。
- 不提供实时行情和 K 线。
