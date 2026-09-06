const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function load(file, { versions = {}, existing = true, missingDeps = false, platform = 'win32' } = {}) {
  const calls = [];
  const fakeFs = { existsSync: () => existing, mkdirSync() {} };
  const fakeProcess = { platform, env: {}, exit(code) { throw new Error(`exit ${code}`); } };
  const context = {
    __dirname: path.join('C:/Users/Jane Doe & Co/repo', path.dirname(file)),
    process: fakeProcess,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === 'os') return { homedir: () => 'C:/Users/Jane Doe & Co' };
      if (name !== 'child_process') return require(name);
      return { spawn(cmd, args, options) {
        calls.push({ cmd, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          let code = 0;
          if (args[0] === '--version') {
            const version = versions[cmd] ?? versions.default;
            if (version) child.stderr.emit('data', version);
            else code = 1;
          } else if (missingDeps && args[0].endsWith('check_deps.py')) code = 1;
          child.emit('close', code);
        });
        return child;
      } };
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/main\(\)(?:\.catch\(console.error\))?;\s*$/, '');
  vm.runInContext(source, context);
  return { calls, context, fakeFs, run: code => vm.runInContext(code, context) };
}

for (const file of ['bin/cninfo-mcp.js', 'scripts/install-python-deps.js']) {
  test(`${file}: skips unsupported Python, accepts version on stderr`, async () => {
    const app = load(file, { versions: { python3: 'Python 3.9.6', python: 'Python 2.7.18', 'python3.12': 'Python 3.12.0' } });
    assert.equal(await app.run('findPython()'), 'python3.12');
    assert.equal(app.calls.length, 3);
  });

  test(`${file}: prefers supported venv without system Python`, async () => {
    const app = load(file, { versions: { default: 'Python 3.10.0' } });
    await app.run('main()');
    assert(app.calls.every(call => call.cmd.includes('Jane Doe & Co')));
    assert(app.calls.every(call => call.options.shell === false));
    assert(app.calls.every(call => Array.isArray(call.args)));
    assert(!app.calls.some(call => call.args.includes('venv')));
  });

  test(`${file}: rejects unsupported cached venv and keeps it intact`, async () => {
    const app = load(file, { versions: { default: 'Python 3.9.6' } });
    app.fakeFs.existsSync = filename => !filename.includes('venv-py310');
    assert.equal(await app.run('reusableVenv()'), null);
    assert.match(app.run('getVenvPython()'), /venv-py310/);
  });

  test(`${file}: creates venv and installs using unsplit paths`, async () => {
    const app = load(file, { versions: { python3: 'Python 3.12.0' }, missingDeps: true });
    app.fakeFs.existsSync = filename => !filename.includes('/venv/');
    await app.run('main()');
    const create = app.calls.find(call => call.args[1] === 'venv');
    const install = app.calls.find(call => call.args[1] === 'pip');
    assert(create);
    assert(install);
    assert.match(create.args[2], /Jane Doe & Co/);
    assert.match(install.args[4], /Jane Doe & Co/);
    assert(app.calls.every(call => call.options.shell === false));
    if (file.startsWith('bin')) {
      assert.equal(JSON.stringify(create.options.stdio), '["ignore",2,2]');
      assert.equal(JSON.stringify(install.options.stdio), '["ignore",2,2]');
      const server = app.calls.find(call => call.args[0].endsWith('mcp_server.py'));
      assert.equal(server.options.stdio, 'inherit');
    }
  });
}
