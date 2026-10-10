# cninfo-mcp - 让 AI 直接查询和下载 A 股定期报告

[![npm version](https://img.shields.io/npm/v/@youhaozhao/cninfo-mcp)](https://www.npmjs.com/package/@youhaozhao/cninfo-mcp) [![MIT licensed](https://img.shields.io/npm/l/@youhaozhao/cninfo-mcp)](./LICENSE)

一个 MCP Server，让 Claude 等 AI 助手从[巨潮资讯网](https://www.cninfo.com.cn)查询并下载上市公司的年报、半年报、季报和招股书 PDF。覆盖沪深两市（主板、创业板、科创板）和北交所。

> 本项目是社区维护的开源实现，**不是巨潮资讯网的官方产品**，详见[免责声明](#免责声明)。

装好之后，直接用自然语言提问：

```txt
查询 000888 的 2024 年报
```

```txt
下载 300750 的 2023 三季报
```

```txt
查询 688777 的招股书
```

## 安装

需要 Node.js 18+ 和 Python 3.10+。

**1. 安装 Python 依赖（只需一次）**

```bash
npx -y @youhaozhao/cninfo-mcp install
```

依赖装在独立的虚拟环境 `~/.cninfo-mcp/venv` 里，不会动你的系统 Python。升级后如果提示依赖过期，重新运行一次即可。

**2. 添加到 MCP 客户端**

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

### 配置

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `CNINFO_MCP_DOWNLOAD_DIR` | 下载根目录，所有 PDF 只会写到这个目录里 | `~/Downloads/cninfo-mcp` |

## 使用提示

### 控制并发

巨潮资讯网会对大量并发请求返回 403，并短暂封禁 IP。批量查询或下载时，建议把同时发起的调用控制在 4 个以内。

### 省略年份

不写年份会返回或下载全部年份的报告。招股书没有固定年份，查询时省略年份即可。

### 北交所代码

北交所股票的新旧代码都可以用，例如 `920185` 和 `835185` 指向同一家公司。

## 可用工具

- `query_annual_reports_tool`：查询报告列表，返回标题、披露时间和 PDF 地址。
  - `stock_code`（必填）：股票代码，如 `000888`
  - `year`（可选）：报告年份，如 `2024`
  - `report_type`（可选）：报告类型，默认 `annual`
- `download_annual_reports_tool`：下载报告 PDF 到本地。
  - `stock_code`（必填）：股票代码
  - `year`（可选）：报告年份
  - `report_type`（可选）：报告类型，默认 `annual`
  - `save_path`（可选）：下载根目录下的子目录，如 `annual/2024`；根目录之外的路径会被拒绝

`report_type` 的取值：

| 取值 | 报告 |
| --- | --- |
| `annual` | 年度报告 |
| `semiannual` | 半年度报告（中报） |
| `q1` | 第一季度报告 |
| `q3` | 第三季度报告 |
| `prospectus` | 招股说明书 / 招股意向书 |

## 更多文档

- [安全边界](docs/security.md) - 网络访问范围、文件写入限制和 MCP 工具注解
- [升级指南](docs/upgrading.md) - 从 1.4.x 及更早版本升级到 2.0
- [开发与测试](docs/development.md) - 在本地运行测试

## 免责声明

- **非官方**：本项目是社区维护的开源工具，不是巨潮资讯网的官方产品，与其运营方深圳证券信息有限公司没有隶属、合作或授权关系。
- **非官方接口**：工具调用的是巨潮资讯网网页自身使用的查询接口，不是官方数据服务接口，可能随时变更、限流或停用。
- **内容权利**：本项目不托管、不转发任何报告内容，所有数据都由你的机器直接从巨潮资讯网获取。网站页脚标注“深圳证券信息有限公司 版权所有”，报告文件由各上市公司披露；下载后的使用方式（尤其是再分发和商业用途）请自行确认是否合规。
- **上游声明**：巨潮资讯网在[首页](https://www.cninfo.com.cn)页脚公布了免责声明，写明网站“竭力保证所提供的证券市场信息准确可靠，但并不担保（无论提示、默示、法定或其他形式）其准确性和完整性”，并且进入网站即视为接受该声明。通过本工具访问同样受其约束，请以网站公布的最新内容为准。
- **合理使用**：请遵守上面的[并发建议](#控制并发)，不要用本工具做高频或大批量抓取。
- **不构成投资建议**：工具只负责检索和下载公开披露文件，不对内容的准确性、完整性和时效性作任何保证。

## Credits

爬虫逻辑基于 [gaodechen/cninfo_process](https://github.com/gaodechen/cninfo_process)。

## License

[MIT](./LICENSE)
