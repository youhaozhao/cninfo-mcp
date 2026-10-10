# 升级指南

## 从 1.4.x 及更早版本升级到 2.0

- 启动器不再自动创建虚拟环境或安装依赖。已有的 `~/.cninfo-mcp/venv` 满足依赖时无需操作，否则先运行一次 `npx -y @youhaozhao/cninfo-mcp install`。
- 下载位置改为受限的下载根目录，默认从包目录下的 `pdf/` 变为 `~/Downloads/cninfo-mcp`。以前传给保存路径的任意绝对路径会被拒绝，需要改用 `CNINFO_MCP_DOWNLOAD_DIR` 指定根目录。
- 查询接口改为通过 HTTPS 访问。
