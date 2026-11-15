import { invalid } from "./errors.ts";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把 epoch 毫秒格式化为北京时间的日期与时间（巨潮的时间戳都是北京时间语义）。 */
export function shanghaiDateTime(epochMs: number): { date: string; time: string } {
  const iso = new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export function todayInShanghai(now: number = Date.now()): string {
  return shanghaiDateTime(now).date;
}

/** 校验 YYYY-MM-DD，并拒绝 2024-02-31 这类不存在的日期。 */
export function parseDate(value: string, field: string): string {
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.toISOString().slice(0, 10) === text) return text;
  }
  throw invalid(`${field} must be a valid date in YYYY-MM-DD format, got "${value}"`);
}
