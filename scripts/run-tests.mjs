import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collect(dir, suffix) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p, suffix));
    else if (name.endsWith(suffix)) out.push(p);
  }
  return out.sort();
}

const suites = [
  ['dist/test', '.test.js'],
  ['test/lounge', '.test.mjs'],
];

const files = [];
for (const [dir, suffix] of suites) {
  const found = collect(dir, suffix);
  console.log(`${dir}/**/*${suffix}: ${found.length} file(s)`);
  files.push(...found);
}

if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
