import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('Preview rejection remains a handled HTTP error: no process crash and deduplicated retry can rebuild', () => {
  for (const reason of ['revision', 'closed', 'worker']) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
      resolve('test/fixtures/preview-rejection.ts'), reason], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { survived: true, captures: 2, reason });
  }
});
