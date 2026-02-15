# cninfo-mcp

通过 MCP 协议查询和下载巨潮资讯网上市公司年报的工具，适用于 Claude Desktop。

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

- **`query_annual_reports_tool`** — 查询年报列表，参数：股票代码（必填）、年份（可选）
- **`download_annual_reports_tool`** — 下载年报 PDF，参数：股票代码（必填）、年份（可选）

示例对话：

```
查询 000888 的 2024 年报
下载 688777 的年报
```

## 系统要求

- Node.js 18+
- Python 3.10+（Python 依赖会自动安装）

## 数据来源

[巨潮资讯网](https://www.cninfo.com.cn) — 支持沪深两市及科创板

## Credits

爬虫逻辑基于 [gaodechen/cninfo_process](https://github.com/gaodechen/cninfo_process)。
