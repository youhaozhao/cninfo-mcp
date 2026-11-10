#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

function findPython() {
  const venvPython = process.platform === 'win32'
    ? path.join(os.homedir(), '.cninfo-mcp', 'venv', 'Scripts', 'python.exe')
    : path.join(os.homedir(), '.cninfo-mcp', 'venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  for (const cmd of ['python3', 'python', 'py']) {
    try {
      const res = spawnSync(cmd, ['--version'], { stdio: 'pipe' });
      if (res.status === 0) return cmd;
    } catch {}
  }
  return 'python3';
}

const py = findPython();
const pyRes = spawnSync(py, ['-m', 'pytest', 'python', '-q'], { stdio: 'inherit', shell: false });
if (pyRes.status !== 0) {
  process.exit(pyRes.status ?? 1);
}

const nodeRes = spawnSync(
  process.execPath,
  ['--test', 'scripts/test-launcher.js', 'scripts/test-manifest.js'],
  { stdio: 'inherit', shell: false }
);
process.exit(nodeRes.status ?? 1);
