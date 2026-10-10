# 安全边界

- **网络**：只访问 `https://www.cninfo.com.cn`（查询）和 `https://static.cninfo.com.cn`（PDF 下载），全程 HTTPS。
- **文件**：只有下载工具会写盘，并且只写入下载根目录（`CNINFO_MCP_DOWNLOAD_DIR`，默认 `~/Downloads/cninfo-mcp`）。根目录由部署方在客户端配置里指定，工具调用方无法更改。
- **写入确认**：服务器自身不弹确认框。下载工具声明了 `readOnlyHint: false`，是否在调用前向用户确认由 MCP 客户端决定。
- **安装**：创建虚拟环境和 pip 安装只发生在显式的 `install` 命令里，位置固定为 `~/.cninfo-mcp/venv`。`npm install` 和服务器启动都不会创建环境或执行 pip；环境缺失或依赖过期时，服务器会直接报错并提示重新运行 `install`。
- **凭据**：不需要、也不读取任何账号、Cookie 或密钥。

## 保存路径

`download_annual_reports_tool` 的 `save_path` 只能是下载根目录内的位置：相对路径（如 `annual/2024`）按根目录下的子目录解析，落在根目录之外的路径（包括 `..` 和指向外部的符号链接）会被拒绝，不会写入任何文件。

## MCP 工具注解

| 工具 | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `query_annual_reports_tool` | `true` | `false` | `true` | `true` |
| `download_annual_reports_tool` | `false` | `false` | `true` | `true` |

## 依赖

`install` 命令用 pip 从 PyPI 安装 [`python/requirements.txt`](../python/requirements.txt) 里的依赖。
