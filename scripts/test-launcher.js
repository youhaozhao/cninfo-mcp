const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const LAUNCHER = 'bin/cninfo-mcp.js';
const INSTALLER = 'scripts/install-python-deps.js';

function load(file, { versions = {}, existing = true, missingDeps = false, platform = 'win32', args = [] } = {}) {
  const calls = [];
  const errors = [];
  const fakeFs = { existsSync: () => existing, mkdirSync() {} };
  const fakeProcess = {
    platform,
    env: {},
    argv: ['node', file, ...args],
    execPath: 'node',
    exit(code) { throw new Error(`exit ${code}`); },
  };
  const context = {
    __dirname: path.join('C:/Users/Jane Doe & Co/repo', path.dirname(file)),
    process: fakeProcess,
    console: { log() {}, warn() {}, error(...parts) { errors.push(parts.join(' ')); } },
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
    .replace(/\nmain\(\)[\s\S]*$/, '\n');
  vm.runInContext(source, context);
  return { calls, context, errors, fakeFs, run: code => vm.runInContext(code, context) };
}

for (const file of [LAUNCHER, INSTALLER]) {
  test(`${file}: prefers supported venv without system Python`, async () => {
    const app = load(file, { versions: { default: 'Python 3.10.0' } });
    await app.run('main()');
    assert(app.calls.every(call => call.cmd.includes('Jane Doe & Co')));
    assert(app.calls.every(call => call.options.shell === false));
    assert(app.calls.every(call => Array.isArray(call.args)));
    assert(!app.calls.some(call => call.args.includes('venv')));
    assert(!app.calls.some(call => call.args.includes('pip')));
  });

  test(`${file}: rejects unsupported cached venv and keeps it intact`, async () => {
    const app = load(file, { versions: { default: 'Python 3.9.6' } });
    app.fakeFs.existsSync = filename => !filename.includes('venv-py310');
    assert.equal(await app.run('reusableVenv()'), null);
    assert.match(app.run('getVenvPython()'), /venv-py310/);
  });
}

test(`${LAUNCHER}: starts the server from an installed environment`, async () => {
  const app = load(LAUNCHER, { versions: { default: 'Python 3.12.0' } });
  await app.run('main()');
  const server = app.calls.find(call => call.args[0].endsWith('mcp_server.py'));
  assert.equal(server.options.stdio, 'inherit');
});

test(`${LAUNCHER}: never creates an environment at startup`, async () => {
  const app = load(LAUNCHER, { versions: { python3: 'Python 3.12.0' } });
  app.fakeFs.existsSync = filename => !filename.includes('/venv/');
  await assert.rejects(app.run('main()'), /exit 1/);
  assert.deepEqual(app.calls, []);
  assert.match(app.errors.join('\n'), /npx -y @youhaozhao\/cninfo-mcp install/);
});

test(`${LAUNCHER}: never installs dependencies at startup`, async () => {
  const app = load(LAUNCHER, { versions: { default: 'Python 3.12.0' }, missingDeps: true });
  await assert.rejects(app.run('main()'), /exit 1/);
  assert(!app.calls.some(call => call.args.includes('pip')));
  assert(!app.calls.some(call => call.args[0].endsWith('mcp_server.py')));
  assert.match(app.errors.join('\n'), /npx -y @youhaozhao\/cninfo-mcp install/);
});

test(`${LAUNCHER}: install subcommand only runs the installer`, async () => {
  const app = load(LAUNCHER, { args: ['install'] });
  await app.run('main()');
  assert.equal(app.calls.length, 1);
  const [installer] = app.calls;
  assert.equal(installer.cmd, 'node');
  assert(installer.args[0].endsWith(path.join('scripts', 'install-python-deps.js')));
  assert.equal(installer.options.stdio, 'inherit');
  assert.equal(installer.options.shell, false);
});

test(`${INSTALLER}: skips unsupported Python, accepts version on stderr`, async () => {
  const app = load(INSTALLER, { versions: { python3: 'Python 3.9.6', python: 'Python 2.7.18', 'python3.12': 'Python 3.12.0' } });
  assert.equal(await app.run('findPython()'), 'python3.12');
  assert.equal(app.calls.length, 3);
});

test(`${INSTALLER}: creates venv and installs using unsplit paths`, async () => {
  const app = load(INSTALLER, { versions: { python3: 'Python 3.12.0' }, missingDeps: true });
  app.fakeFs.existsSync = filename => !filename.includes('/venv/');
  await app.run('main()');
  const create = app.calls.find(call => call.args[1] === 'venv');
  const install = app.calls.find(call => call.args[1] === 'pip');
  assert(create);
  assert(install);
  assert.match(create.args[2], /Jane Doe & Co/);
  assert.match(install.args[4], /Jane Doe & Co/);
  assert(app.calls.every(call => call.options.shell === false));
});

test(`${INSTALLER}: fails when no supported Python is available`, async () => {
  const app = load(INSTALLER, { versions: { python3: 'Python 3.9.6' } });
  app.fakeFs.existsSync = filename => !filename.includes('/venv/');
  await assert.rejects(app.run('main()'), /Python 3\.10\+ not found/);
  assert(!app.calls.some(call => call.args.includes('venv')));
});
