# 开发与测试

需要 Node.js 22.18+（开发时用 Node 自带的类型擦除直接运行 `.ts`）。

```bash
npm install
npm test            # 离线单元测试（假 fetch，不联网）
npm run typecheck
npm run test:live   # 真实访问巨潮的端到端冒烟测试
npm run dev         # 直接从 TypeScript 源码启动服务器
npm run build       # 打包到 dist/
```

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/http.ts` | 主机白名单、限速、超时与重试 |
| `src/securities.ts` | 证券目录：代码 / 简称 → orgId |
| `src/announcements.ts` | 公告查询与翻页 |
| `src/reports.ts` | 报告标题分类 |
| `src/companyData.ts` | 财务与公司结构化数据 |
| `src/documents.ts` | 文档抓取、PDF 文本提取、下载 |
| `src/paths.ts` | 下载目录边界 |
| `src/server.ts` | MCP 工具与提示词 |
| `src/cli.ts` | 命令行入口（`probe`、`selftest`） |

## 构建与发布

`npm run build` 运行 `scripts/build.mjs`，用 esbuild 把源码和全部依赖打成自包含的 `dist/`：

- 依赖都在 `devDependencies` 里，发布包不声明运行时依赖。
- pdf.js 单独成块，首次读取 PDF 时才加载；它需要的 `cmaps` 和 `standard_fonts` 复制到 `dist/pdfjs/`。
- 被打包的第三方软件及其许可证写入 `dist/THIRD-PARTY-LICENSES.txt`。

`npm pack` / `npm publish` 会通过 `prepack` 自动构建。发布前可以在一个空目录里安装 tarball 并运行 `cninfo-mcp selftest`（离线）和 `cninfo-mcp probe`（联网）确认产物可用；CI 会在 Linux、Windows、macOS 上做前一项检查。
