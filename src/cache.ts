import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

interface Entry<V> {
  value: V;
  expires: number;
}

/**
 * 带 TTL 的内存 LRU 缓存，并对同一 key 的并发加载去重：
 * 多个工具调用同时请求同一份数据时只发一次上游请求。
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(maxEntries = 500, now: () => number = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // 重新插入以刷新 LRU 次序
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** 命中缓存直接返回；否则加载并缓存。失败不缓存，下次调用会重试。 */
  async getOrLoad(key: string, ttlMs: number, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }
}

/** 先写临时文件再 rename：读者永远看不到写了一半的文件。 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** 串行执行器：让 CPU/内存密集的任务（PDF 解析）一次只跑一个。 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}
