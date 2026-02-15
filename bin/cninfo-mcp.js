#!/usr/bin/env node

/**
 * 巨潮资讯 MCP 服务器启动器
 * 自动检测 Python 并安装依赖，然后启动 Python MCP 服务器。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 配置路径
const PYTHON_SCRIPT = path.join(__dirname, '..', 'python', 'mcp_server.py');
const PYTHON_REQUIREMENTS = path.join(__dirname, '..', 'python', 'requirements.txt');

// 查找可用的 Python 可执行文件
async function findPython() {
  const pythonCommands = ['python3', 'python', 'python3.12', 'python3.11', 'python3.10'];

  for (const cmd of pythonCommands) {
    try {
      const result = await spawnAsync(cmd, ['--version']);
      if (result.stdout && result.stdout.includes('Python')) {
        return cmd;
      }
    } catch (error) {
      // 继续尝试下一个命令
    }
  }

  throw new Error(
    'Python not found. Please install Python 3.10+ from https://python.org\n' +
    'After installation, restart your terminal and try again.'
  );
}

// 检查并安装 Python 依赖
async function ensureDependencies(pythonCmd) {
  const requirementsPath = PYTHON_REQUIREMENTS;

  if (!fs.existsSync(requirementsPath)) {
    console.error('Error: requirements.txt not found at', requirementsPath);
    process.exit(1);
  }

  try {
    // 检查 mcp 包是否已安装
    const checkResult = await spawnAsync(pythonCmd, ['-c', 'import mcp']);
  } catch (error) {
    // 未安装，执行安装
    console.error('Installing Python dependencies...');
    const installResult = await spawnAsync(pythonCmd, ['-m', 'pip', 'install', '-r', requirementsPath], {
      stdio: 'inherit'
    });

    if (installResult.code !== 0) {
      console.error('\n❌ Failed to install Python dependencies');
      console.error('Please run manually:');
      console.error(`  ${pythonCmd} -m pip install -r ${requirementsPath}`);
      process.exit(1);
    }

    console.error('✅ Python dependencies installed successfully\n');
  }
}

// 启动子进程并返回结果
function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio || 'pipe',
      shell: process.platform === 'win32',
      ...options
    });

    let stdout = '';
    let stderr = '';
    let code = null;

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (exitCode) => {
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

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  try {
    // 检查 Python 脚本是否存在
    if (!fs.existsSync(PYTHON_SCRIPT)) {
      console.error('Error: mcp_server.py not found at', PYTHON_SCRIPT);
      process.exit(1);
    }

    const pythonCmd = await findPython();
    await ensureDependencies(pythonCmd);

    // 启动 MCP 服务器
    console.error('巨潮资讯 MCP 服务器已启动，等待连接...');
    const child = spawn(pythonCmd, [PYTHON_SCRIPT], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        PYTHONPATH: path.join(__dirname, '..', 'python')
      }
    });

    // 处理子进程退出
    child.on('error', (error) => {
      console.error('Failed to start MCP Server:', error.message);
      process.exit(1);
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
