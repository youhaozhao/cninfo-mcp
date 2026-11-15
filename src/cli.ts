#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CACHE_DIR_ENV, DOWNLOAD_DIR_ENV, loadConfig } from "./config.ts";
import { runProbe } from "./probe.ts";
import { runSelfTest } from "./selftest.ts";
import { createServer, createServices, packageVersion } from "./server.ts";

const HELP = `cninfo-mcp ${packageVersion()} — MCP server for CNINFO (巨潮资讯网) disclosures

Usage:
  cninfo-mcp            Start the MCP server on stdio (what MCP clients run)
  cninfo-mcp probe      Check connectivity to CNINFO and exit (non-zero on failure)
  cninfo-mcp selftest   Check the installation offline (PDF text extraction) and exit
  cninfo-mcp --version  Print the version
  cninfo-mcp --help     Show this help

Environment:
  ${DOWNLOAD_DIR_ENV}   Directory downloads are confined to (default ~/Downloads/cninfo-mcp)
  ${CACHE_DIR_ENV}      Cache directory for security lists and fetched documents
  CNINFO_MCP_CACHE_MAX_MB   Document cache size limit in MB (default 1024)
  CNINFO_MCP_CONCURRENCY    Concurrent upstream requests, 1-8 (default 4)
  CNINFO_MCP_TIMEOUT_MS     Per-request timeout in ms (default 30000)
  CNINFO_MCP_DEBUG          Set to 1 to log upstream requests to stderr
`;

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "install") {
    // 2.x 及更早版本需要这条命令准备 Python 环境；3.x 是纯 Node 实现
    process.stdout.write(
      "Nothing to install: cninfo-mcp 3.x has no Python dependency. The old ~/.cninfo-mcp/venv directory can be deleted.\n",
    );
    return 0;
  }

  if (command === "selftest") {
    process.stdout.write(`${await runSelfTest()}\n`);
    return 0;
  }

  const debug = process.env.CNINFO_MCP_DEBUG === "1";
  const services = createServices(
    loadConfig(),
    debug
      ? {
          onEvent: (event) =>
            console.error(`[cninfo-mcp] ${event.type} ${event.url} ${event.detail ?? ""}`),
        }
      : {},
  );

  if (command === "probe") {
    const lines = await runProbe(services);
    for (const line of lines) {
      process.stdout.write(`[${line.ok ? "OK  " : "FAIL"}] ${line.name}: ${line.detail}\n`);
    }
    const failed = lines.filter((line) => !line.ok);
    process.stdout.write(
      failed.length === 0 ? "\n全部探测通过。\n" : `\n${failed.length} 项探测失败。\n`,
    );
    return failed.length === 0 ? 0 : 1;
  }
  if (command !== undefined) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }

  // stdout 是 MCP 协议通道：任何依赖库的 console.log 都必须改道到 stderr
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const server = createServer(services);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // 客户端退出（stdin 关闭）后立即结束，不留下孤儿进程
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  await server.connect(new StdioServerTransport());
  services.securities.prewarm();
  console.error(`cninfo-mcp ${packageVersion()} ready (stdio)`);
  return -1;
}

// 单个请求里漏掉的异常不应带走整个长驻进程
process.on("unhandledRejection", (reason) => {
  console.error("[cninfo-mcp] unhandled rejection:", reason);
});

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    console.error("[cninfo-mcp] fatal:", error);
    process.exitCode = 1;
  },
);
