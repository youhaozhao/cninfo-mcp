import fs from "node:fs/promises";
import path from "node:path";
import { DOWNLOAD_DIR_ENV } from "./config.ts";
import { invalid } from "./errors.ts";

/**
 * 对可能尚不存在的路径做 realpath：解析最深的已存在祖先目录里的符号链接，
 * 再拼回剩余部分。这样指向根目录之外的符号链接无法绕过边界检查。
 */
export async function realpathLoose(target: string): Promise<string> {
  const pending: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return pending.length > 0 ? path.join(real, ...pending.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...pending.reverse());
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  // 只有 ".." 本身或以 "../" 开头才是越界；名为 "..foo" 的子目录是合法的
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`);
  return !escapes && !path.isAbsolute(relative);
}

/**
 * 把调用方给的保存路径限制在下载根目录内，返回最终写入目录。
 * 相对路径按根目录下的子目录解析；绝对路径只有落在根目录内才接受。
 */
export async function resolveSaveDir(root: string, savePath?: string): Promise<string> {
  const realRoot = await realpathLoose(root);
  const requested = savePath?.trim();
  if (!requested) return realRoot;
  if (requested.includes("\0")) throw invalid("save_path contains an invalid character");
  const candidate = await realpathLoose(path.resolve(realRoot, requested));
  if (!isInside(realRoot, candidate)) {
    throw invalid(
      `save_path must be inside the download directory ${realRoot}. Set ${DOWNLOAD_DIR_ENV} in the MCP server configuration to change it`,
    );
  }
  return candidate;
}

/** 生成跨平台安全的文件名片段，并按 UTF-8 字节数截断。 */
export function safeFileStem(value: string, maxBytes = 180): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  let result = "";
  let bytes = 0;
  for (const char of cleaned) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result || "document";
}
