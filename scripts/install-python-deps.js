#!/usr/bin/env node

/**
 * npm install 后自动安装 Python 依赖
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
  // requirements.txt 不存在则跳过
  if (!fs.existsSync(REQUIREMENTS_FILE)) {
    console.log(
      "⚠️  requirements.txt not found, skipping Python dependencies installation",
    );
    return;
  }

  let venvPython = await reusableVenv();
  if (!venvPython) {
    const pythonCmd = await findPython();
    if (!pythonCmd) {
      console.warn("⚠️  Python 3.10+ not found. Dependencies will be installed on first run.");
      return;
    }
    venvPython = getVenvPython();
    console.log("Creating Python virtual environment...");
    try {
      fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
      await spawnCommand(pythonCmd, ["-m", "venv", VENV_DIR]);
      console.log("Virtual environment created");
    } catch (venvError) {
      console.warn("  Failed to create virtual environment during npm install");
      console.warn("  It will be created automatically on first run");
      return;
    }
  }

  try {
    // 校验依赖是否满足约束（用 venv 的 python）
    await spawnCommand(venvPython, [DEPS_CHECK]);
    console.log("✅ Python dependencies already installed");
  } catch (error) {
    // 执行安装（用 venv 的 pip）
    console.log("📦 Installing Python dependencies...");
    try {
      await spawnCommand(
        venvPython,
        ["-m", "pip", "install", "-r", REQUIREMENTS_FILE],
        {
          stdio: "inherit",
        },
      );
      console.log("✅ Python dependencies installed successfully");
    } catch (installError) {
      console.warn(
        "⚠️  Failed to install Python dependencies during npm install",
      );
      console.warn("   They will be installed automatically on first run");
    }
  }
}

main().catch(console.error);
