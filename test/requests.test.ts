import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeRequest } from '../src/requests.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'maitre-requests-'));
}

test('20 concurrent storeRequest calls get 20 distinct ids and 0600 files', async () => {
  const home = tmpHome();
  try {
    const env = { MAITRE_HOME: home };
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => storeRequest(`request ${i}`, env)));
    assert.equal(new Set(ids).size, 20);
    const dir = join(home, 'reception', 'requests');
    assert.equal(readdirSync(dir).length, 20);
    for (const id of ids) {
      assert.match(id, /^[0-9]+$/);
      assert.equal(statSync(join(dir, `${id}.md`)).mode & 0o777, 0o600);
    }
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('storeRequest keeps the text byte for byte', async () => {
  const home = tmpHome();
  try {
    const text = 'run $(rm -rf ~) and `id`\nsecond line\r\n  indented ünï\n';
    const id = await storeRequest(text, { MAITRE_HOME: home });
    assert.equal(readFileSync(join(home, 'reception', 'requests', `${id}.md`), 'utf8'), text);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
