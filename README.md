# cninfo-mcp

[![npm version](https://img.shields.io/npm/v/@youhaozhao/cninfo-mcp)](https://www.npmjs.com/package/@youhaozhao/cninfo-mcp)
[![CI](https://github.com/youhaozhao/cninfo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/youhaozhao/cninfo-mcp/actions/workflows/ci.yml)

面向 A 股投研的 MCP 服务器：让 Claude 等 AI 助手直接在[巨潮资讯网](https://www.cninfo.com.cn)上**查公告、读财报、取财务与股东数据**。

- **查**：按公司、分类、关键字、日期检索公告，覆盖沪、深、北交所，港股公告也可检索
- **读**：不用下载，直接阅读年报、招股书等 PDF 的正文，支持按关键字定位章节、按页读取
- **数**：结构化的财务报表、主要指标、十大股东、分红、质押、解禁、大宗交易、龙虎榜等
- **存**：需要留档时把 PDF 下载到受限的本地目录

> 本项目是社区维护的开源实现，**不是巨潮资讯网的官方产品**，不构成投资建议，详见[免责声明与数据使用](#免责声明与数据使用)。

## 快速开始

只需要 Node.js 22.13 或更高版本。发布包是自包含的（约 7 MB），没有任何需要另外安装的依赖。在 MCP 客户端的配置里加入：

```json
{
  "mcpServers": {
    "cninfo": {
      "command": "npx",
      "args": ["-y", "@youhaozhao/cninfo-mcp"]
    }
  }
}
```

- **Claude Desktop**：配置文件在 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows），修改后重启应用。
- **Claude Code**：`claude mcp add cninfo -- npx -y @youhaozhao/cninfo-mcp`

想先确认本机能连上巨潮，可以运行自检（逐项探测公告查询、财务数据、文档读取）：

```bash
npx -y @youhaozhao/cninfo-mcp probe
```

`selftest` 子命令则不联网，只检查安装本身（PDF 文本提取）是否可用。

## 可以这样问

```
贵州茅台 2025 年年报里，管理层怎么看明年的行业趋势？
对比宁德时代近五年的收入、净利润、经营现金流和 ROE
比亚迪最近有哪些股权质押和大宗交易？十大股东有什么变化？
过去一个月创业板有哪些公司发布了业绩预告？
平安银行最近三次分红方案是什么？
帮我把中芯国际的招股说明书下载下来
查一下 920185 最新的三季报，净利润同比变化多少
腾讯控股（00700.HK）最近发了哪些公告？
```

## 工具

所有 `stock` 参数都接受代码或简称：`600519`、`000001.SZ`、`sh600519`、`920185`（北交所新旧代码均可）、`00700.HK`、`贵州茅台`。

| 工具 | 作用 |
| --- | --- |
| `search_securities` | 按代码、简称或拼音首字母（如 `gzmt`）查找证券 |
| `list_reports` | 列出定期报告或招股书：`annual` 年报、`semiannual` 半年报、`q1` 一季报、`q3` 三季报、`prospectus` 招股书 |
| `search_announcements` | 检索公告：可按公司（一次最多 10 家）、标题关键字、分类、日期、板块筛选；不指定公司即全市场检索；`source=investor_relations` 查调研记录 |
| `read_document` | 阅读公告或报告正文（PDF，早期公告为 HTML）：概览与目录、关键字定位、按页读取 |
| `get_financials` | 主要指标、利润表、资产负债表、现金流量表（最近五期，年报 / 半年报 / 一季报 / 三季报口径） |
| `get_company_data` | 公司概况、高管、分红、股本结构、股东人数、十大股东、十大流通股东、基金持股、解禁、质押、融资融券、大宗交易、股东增减持、董监高持股变动、龙虎榜；一次调用可取多个数据集 |
| `download_reports` | 把定期报告或招股书的 PDF 保存到下载目录 |
| `download_documents` | 按 URL 把指定公告保存到下载目录 |

另外提供两个提示词模板：`company_research`（上市公司深度研究）和 `earnings_review`（最新财报解读）。

**报告筛选规则**：`list_reports` 默认只返回报告正文（`kind` 为 `main`，或 `revised`——更新后 / 修订后的全文）。摘要、英文版、两地上市公司的 H 股版本等变体需要设置 `include_variants`；“关于年报的更正公告”这类并非报告本身的公告始终不会混入。

**公告分类**（`search_announcements` 的 `categories`，中英文名均可）：年报、半年报、一季报、三季报、业绩预告、权益分派、董事会、监事会、股东会、日常经营、公司治理、中介报告、首发、增发、股权激励、配股、解禁、公司债、可转债、其他融资、股权变动、补充更正、澄清致歉、风险提示、特别处理和退市、退市整理期。

**翻页**：`search_announcements` 返回命中总数 `total`；还有更多结果时带 `next_offset`，把它作为下一次调用的 `offset` 即可。

**结果完整性**：涉及多次上游请求的结果都带 `complete` 字段。部分分页或部分数据集失败时，已取得的内容照常返回，同时 `complete` 为 `false` 并附带 `warnings` / `errors`，不会把残缺结果当作完整结果。

工具注解：

| 工具 | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| 六个查询 / 阅读工具 | `true` | `false` | `true` | `true` |
| `download_reports`、`download_documents` | `false` | `false` | `true` | `true` |

## 配置

全部通过环境变量设置，都可以省略：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CNINFO_MCP_DOWNLOAD_DIR` | `~/Downloads/cninfo-mcp` | 下载根目录，下载工具只能写入这个目录 |
| `CNINFO_MCP_CACHE_DIR` | 系统缓存目录下的 `cninfo-mcp` | 证券列表、已读取文档及其文本的缓存 |
| `CNINFO_MCP_CACHE_MAX_MB` | `1024` | 文档缓存上限，超出后淘汰最久未使用的文件 |
| `CNINFO_MCP_CONCURRENCY` | `4` | 同时向巨潮发起的请求数（1–8） |
| `CNINFO_MCP_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `CNINFO_MCP_DEBUG` | 未设置 | 设为 `1` 时在 stderr 打印上游请求、重试与限流 |

```json
{
  "mcpServers": {
    "cninfo": {
      "command": "npx",
      "args": ["-y", "@youhaozhao/cninfo-mcp"],
      "env": { "CNINFO_MCP_DOWNLOAD_DIR": "/Users/me/reports" }
    }
  }
}
```

## 性能与稳定性

- **按 orgId 精确查询**：先用本地缓存的证券目录把代码解析成巨潮的 orgId，一条请求链即可查到一家公司在沪、深、北任一市场的公告，不再逐个交易所扫描后再过滤。
- **并发翻页**：第一页返回总数后，其余分页并发抓取。
- **全局限速**：所有上游请求共用一个并发上限（默认 4）和最小发起间隔。巨潮对高并发会返回 403；遇到 403 / 429 时全局冷却后再重试，而不是继续撞限流。
- **自动重试**：超时、网络错误、5xx、空响应、数据接口的内部失败（HTTP 200 但 `resultMsg=fail`）都按指数退避加抖动重试；404 等确定性错误立即返回。
- **多级缓存**：证券目录缓存在内存和磁盘（12 小时，上游不可用时退回旧副本）；查询结果短时缓存并合并同时发起的相同请求；读过的文档及其逐页文本落盘缓存，再次读取或下载不需要重新抓取和解析。
- **不写坏文件**：下载和缓存都是先写临时文件再原子改名；限流时返回的 HTML 错误页不会被当作 PDF 保存。
- **故障隔离**：单个文件下载失败、单个数据集失败、单页 PDF 解析失败都不会拖垮整次调用。

并发上限不建议调高：短时间内大量请求会让巨潮返回 403 并暂时封禁 IP。

## 安全边界

- **网络**：只访问 `https://www.cninfo.com.cn`（查询与数据）和 `https://static.cninfo.com.cn`（文档），全程 HTTPS。重定向逐跳校验，不会被带到其他主机；`read_document` 和 `download_documents` 也只接受 `static.cninfo.com.cn` 上的地址。
- **文件**：只有两个下载工具会在下载根目录内写文件；`save_path` 只能是根目录内的位置，`..` 和指向外部的符号链接都会被拒绝。根目录由部署方在客户端配置里指定，工具调用方无法更改。除此之外，服务器只写自己的缓存目录。
- **写入确认**：服务器自身不弹确认框。下载工具声明了 `readOnlyHint: false`，是否在调用前向用户确认由 MCP 客户端决定。
- **安装**：`npm install` 阶段不运行任何脚本。
- **凭据**：不需要、也不读取任何账号、Cookie 或密钥。
- **文档内容**：公告和报告是上市公司披露的外部内容，助手应当把它们当作资料而不是指令。

## 数据范围与限制

- 公告检索：沪、深、北交所上市公司（含 B 股），以及港股公告；基金、债券可按代码检索公告。
- `list_reports`、`get_financials`、`get_company_data`：沪、深、北交所上市公司。
- 财务报表是巨潮个股页的精简口径（主要科目，最近五期，金额单位万元）；需要完整科目请用 `read_document` 读报告原文。
- 公告按标题关键字检索，不支持全文检索；读取单个文档时可以在文档内按关键字定位。
- 扫描件（部分早期公告）没有文本层，无法读出正文。
- 不提供实时行情和 K 线。

## 从 2.x 及更早版本升级

3.0 用 TypeScript 重写，是一次不兼容升级：

- **不再需要 Python**。`install` 命令和 `~/.cninfo-mcp/venv` 都已废弃，旧目录可以直接删除。最低 Node.js 版本从 18 提高到 22.13。
- **工具改名并扩充**：`query_annual_reports_tool` → `list_reports`，`download_annual_reports_tool` → `download_reports`，参数名（`stock_code` → `stock`）和返回结构都有变化；其余工具为新增。`annual-reports-list://` 资源已移除。
- **下载文件名**由 `代码_简称_标题_<SHA-256>.pdf` 改为 `代码_简称_标题_<公告ID>.pdf`；目标文件已存在时不再重新下载。
- **修订稿**：标题带“修订”“更正后”等括注的报告全文现在作为 `revised` 返回（此前被排除）。

## 免责声明与数据使用

- **非官方**：本项目是社区维护的开源工具，不是巨潮资讯网的官方产品，与其运营方深圳证券信息有限公司没有隶属、合作或授权关系。
- **非官方接口**：工具调用的是巨潮资讯网网页自身使用的查询接口，不是官方数据服务接口，可能随时变更、限流或停用。
- **内容权利**：本项目不托管、不转发任何报告内容，所有数据都由你的机器直接从巨潮资讯网获取。网站页脚标注“深圳证券信息有限公司 版权所有”，报告文件由各上市公司披露；下载后的使用方式（尤其是再分发和商业用途）请自行确认是否合规。
- **上游声明**：巨潮资讯网在[首页](https://www.cninfo.com.cn)页脚公布了免责声明，写明网站“竭力保证所提供的证券市场信息准确可靠，但并不担保（无论提示、默示、法定或其他形式）其准确性和完整性”，并且进入网站即视为接受该声明。通过本工具访问同样受其约束，请以网站公布的最新内容为准。
- **合理使用**：请保持默认的并发限制，不要用本工具做高频或大批量抓取。
- **不构成投资建议**：工具只负责检索、读取和整理公开披露信息，不对内容的准确性、完整性和时效性作任何保证；结构化数据可能与报告原文存在口径差异，重要数字请以披露文件为准。

## 开发

```bash
npm install
npm test            # 离线单元测试（假 fetch，不联网）
npm run typecheck
npm run test:live   # 真实访问巨潮的端到端冒烟测试
npm run dev         # 直接从 TypeScript 源码启动服务器
npm run build       # 打包到 dist/（esbuild，自包含）
```

源码在 `src/`：`http.ts`（白名单、限速、重试）、`securities.ts`（证券目录）、`announcements.ts`（公告查询）、`reports.ts`（报告标题分类）、`companyData.ts`（结构化数据）、`documents.ts`（文档抓取、PDF 文本、下载）、`server.ts`（MCP 工具）、`cli.ts`（入口）。开发时用 Node 自带的类型擦除直接运行 `.ts`（需要 Node 22.18+）。发布包由 `scripts/build.mjs` 用 esbuild 把源码和全部依赖打成自包含的 `dist/`，pdf.js 单独成块、首次读取 PDF 时才加载；被打包的第三方软件及其许可证列在 `dist/THIRD-PARTY-LICENSES.txt`。

仓库的定时工作流每天运行一次 `cninfo-mcp probe`，接口异常时自动开 issue。

## Credits

最初的爬虫逻辑基于 [gaodechen/cninfo_process](https://github.com/gaodechen/cninfo_process)。PDF 文本提取使用 [pdf.js](https://github.com/mozilla/pdf.js)。

## License

[MIT](LICENSE)
