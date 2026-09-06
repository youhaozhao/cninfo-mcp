#!/usr/bin/env node

/**
 * 巨潮资讯 MCP 服务器启动器
 * 自动检测 Python 并安装依赖，然后启动 Python MCP 服务器。
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// 配置路径
const PYTHON_SCRIPT = path.join(__dirname, "..", "python", "mcp_server.py");
const PYTHON_REQUIREMENTS = path.join(
  __dirname,
  "..",
  "python",
  "requirements.txt",
);

// 虚拟环境目录，放在用户目录下保证跨 npx 调用持久化
let VENV_DIR = path.join(os.homedir(), ".cninfo-mcp", "venv");

// 获取虚拟环境中的 Python 可执行文件路径
function getVenvPython() {
  if (process.platform === "win32") {
    return path.join(VENV_DIR, "Scripts", "python.exe");
  }
  return path.join(VENV_DIR, "bin", "python3");
}

// 查找可用的系统 Python 可执行文件（仅用于创建 venv）
async function isSupportedPython(cmd) {
  try {
    const result = await spawnAsync(cmd, ["--version"]);
    const version = `${result.stdout || ""} ${result.stderr || ""}`.match(/\bPython (\d+)\.(\d+)\.(\d+)\b/);
    return Boolean(version && Number(version[1]) === 3 && Number(version[2]) >= 10);
  } catch {
    return false;
  }
}

// Preserve an obsolete environment and create a compatible sibling if needed.
async function reusableVenv() {
  if (!fs.existsSync(getVenvPython())) return null;
  if (await isSupportedPython(getVenvPython())) return getVenvPython();
  VENV_DIR += "-py310";
  if (!fs.existsSync(getVenvPython())) return null;
  if (await isSupportedPython(getVenvPython())) return getVenvPython();
  throw new Error(`Unsupported or broken Python environment at ${VENV_DIR}. Recreate it with Python 3.10+.`);
}

async function findPython() {
  const pythonCommands = [
    "python3",
    "python",
    "python3.12",
    "python3.11",
    "python3.10",
  ];

  for (const cmd of pythonCommands) {
    if (await isSupportedPython(cmd)) return cmd;
  }

  throw new Error(
    "Python not found. Please install Python 3.10+ from https://python.org\n" +
      "After installation, restart your terminal and try again.",
  );
}

// 创建虚拟环境（如果不存在）
async function ensureVenv(systemPythonCmd) {
  const venvPython = getVenvPython();
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  console.error("Creating Python virtual environment...");
  fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
  await spawnAsync(systemPythonCmd, ["-m", "venv", VENV_DIR], {
    stdio: ["ignore", 2, 2],
  });
  console.error("Virtual environment created\n");
  return venvPython;
}

// 依赖探针：校验 venv 是否满足 requirements.txt 的全部约束
const DEPS_CHECK = path.join(__dirname, "..", "python", "check_deps.py");

// 检查并安装 Python 依赖（使用 venv 中的 python）
async function ensureDependencies(venvPython) {
  const requirementsPath = PYTHON_REQUIREMENTS;

  if (!fs.existsSync(requirementsPath)) {
    console.error("Error: requirements.txt not found at", requirementsPath);
    process.exit(1);
  }

  try {
    // 校验依赖是否满足约束（不满足时抛错，转入下方安装流程）
    await spawnAsync(venvPython, [DEPS_CHECK]);
  } catch (error) {
    // 未安装，执行安装
    console.error("Installing Python dependencies...");
    try {
      await spawnAsync(
        venvPython,
        ["-m", "pip", "install", "-r", requirementsPath],
        {
          stdio: ["ignore", 2, 2],
        },
      );
      console.error("Python dependencies installed successfully\n");
    } catch (installError) {
      console.error("\n❌ Failed to install Python dependencies");
      console.error("Please run manually:");
      console.error(`  ${venvPython} -m pip install -r ${requirementsPath}`);
      process.exit(1);
    }
  }
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
    // 检查 Python 脚本是否存在
    if (!fs.existsSync(PYTHON_SCRIPT)) {
      console.error("Error: mcp_server.py not found at", PYTHON_SCRIPT);
      process.exit(1);
    }

    const venvPython = (await reusableVenv()) || (await ensureVenv(await findPython()));
    await ensureDependencies(venvPython);

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
