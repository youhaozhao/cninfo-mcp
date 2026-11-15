import { CninfoError } from "./errors.ts";

/** 服务器会访问的全部主机。重定向也只允许落在这个集合内。 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "www.cninfo.com.cn",
  "static.cninfo.com.cn",
]);

export const API_ORIGIN = "https://www.cninfo.com.cn";
export const STATIC_ORIGIN = "https://static.cninfo.com.cn";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  concurrency: number;
  minIntervalMs: number;
  timeoutMs: number;
  maxAttempts: number;
  userAgent: string;
  /** 重试退避基数（毫秒），第 n 次重试等待 base * 2^(n-1) 再加抖动。 */
  backoffMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onEvent?: (event: HttpEvent) => void;
}

export interface HttpEvent {
  type: "request" | "retry" | "throttle";
  url: string;
  attempt: number;
  detail?: string;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  /** application/x-www-form-urlencoded 请求体。 */
  form?: Record<string, string | number>;
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/** 校验 URL 只指向允许的 HTTPS 主机，返回规范化后的 URL。 */
export function assertAllowedUrl(value: string | URL, base?: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new CninfoError("FORBIDDEN_URL", "Invalid URL");
  }
  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new CninfoError(
      "FORBIDDEN_URL",
      `Only https URLs on ${[...ALLOWED_HOSTS].join(", ")} are allowed`,
    );
  }
  url.hash = "";
  return url;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 面向巨潮的 HTTP 客户端：主机白名单、并发与节流、超时、带抖动的指数退避重试。
 *
 * 所有上游请求都经过同一个实例，因此并发上限和限流冷却是全局生效的——
 * 多个工具调用同时进行时也不会叠加出超过上限的并发。
 */
export class HttpClient {
  private readonly options: Required<Omit<HttpClientOptions, "onEvent">> & {
    onEvent?: (event: HttpEvent) => void;
  };
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private nextSlotAt = 0;
  private pauseUntil = 0;
  private consecutiveThrottles = 0;

  constructor(options: HttpClientOptions) {
    this.options = {
      backoffMs: 500,
      fetch: (input, init) => fetch(input, init),
      sleep: defaultSleep,
      now: Date.now,
      random: Math.random,
      ...options,
    };
  }

  async getJson<T = unknown>(
    url: string,
    options: RequestOptions & { validate?: (json: T) => void } = {},
  ): Promise<T> {
    return this.requestJson<T>(url, options);
  }

  async postForm<T = unknown>(
    url: string,
    form: Record<string, string | number>,
    options: RequestOptions & { validate?: (json: T) => void } = {},
  ): Promise<T> {
    return this.requestJson<T>(url, { ...options, method: "POST", form });
  }

  async getBytes(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return this.withRetry(url, () => this.requestOnce(url, options));
  }

  private async requestJson<T>(
    url: string,
    options: RequestOptions & { validate?: (json: T) => void },
  ): Promise<T> {
    return this.withRetry(url, async () => {
      const response = await this.requestOnce(url, {
        ...options,
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          ...options.headers,
        },
      });
      let json: T;
      try {
        json = JSON.parse(new TextDecoder("utf-8").decode(response.body)) as T;
      } catch {
        // 巨潮在限流时常返回 200 + 空体或 HTML，按瞬时故障处理
        throw new CninfoError(
          "UPSTREAM",
          `CNINFO returned a non-JSON response (${response.body.byteLength} bytes)`,
          { retryable: true },
        );
      }
      options.validate?.(json);
      return json;
    });
  }

  private async withRetry<T>(url: string, attemptFn: () => Promise<T>): Promise<T> {
    const { maxAttempts, backoffMs } = this.options;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await attemptFn();
        this.consecutiveThrottles = 0;
        return result;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof CninfoError && error.retryable;
        if (!retryable || attempt === maxAttempts) break;
        const hinted = error.retryAfterMs ?? 0;
        const delay = Math.max(
          hinted,
          backoffMs * 2 ** (attempt - 1) * (0.75 + this.options.random() * 0.5),
        );
        this.options.onEvent?.({
          type: "retry",
          url,
          attempt,
          detail: `${error.message}; retrying in ${Math.round(delay)}ms`,
        });
        await this.options.sleep(delay);
      }
    }
    throw lastError;
  }

  /** 限流信号：全局暂停一段时间，避免其余排队请求继续撞限流。 */
  private throttle(url: string, retryAfterMs: number): void {
    this.consecutiveThrottles += 1;
    const cooldown = Math.max(
      retryAfterMs,
      Math.min(15000, 1000 * 2 ** (this.consecutiveThrottles - 1)),
    );
    this.pauseUntil = Math.max(this.pauseUntil, this.options.now() + cooldown);
    this.options.onEvent?.({
      type: "throttle",
      url,
      attempt: this.consecutiveThrottles,
      detail: `cooling down ${cooldown}ms`,
    });
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.options.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    // 持有名额后再排发起时刻：既满足最小间隔，也尊重限流冷却
    for (;;) {
      const now = this.options.now();
      const startAt = Math.max(now, this.nextSlotAt, this.pauseUntil);
      this.nextSlotAt = startAt + this.options.minIntervalMs;
      if (startAt <= now) return;
      const pauseSeen = this.pauseUntil;
      await this.options.sleep(startAt - now);
      // 等待期间别的请求可能刚被限流并延长了冷却：已排好的发起时刻作废，重新排
      if (this.pauseUntil <= pauseSeen || this.pauseUntil <= startAt) return;
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // 名额直接移交，active 不变
    else this.active -= 1;
  }

  private async requestOnce(url: string, options: RequestOptions): Promise<HttpResponse> {
    let target = assertAllowedUrl(url);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        target.searchParams.set(key, String(value));
      }
    }
    let method = options.method ?? "GET";
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;

    await this.acquire();
    // 不用 AbortSignal.timeout：它的定时器不会阻止进程退出，
    // 在没有其他活动句柄时超时永远不会触发。这里用普通定时器并在结束时清除。
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("The operation timed out", "TimeoutError")),
      timeoutMs,
    );
    try {
      const signal = options.signal
        ? AbortSignal.any([timeout.signal, options.signal])
        : timeout.signal;
      const headers: Record<string, string> = {
        "User-Agent": this.options.userAgent,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
        Referer: `${API_ORIGIN}/new/commonUrl?url=disclosure/list/notice`,
        ...options.headers,
      };
      let body: string | undefined;
      if (options.form) {
        body = new URLSearchParams(
          Object.entries(options.form).map(([k, v]): [string, string] => [k, String(v)]),
        ).toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        headers.Origin = API_ORIGIN;
      }

      try {
        for (let hop = 0; ; hop++) {
          this.options.onEvent?.({ type: "request", url: target.href, attempt: hop + 1 });
          const response = await this.options.fetch(target.href, {
            method,
            headers,
            body,
            signal,
            redirect: "manual",
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel().catch(() => {});
            if (hop >= MAX_REDIRECTS) {
              throw new CninfoError("UPSTREAM", "Too many redirects");
            }
            // 每一跳都重新过白名单，重定向无法把请求带到其他主机
            target = assertAllowedUrl(response.headers.get("location") ?? "", target.href);
            if (method === "POST" && response.status !== 307 && response.status !== 308) {
              // 与浏览器一致：301/302/303 之后改用 GET，不重放表单
              method = "GET";
              body = undefined;
              delete headers["Content-Type"];
            }
            continue;
          }
          return await this.readResponse(target.href, response, maxBytes);
        }
      } catch (error) {
        if (error instanceof CninfoError) throw error;
        if (options.signal?.aborted) {
          throw new CninfoError("TIMEOUT", "Request cancelled", { cause: error });
        }
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new CninfoError("TIMEOUT", `CNINFO request timed out after ${timeoutMs}ms`, {
            retryable: true,
            cause: error,
          });
        }
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        throw new CninfoError(
          "UPSTREAM",
          `Network error contacting CNINFO: ${cause instanceof Error ? cause.message : String(cause)}`,
          { retryable: true, cause: error },
        );
      }
    } finally {
      clearTimeout(timer);
      this.release();
    }
  }

  private async readResponse(
    url: string,
    response: Response,
    maxBytes: number,
  ): Promise<HttpResponse> {
    const { status } = response;
    if (status < 200 || status >= 300) {
      await response.body?.cancel().catch(() => {});
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (status === 403 || status === 429) {
        // 巨潮用 403 表达限流/短暂封禁
        this.throttle(url, retryAfterMs);
        const error = new CninfoError(
          "RATE_LIMITED",
          `CNINFO is rate limiting requests (HTTP ${status})`,
          { retryable: true },
        );
        error.retryAfterMs = retryAfterMs;
        throw error;
      }
      if (status === 404) {
        throw new CninfoError("NOT_FOUND", "CNINFO returned HTTP 404 for the requested resource");
      }
      const retryable = status >= 500 || status === 408;
      const error = new CninfoError("UPSTREAM", `CNINFO returned HTTP ${status}`, { retryable });
      error.retryAfterMs = retryAfterMs;
      throw error;
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new CninfoError("TOO_LARGE", `Response is larger than ${maxBytes} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new CninfoError("TOO_LARGE", `Response is larger than ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { url, status, headers: response.headers, body };
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(30000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return 0;
  return Math.min(30000, Math.max(0, date - Date.now()));
}
