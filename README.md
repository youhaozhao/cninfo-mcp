# cninfo-mcp - 让 AI 直接查公告、读财报、取财务数据

[![npm version](https://img.shields.io/npm/v/@youhaozhao/cninfo-mcp)](https://www.npmjs.com/package/@youhaozhao/cninfo-mcp) [![CI](https://github.com/youhaozhao/cninfo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/youhaozhao/cninfo-mcp/actions/workflows/ci.yml) [![MIT licensed](https://img.shields.io/npm/l/@youhaozhao/cninfo-mcp)](./LICENSE)

一个面向 A 股投研的 MCP Server，让 Claude 等 AI 助手在[巨潮资讯网](https://www.cninfo.com.cn)上检索公告、阅读年报和招股书正文、获取财务与股东数据，并在需要时下载 PDF。覆盖沪深两市（主板、创业板、科创板）和北交所，港股公告也可检索。

> 本项目是社区维护的开源实现，**不是巨潮资讯网的官方产品**，不构成投资建议，详见[免责声明](#免责声明)。

装好之后，直接用自然语言提问：

```txt
贵州茅台 2025 年年报里，管理层怎么看明年的行业趋势？
```

```txt
对比宁德时代近五年的收入、净利润、经营现金流和 ROE
```

```txt
过去一个月创业板有哪些公司发布了业绩预告？
```

```txt
下载 688981 的招股书
```

## 安装

只需要 Node.js 22.13+，不需要 Python，也没有其他要另外安装的依赖。

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add cninfo -- npx -y @youhaozhao/cninfo-mcp
```

</details>

<details>
<summary><b>Claude Desktop 及其他客户端</b></summary>

在配置文件中添加以下内容，然后重启客户端。Claude Desktop 的配置文件位于：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

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

</details>

想先确认本机能连上巨潮，可以运行自检：

```bash
npx -y @youhaozhao/cninfo-mcp probe
```

### 配置

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `CNINFO_MCP_DOWNLOAD_DIR` | 下载根目录，所有下载的文件只会写到这个目录里 | `~/Downloads/cninfo-mcp` |
| `CNINFO_MCP_CACHE_DIR` | 证券列表、已读取文档及其文本的缓存目录 | 系统缓存目录下的 `cninfo-mcp` |
| `CNINFO_MCP_CACHE_MAX_MB` | 文档缓存上限，超出后淘汰最久未使用的文件 | `1024` |
| `CNINFO_MCP_CONCURRENCY` | 同时向巨潮发起的请求数（1–8） | `4` |

其余选项见[工具与配置参考](docs/tools.md#配置)。

## 使用提示

### 代码和简称都可以

所有 `stock` 参数都接受 `600519`、`000001.SZ`、`00700.HK` 这样的代码，也接受 `贵州茅台` 这样的简称。北交所股票的新旧代码都可以用，例如 `920185` 和 `835185` 指向同一家公司。

### 读报告不需要下载

`read_document` 直接读取 PDF 正文。年报动辄上百页，先用 `query` 按关键字定位（如“主营业务分析”），再用 `pages` 读对应的页，比从头读到尾快得多。

### 省略年份

不写年份会返回或下载全部年份的报告。招股书没有固定年份，查询时省略年份即可。

### 并发由服务器控制

巨潮资讯网会对大量并发请求返回 403，并短暂封禁 IP。服务器对所有上游请求统一限速（默认同时 4 个）并在被限流时自动冷却重试，不建议调高 `CNINFO_MCP_CONCURRENCY`。

## 可用工具

- `search_securities`：按代码、简称或拼音首字母查找证券。
- `list_reports`：列出年报、半年报、季报或招股书，返回标题、披露日期和 PDF 地址。
- `search_announcements`：按公司、标题关键字、分类、日期、板块检索公告；不指定公司即全市场检索，也可查调研记录。
- `read_document`：阅读公告或报告正文，支持目录概览、关键字定位、按页读取。
- `get_financials`：主要指标、利润表、资产负债表、现金流量表（最近五期）。
- `get_company_data`：公司概况、十大股东、股东人数、分红、质押、解禁、融资融券、大宗交易、龙虎榜等。
- `download_reports`：把定期报告或招股书的 PDF 保存到下载目录。
- `download_documents`：按 URL 把指定公告保存到下载目录。

参数、公告分类、数据集和报告类型的完整说明见[工具与配置参考](docs/tools.md)。

## 更多文档

- [工具与配置参考](docs/tools.md) - 每个工具的参数、公告分类、数据集、数据范围与限制
- [性能与稳定性](docs/reliability.md) - 查询方式、限速与重试、缓存、结果完整性
- [安全边界](docs/security.md) - 网络访问范围、文件写入限制和 MCP 工具注解
- [升级指南](docs/upgrading.md) - 从 2.x 及更早版本升级到 3.0
- [开发与测试](docs/development.md) - 在本地运行测试、构建和自检

## 免责声明

- **非官方**：本项目是社区维护的开源工具，不是巨潮资讯网的官方产品，与其运营方深圳证券信息有限公司没有隶属、合作或授权关系。
- **非官方接口**：工具调用的是巨潮资讯网网页自身使用的查询接口，不是官方数据服务接口，可能随时变更、限流或停用。
- **内容权利**：本项目不托管、不转发任何报告内容，所有数据都由你的机器直接从巨潮资讯网获取。网站页脚标注“深圳证券信息有限公司 版权所有”，报告文件由各上市公司披露；下载后的使用方式（尤其是再分发和商业用途）请自行确认是否合规。
- **上游声明**：巨潮资讯网在[首页](https://www.cninfo.com.cn)页脚公布了免责声明，写明网站“竭力保证所提供的证券市场信息准确可靠，但并不担保（无论提示、默示、法定或其他形式）其准确性和完整性”，并且进入网站即视为接受该声明。通过本工具访问同样受其约束，请以网站公布的最新内容为准。
- **合理使用**：请保持默认的[并发限制](#并发由服务器控制)，不要用本工具做高频或大批量抓取。
- **不构成投资建议**：工具只负责检索、读取和整理公开披露信息，不对内容的准确性、完整性和时效性作任何保证；结构化数据可能与报告原文存在口径差异，重要数字请以披露文件为准。

## Credits

最初的爬虫逻辑基于 [gaodechen/cninfo_process](https://github.com/gaodechen/cninfo_process)。PDF 文本提取使用 [pdf.js](https://github.com/mozilla/pdf.js)。

## License

[MIT](./LICENSE)
