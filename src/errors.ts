/** 所有可预期失败的统一错误类型：工具层据此生成结构化的错误响应。 */
export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "UPSTREAM"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "FORBIDDEN_URL"
  | "TOO_LARGE"
  | "UNSUPPORTED";

export class CninfoError extends Error {
  readonly code: ErrorCode;
  /** 瞬时故障（限流、超时、5xx、空响应）为 true，HTTP 层会自动重试。 */
  readonly retryable: boolean;
  readonly details?: unknown;
  /** 服务端通过 Retry-After 建议的等待毫秒数。 */
  retryAfterMs?: number;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CninfoError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function invalid(message: string, details?: unknown): CninfoError {
  return new CninfoError("INVALID_INPUT", message, { details });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
