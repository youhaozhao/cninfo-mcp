// pdfjs-dist 没有为 worker 入口提供类型声明；我们只把它整体交给 pdf.js，不直接调用。
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
