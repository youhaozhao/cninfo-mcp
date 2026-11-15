import os from "node:os";
import path from "node:path";

export const DOWNLOAD_DIR_ENV = "CNINFO_MCP_DOWNLOAD_DIR";
export const CACHE_DIR_ENV = "CNINFO_MCP_CACHE_DIR";

export interface Config {
  /** 下载根目录：所有用户可见的写盘都限制在这里。 */
  downloadDir: string;
  /** 缓存目录：证券列表、已抓取文档及其文本层。 */
  cacheDir: string;
  /** 文档缓存上限（字节），超出后按最久未使用淘汰。 */
  cacheMaxBytes: number;
  /** 同时在途的上游请求数。巨潮对高并发会返回 403，默认 4。 */
  concurrency: number;
  /** 相邻两次请求发起的最小间隔（毫秒）。 */
  minIntervalMs: number;
  /** 单次请求（含读取响应体）的超时。 */
  timeoutMs: number;
  /** 瞬时失败的最大尝试次数（含首次）。 */
  maxAttempts: number;
  userAgent: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function intFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "cninfo-mcp", "cache");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "cninfo-mcp");
  }
  const xdg = env.XDG_CACHE_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache"), "cninfo-mcp");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const download = env[DOWNLOAD_DIR_ENV]?.trim();
  const cache = env[CACHE_DIR_ENV]?.trim();
  return {
    downloadDir: path.resolve(
      expandHome(download || path.join("~", "Downloads", "cninfo-mcp")),
    ),
    cacheDir: path.resolve(cache ? expandHome(cache) : defaultCacheDir(env)),
    cacheMaxBytes: intFromEnv(env, "CNINFO_MCP_CACHE_MAX_MB", 1024, 16, 102400) * 1024 * 1024,
    concurrency: intFromEnv(env, "CNINFO_MCP_CONCURRENCY", 4, 1, 8),
    minIntervalMs: intFromEnv(env, "CNINFO_MCP_MIN_INTERVAL_MS", 120, 0, 5000),
    timeoutMs: intFromEnv(env, "CNINFO_MCP_TIMEOUT_MS", 30000, 1000, 300000),
    maxAttempts: intFromEnv(env, "CNINFO_MCP_MAX_ATTEMPTS", 4, 1, 8),
    userAgent: env.CNINFO_MCP_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  };
}
