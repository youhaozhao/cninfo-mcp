const test = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');
const server = require('../server.json');

test('package.json runs nothing at npm install time', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts[hook], undefined, hook);
  }
});

test('server.json stays in sync with package.json', () => {
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
});
