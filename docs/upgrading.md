# 升级指南

## 从 2.x 升级到 3.0

3.0 用 TypeScript 重写，是一次不兼容升级。

- **不再需要 Python**。`install` 命令和 `~/.cninfo-mcp/venv` 都已废弃，旧目录可以直接删除。最低 Node.js 版本从 18 提高到 22.13。
- **工具改名并扩充**：

  | 2.x | 3.0 |
  | --- | --- |
  | `query_annual_reports_tool` | `list_reports` |
  | `download_annual_reports_tool` | `download_reports` |

  参数 `stock_code` 改为 `stock`（代码或简称均可），返回结构也有变化；其余六个工具为新增，见[工具与配置参考](tools.md)。`annual-reports-list://` 资源已移除。
- **下载文件名**由 `代码_简称_标题_<SHA-256>.pdf` 改为 `代码_简称_标题_<公告ID>.pdf`；目标文件已存在时不再重新下载。
- **修订稿**：标题带“修订”“更正后”等括注的报告全文现在作为 `revised` 返回（此前被排除）。
- **并发**：服务器自己限速，不再需要调用方控制同时发起的调用数。

## 从 1.4.x 及更早版本升级到 2.0

- 启动器不再自动创建虚拟环境或安装依赖。已有的 `~/.cninfo-mcp/venv` 满足依赖时无需操作，否则先运行一次 `npx -y @youhaozhao/cninfo-mcp install`。
- 下载位置改为受限的下载根目录，默认从包目录下的 `pdf/` 变为 `~/Downloads/cninfo-mcp`。以前传给保存路径的任意绝对路径会被拒绝，需要改用 `CNINFO_MCP_DOWNLOAD_DIR` 指定根目录。
- 查询接口改为通过 HTTPS 访问。
