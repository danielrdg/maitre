#!/usr/bin/env node
// Test double for gsettings, run as `fake-gsettings.mjs <db.json> <log> <args...>`.
// The db maps "schema" or "schema:/path/" to { key: value } with values in GVariant text, as gsettings prints them.
// Supports get, set, reset and list-recursively; every call appends one JSON line of argv to <log>.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [db, log, cmd, target, key, value] = process.argv.slice(2);
appendFileSync(log, JSON.stringify(process.argv.slice(4)) + '\n');
const data = existsSync(db) ? JSON.parse(readFileSync(db, 'utf8')) : {};
const relocatable = (target ?? '').includes(':');
const fail = (msg) => {
  process.stderr.write(msg + '\n');
  process.exit(1);
};

if (cmd === 'get') {
  const schema = data[target];
  if (schema !== undefined && Object.hasOwn(schema, key)) console.log(schema[key]);
  else if (relocatable) console.log("''");
  else fail(schema === undefined ? `No such schema “${target}”` : `No such key “${key}”`);
} else if (cmd === 'set') {
  if (value === undefined) fail('usage: set SCHEMA[:PATH] KEY VALUE');
  if (!relocatable && data[target] === undefined) fail(`No such schema “${target}”`);
  data[target] = { ...data[target], [key]: value };
  writeFileSync(db, JSON.stringify(data, null, 2) + '\n');
} else if (cmd === 'reset') {
  if (data[target] !== undefined) {
    delete data[target][key];
    if (relocatable && Object.keys(data[target]).length === 0) delete data[target];
    writeFileSync(db, JSON.stringify(data, null, 2) + '\n');
  }
} else if (cmd === 'list-recursively') {
  const schema = data[target];
  if (schema === undefined || relocatable) fail(`No such schema “${target}”`);
  for (const [k, v] of Object.entries(schema)) console.log(`${target} ${k} ${v}`);
} else {
  fail(`fake gsettings: unsupported command ${cmd}`);
}
