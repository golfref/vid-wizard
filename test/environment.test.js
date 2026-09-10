import assert from 'node:assert/strict';
import test from 'node:test';
import { configureProjectEnvironment } from '../poc/src/environment.js';

test('adds the project virtual-environment bin directory to PATH', () => {
  const environment = { PATH: '/usr/bin' };
  const added = configureProjectEnvironment({
    cwd: '/workspace',
    environment,
    exists: (entry) => entry === '/workspace/.venv/bin'
  });

  assert.equal(added, true);
  assert.equal(environment.PATH, '/workspace/.venv/bin:/usr/bin');
});
