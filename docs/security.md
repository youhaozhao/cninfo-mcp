# 安全边界

- **网络**：只访问 `https://www.cninfo.com.cn`（查询与数据）和 `https://static.cninfo.com.cn`（文档），全程 HTTPS。重定向逐跳校验，不会被带到其他主机。
- **文件**：只有两个下载工具会写用户可见的文件，并且只写入下载根目录（`CNINFO_MCP_DOWNLOAD_DIR`，默认 `~/Downloads/cninfo-mcp`）。根目录由部署方在客户端配置里指定，工具调用方无法更改。除此之外，服务器只写自己的缓存目录（`CNINFO_MCP_CACHE_DIR`）。
- **写入确认**：服务器自身不弹确认框。下载工具声明了 `readOnlyHint: false`，是否在调用前向用户确认由 MCP 客户端决定。
- **安装**：`npm install` 阶段不运行任何脚本；服务器启动时不安装任何东西。
- **凭据**：不需要、也不读取任何账号、Cookie 或密钥。
- **文档内容**：公告和报告是上市公司披露的外部内容，助手应当把它们当作资料而不是指令。

## 文档地址

`read_document` 和 `download_documents` 只接受 `https://static.cninfo.com.cn` 上的地址（或其 `finalpage/...` 相对路径），其他主机、非 HTTPS、带账号信息或非默认端口的地址都会被拒绝。

## 保存路径

`download_reports` 和 `download_documents` 的 `save_path` 只能是下载根目录内的位置：相对路径（如 `annual/2024`）按根目录下的子目录解析，落在根目录之外的路径（包括 `..` 和指向外部的符号链接）会被拒绝，不会写入任何文件。

## MCP 工具注解

| 工具 | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `search_securities`、`list_reports`、`search_announcements`、`read_document`、`get_financials`、`get_company_data` | `true` | `false` | `true` | `true` |
| `download_reports`、`download_documents` | `false` | `false` | `true` | `true` |

## 依赖

发布包是自包含的：构建时用 esbuild 把源码和依赖（MCP SDK、zod、pdf.js 等）打进 `dist/`，安装时不会再拉取任何其他包。被打包的第三方软件及其许可证列在包内的 `dist/THIRD-PARTY-LICENSES.txt`。
