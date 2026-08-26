# cninfo-mcp

[![npm version](https://img.shields.io/npm/v/@youhaozhao/cninfo-mcp)](https://www.npmjs.com/package/@youhaozhao/cninfo-mcp)

通过 MCP 协议查询和下载巨潮资讯网上市公司定期报告及招股书 PDF 的工具，适用于 Claude Desktop / Claude Code。

## 并发限制
巨潮资讯网后端禁止大量并发，推荐将并发数设置为 4 以防止后端返回大量 403 导致 IP 短暂被封

## 使用方法

在 Claude Desktop / Claude Code 配置文件中添加：

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

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

重启 Claude Desktop 后即可使用。

## 可用工具

- **`query_annual_reports_tool`** — 查询报告列表，参数：股票代码（必填）、年份（可选）、报告类型（可选，默认 `annual`）
- **`download_annual_reports_tool`** — 下载报告 PDF，参数：股票代码（必填）、年份（可选）、保存路径（可选）、报告类型（可选，默认 `annual`）

支持的 `report_type`：

- `annual` — 年度报告 / 年报
- `semiannual` — 半年度报告 / 半年报 / 中报
- `q1` — 第一季度报告 / 一季报
- `q3` — 第三季度报告 / 三季报
- `prospectus` — 招股书 / 招股说明书 / 招股意向书（招股书无固定年份，省略年份参数即可）

示例对话：

```
查询 000888 的 2024 年报
查询 000001 的 2024 半年报
查询 600519 的 2024 一季报
下载 300750 的 2023 三季报
下载 688777 的年报
查询 920185 的年报      # 北交所，新旧代码（如 835185）均可
查询 688777 的招股书
```

## 系统要求

- Node.js 18+
- Python 3.10+（Python 依赖会自动安装；需要 MCP Python SDK v2，旧环境会在下次启动时自动升级）

## 数据来源

[巨潮资讯网](https://www.cninfo.com.cn) — 支持沪深两市（主板、创业板、科创板）及北京证券交易所（北交所）

## Credits

爬虫逻辑基于 [gaodechen/cninfo_process](https://github.com/gaodechen/cninfo_process)。
