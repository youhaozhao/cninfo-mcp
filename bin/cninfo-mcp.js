#!/usr/bin/env node

/**
 * 巨潮资讯 MCP 服务器启动器
 * 只校验已有的 Python 环境并启动 Python MCP 服务器：不联网，不写用户目录。
 * 环境由显式命令 `cninfo-mcp install` 准备（scripts/install-python-deps.js）。
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// 配置路径
const PYTHON_SCRIPT = path.join(__dirname, "..", "python", "mcp_server.py");
const INSTALL_SCRIPT = path.join(
  __dirname,
  "..",
  "scripts",
  "install-python-deps.js",
);
const INSTALL_COMMAND = "npx -y @youhaozhao/cninfo-mcp install";

// 虚拟环境目录，放在用户目录下保证跨 npx 调用持久化
let VENV_DIR = path.join(os.homedir(), ".cninfo-mcp", "venv");

// 获取虚拟环境中的 Python 可执行文件路径
function getVenvPython() {
  if (process.platform === "win32") {
    return path.join(VENV_DIR, "Scripts", "python.exe");
  }
  return path.join(VENV_DIR, "bin", "python3");
}

async function isSupportedPython(cmd) {
  try {
    const result = await spawnAsync(cmd, ["--version"]);
    const version = `${result.stdout || ""} ${result.stderr || ""}`.match(/\bPython (\d+)\.(\d+)\.(\d+)\b/);
    return Boolean(version && Number(version[1]) === 3 && Number(version[2]) >= 10);
  } catch {
    return false;
  }
}

// An obsolete environment is left intact; its compatible sibling is used instead.
async function reusableVenv() {
  if (!fs.existsSync(getVenvPython())) return null;
  if (await isSupportedPython(getVenvPython())) return getVenvPython();
  VENV_DIR += "-py310";
  if (!fs.existsSync(getVenvPython())) return null;
  if (await isSupportedPython(getVenvPython())) return getVenvPython();
  throw new Error(`Unsupported or broken Python environment at ${VENV_DIR}. Recreate it with Python 3.10+.`);
}

// 依赖探针：校验 venv 是否满足 requirements.txt 的全部约束
const DEPS_CHECK = path.join(__dirname, "..", "python", "check_deps.py");

// 只读校验：环境缺失或依赖不满足时报错并给出安装命令，不在启动阶段安装
async function requireEnvironment() {
  const venvPython = await reusableVenv();
  if (!venvPython) {
    throw new Error(
      "Python environment for cninfo-mcp is not installed.\n" +
        `Run this once, then restart the MCP client: ${INSTALL_COMMAND}`,
    );
  }

  try {
    await spawnAsync(venvPython, [DEPS_CHECK]);
  } catch {
    throw new Error(
      `Python dependencies in ${VENV_DIR} are missing or out of date.\n` +
        `Run this, then restart the MCP client: ${INSTALL_COMMAND}`,
    );
  }
  return venvPython;
}

// 显式安装入口：唯一会联网并写用户目录的路径
function runInstaller() {
  const child = spawn(process.execPath, [INSTALL_SCRIPT], {
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (error) => {
    console.error("Failed to start installer:", error.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

// 启动子进程并返回结果
function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio || "pipe",
      shell: false,
      ...options,
    });

    let stdout = "";
    let stderr = "";
    let code = null;

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
    }

    child.on("close", (exitCode) => {
      code = exitCode;
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const error = new Error(`Command failed with exit code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
      }
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

async function main() {
  try {
    if (process.argv[2] === "install") {
      runInstaller();
      return;
    }

    // 检查 Python 脚本是否存在
    if (!fs.existsSync(PYTHON_SCRIPT)) {
      console.error("Error: mcp_server.py not found at", PYTHON_SCRIPT);
      process.exit(1);
    }

    const venvPython = await requireEnvironment();

    // 启动 MCP 服务器
    console.error("巨潮资讯 MCP 服务器已启动，等待连接...");
    const child = spawn(venvPython, [PYTHON_SCRIPT], {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        PYTHONPATH: path.join(__dirname, "..", "python"),
      },
    });

    // 处理子进程退出
    child.on("error", (error) => {
      console.error("Failed to start MCP Server:", error.message);
      process.exit(1);
    });

    child.on("exit", (code) => {
      process.exit(code || 0);
    });
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
