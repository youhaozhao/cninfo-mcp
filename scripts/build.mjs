// 把服务器和它的全部依赖打成 dist/ 下的自包含产物。
//
// 发布包因此没有任何运行时依赖：安装时不会再拉取 pdf.js 的可选原生模块
// (@napi-rs/canvas，约 30 MB，只用于渲染，我们只提取文字) 以及 MCP SDK 里
// 用不到的 HTTP 服务端依赖。
import { build } from "esbuild";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const require = createRequire(import.meta.url);

await fs.rm(dist, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  bundle: true,
  // 代码分割让 pdf.js 留在单独的 chunk 里，只在第一次读取 PDF 时才加载
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22.13",
  chunkNames: "chunks/[name]-[hash]",
  // 依赖里有 CommonJS 模块，它们在 ESM 产物里需要一个可用的 require
  banner: {
    js: 'import { createRequire as __cninfoCreateRequire } from "node:module";\nconst require = __cninfoCreateRequire(import.meta.url);',
  },
  // pdf.js 只在渲染时才用到这个可选原生模块；保持外部引用，运行时不存在也无妨
  external: ["@napi-rs/canvas"],
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// pdf.js 提取中文文本需要的字体映射，以及标准字体的度量数据
const pdfjsRoot = path.resolve(path.dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")), "..", "..");
for (const directory of ["cmaps", "standard_fonts"]) {
  await fs.cp(path.join(pdfjsRoot, directory), path.join(dist, "pdfjs", directory), { recursive: true });
}

// 打进产物的第三方包及其许可证全文
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const marker = "node_modules/";
  const index = input.lastIndexOf(marker);
  if (index < 0) continue;
  const rest = input.slice(index + marker.length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!packages.has(name)) packages.set(name, path.join(root, input.slice(0, index + marker.length), name));
}
const notices = [
  "This package bundles the following third-party software.",
  "",
];
for (const [name, directory] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  const files = await fs.readdir(directory);
  const licenseFile = files.find((file) => /^(licen[sc]e|copying)(\.|$)/i.test(file));
  const text = licenseFile ? (await fs.readFile(path.join(directory, licenseFile), "utf8")).trim() : "(no license file shipped; see the package repository)";
  notices.push("=".repeat(78), `${name}@${manifest.version} — ${manifest.license ?? "see below"}`, "=".repeat(78), "", text, "");
}
await fs.writeFile(path.join(dist, "THIRD-PARTY-LICENSES.txt"), notices.join("\n"));

let bytes = 0;
for (const entry of await fs.readdir(dist, { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) bytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
}
console.log(`dist: ${(bytes / 1024 / 1024).toFixed(1)} MB, ${packages.size} bundled packages`);
