# cninfo-mcp

[![npm version](https://img.shields.io/npm/v/@youhaozhao/cninfo-mcp)](https://www.npmjs.com/package/@youhaozhao/cninfo-mcp)

通过 MCP 协议查询和下载巨潮资讯网上市公司定期报告及招股书 PDF 的工具，适用于 Claude Desktop / Claude Code。

> 本项目是社区维护的开源实现，**不是巨潮资讯网的官方产品**，详见[免责声明与数据使用](#免责声明与数据使用)。

## 并发限制
巨潮资讯网后端禁止大量并发，推荐将并发数设置为 4 以防止后端返回大量 403 导致 IP 短暂被封

## 使用方法

### 1. 安装 Python 依赖（只需一次）

```bash
npx -y @youhaozhao/cninfo-mcp install
```

这条命令会在 `~/.cninfo-mcp/venv` 创建 Python 虚拟环境，并用 pip 从 PyPI 安装 [`python/requirements.txt`](python/requirements.txt) 里的依赖。`npm install` 和服务器启动都不会创建环境或执行 pip；环境缺失或依赖过期时，服务器会直接报错并提示重新运行这条命令。

### 2. 添加到 MCP 客户端

在 Claude Desktop / Claude Code 配置文件中添加：

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cninfo": {
      "command": "npx",
      "args": ["-y", "@youhaozhao/cninfo-mcp"],
      "env": {
        "CNINFO_MCP_DOWNLOAD_DIR": "/Users/me/reports"
      }
    }
  }
}
```

`env` 可以省略。`CNINFO_MCP_DOWNLOAD_DIR` 是下载根目录，不设置时为 `~/Downloads/cninfo-mcp`。

重启 Claude Desktop 后即可使用。

## 可用工具

- **`query_annual_reports_tool`** — 查询报告列表，参数：股票代码（必填）、年份（可选）、报告类型（可选，默认 `annual`）
- **`download_annual_reports_tool`** — 下载报告 PDF，参数：股票代码（必填）、年份（可选）、保存路径（可选）、报告类型（可选，默认 `annual`）

保存路径只能是下载根目录内的位置：相对路径（如 `annual/2024`）按根目录下的子目录解析，落在根目录之外的路径（包括 `..` 和指向外部的符号链接）会被拒绝，不会写入任何文件。

两个工具都声明了 MCP 工具注解：

| 工具 | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `query_annual_reports_tool` | `true` | `false` | `true` | `true` |
| `download_annual_reports_tool` | `false` | `false` | `true` | `true` |

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
- Python 3.10+（需要 MCP Python SDK v2；依赖通过上面的 `install` 命令安装，升级后如提示依赖过期，重新运行一次即可）

## 安全边界

- **网络**：只访问 `https://www.cninfo.com.cn`（查询）和 `https://static.cninfo.com.cn`（PDF 下载），全程 HTTPS。
- **文件**：只有下载工具会写盘，并且只写入下载根目录（`CNINFO_MCP_DOWNLOAD_DIR`，默认 `~/Downloads/cninfo-mcp`）。根目录由部署方在客户端配置里指定，工具调用方无法更改。
- **写入确认**：服务器自身不弹确认框。下载工具声明了 `readOnlyHint: false`，是否在调用前向用户确认由 MCP 客户端决定。
- **安装**：创建虚拟环境和 pip 安装只发生在显式的 `install` 命令里，位置固定为 `~/.cninfo-mcp/venv`。
- **凭据**：不需要、也不读取任何账号、Cookie 或密钥。

## 数据来源

[巨潮资讯网](https://www.cninfo.com.cn) — 支持沪深两市（主板、创业板、科创板）及北京证券交易所（北交所）

## 免责声明与数据使用

- **非官方**：本项目是社区维护的开源工具，不是巨潮资讯网的官方产品，与其运营方深圳证券信息有限公司没有隶属、合作或授权关系。
- **非官方接口**：工具调用的是巨潮资讯网网页自身使用的查询接口，不是官方数据服务接口，可能随时变更、限流或停用。
- **内容权利**：本项目不托管、不转发任何报告内容，所有数据都由你的机器直接从巨潮资讯网获取。网站页脚标注“深圳证券信息有限公司 版权所有”，报告文件由各上市公司披露；下载后的使用方式（尤其是再分发和商业用途）请自行确认是否合规。
- **上游声明**：巨潮资讯网在[首页](https://www.cninfo.com.cn)页脚公布了免责声明，写明网站“竭力保证所提供的证券市场信息准确可靠，但并不担保（无论提示、默示、法定或其他形式）其准确性和完整性”，并且进入网站即视为接受该声明。通过本工具访问同样受其约束，请以网站公布的最新内容为准。
- **合理使用**：请遵守上面的[并发限制](#并发限制)，不要用本工具做高频或大批量抓取。
- **不构成投资建议**：工具只负责检索和下载公开披露文件，不对内容的准确性、完整性和时效性作任何保证。

## 从 1.4.x 及更早版本升级

- 启动器不再自动创建虚拟环境或安装依赖。已有的 `~/.cninfo-mcp/venv` 满足依赖时无需操作，否则先运行一次 `npx -y @youhaozhao/cninfo-mcp install`。
- 下载位置改为受限的下载根目录，默认从包目录下的 `pdf/` 变为 `~/Downloads/cninfo-mcp`。以前传给保存路径的任意绝对路径会被拒绝，需要改用 `CNINFO_MCP_DOWNLOAD_DIR` 指定根目录。
- 查询接口改为通过 HTTPS 访问。

## Credits

爬虫逻辑基于 [gaodechen/cninfo_process](https://github.com/gaodechen/cninfo_process)。

## 开发测试

在独立环境中安装运行依赖和 pytest 后执行全部 Python 与 Node 回归测试：

```bash
python3 -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
python -m pip install -r python/requirements.txt pytest
npm test
```

也可使用 uv 临时环境：

```bash
uv run --no-project --with pytest --with requests --with 'mcp~=2.1.1' npm test
```
