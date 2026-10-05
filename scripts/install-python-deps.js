#!/usr/bin/env node

/**
 * 显式安装 Python 依赖：在用户目录创建 venv 并执行 pip install。
 * 只由 `cninfo-mcp install` 触发；npm install 和服务器启动都不会运行它。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REQUIREMENTS_FILE = path.join(
  __dirname,
  "..",
  "python",
  "requirements.txt",
);

let VENV_DIR = path.join(os.homedir(), ".cninfo-mcp", "venv");

// 依赖探针：校验 venv 是否满足 requirements.txt 的全部约束
const DEPS_CHECK = path.join(__dirname, "..", "python", "check_deps.py");

function getVenvPython() {
  if (process.platform === "win32") {
    return path.join(VENV_DIR, "Scripts", "python.exe");
  }
  return path.join(VENV_DIR, "bin", "python3");
}

async function isSupportedPython(cmd) {
  try {
    const result = await spawnCommand(cmd, ["--version"]);
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

  return null;
}

function spawnCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "pipe",
      ...options,
      shell: false,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed: ${cmd} ${args.join(" ")}`));
    });

    child.on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(REQUIREMENTS_FILE)) {
    throw new Error(`requirements.txt not found at ${REQUIREMENTS_FILE}`);
  }

  let venvPython = await reusableVenv();
  if (!venvPython) {
    const pythonCmd = await findPython();
    if (!pythonCmd) {
      throw new Error(
        "Python 3.10+ not found. Install it from https://python.org, then run this command again.",
      );
    }
    venvPython = getVenvPython();
    console.log(`Creating Python virtual environment at ${VENV_DIR}...`);
    fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
    await spawnCommand(pythonCmd, ["-m", "venv", VENV_DIR]);
    console.log("Virtual environment created");
  }

  try {
    // 校验依赖是否满足约束（用 venv 的 python）
    await spawnCommand(venvPython, [DEPS_CHECK]);
    console.log("✅ Python dependencies already installed");
  } catch (error) {
    // 执行安装（用 venv 的 pip）
    console.log("📦 Installing Python dependencies...");
    await spawnCommand(
      venvPython,
      ["-m", "pip", "install", "-r", REQUIREMENTS_FILE],
      {
        stdio: "inherit",
      },
    );
    console.log("✅ Python dependencies installed successfully");
  }
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
