#!/usr/bin/env node

/**
 * npm install 后自动安装 Python 依赖
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REQUIREMENTS_FILE = path.join(
  __dirname,
  "..",
  "python",
  "requirements.txt",
);

async function findPython() {
  const pythonCommands = [
    "python3",
    "python",
    "python3.12",
    "python3.11",
    "python3.10",
  ];

  for (const cmd of pythonCommands) {
    try {
      const result = await spawnCommand(cmd, ["--version"]);
      if (result.stdout && result.stdout.includes("Python")) {
        return cmd;
      }
    } catch (error) {}
  }

  return null;
}

function spawnCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "pipe",
      shell: process.platform === "win32",
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

  const pythonCmd = await findPython();
  if (!pythonCmd) {
    console.warn(
      "⚠️  Python not found. Python dependencies will be installed on first run.",
    );
    console.warn("   Please install Python 3.10+ from https://python.org");
    return;
  }

  try {
    // 检查 mcp 是否已安装
    await spawnCommand(pythonCmd, ["-c", "import mcp"]);
    console.log("✅ Python dependencies already installed");
  } catch (error) {
    // 执行安装
    console.log("📦 Installing Python dependencies...");
    try {
      await spawnCommand(
        pythonCmd,
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
