#!/usr/bin/env node
/**
 * Controls for `check-platform-sync.mjs`, run against local templates so they need no network:
 * each way a copy can drift must go red and name the file, and the forms that must stay green —
 * a schema differing only in formatting, a tree that `--refresh` has just restored — must.
 *
 * A control that throws is reported as that control's failure rather than ending the run.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(repo, 'scripts', 'check-platform-sync.mjs');
const OWNED = ['build.mjs', 'schema/bootstrap.schema.json', 'schema/manifest.schema.json'];

/** Two packages and a template directory laid out like the generator's, all in step. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'platform-sync-'));
  for (const name of ['presales-demo', 'satori-beta']) {
    cpSync(join(repo, 'config-packages', name), join(root, 'config-packages', name), {
      recursive: true,
      filter: (src) => !src.includes(`${name}/dist`),
    });
  }
  const templates = join(root, 'templates');
  for (const file of OWNED) {
    mkdirSync(dirname(join(templates, file)), { recursive: true });
    cpSync(join(repo, 'config-packages', 'satori-beta', file), join(templates, `${file}__tmpl__`));
  }
  return { root, templates };
}

function run({ root, templates }, ...args) {
  const result = spawnSync(process.execPath, [checker, '--root', root, '--templates', templates, ...args], {
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const pkg = (root, name, file) => join(root, 'config-packages', name, file);
const results = [];

function control(name, expectCode, setup, mustMention = [], extraArgs = []) {
  let tree;
  try {
    tree = fixture();
    setup(tree);
    const { code, out } = run(tree, ...extraArgs);
    const missing = mustMention.filter((text) => !out.includes(text));
    const ok = code === expectCode && missing.length === 0;
    results.push({
      name,
      ok,
      detail: ok ? '' : `exit ${code} (wanted ${expectCode})${missing.length ? `, output lacks ${JSON.stringify(missing)}` : ''}\n${out}`,
    });
  } catch (error) {
    results.push({ name, ok: false, detail: `threw ${error.name}: ${error.message}` });
  } finally {
    if (tree) rmSync(tree.root, { recursive: true, force: true });
  }
}

control('copies in step with the templates pass', 0, () => {});

control(
  'one changed byte in a build.mjs is refused, by name',
  1,
  ({ root }) => appendFileSync(pkg(root, 'presales-demo', 'build.mjs'), '\n'),
  ['config-packages/presales-demo/build.mjs differs'],
);

control('a schema differing only in formatting passes', 0, ({ root }) => {
  const path = pkg(root, 'satori-beta', 'schema/bootstrap.schema.json');
  writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 4));
});

control(
  'a schema differing in value is refused, by name',
  1,
  ({ root }) => {
    const path = pkg(root, 'satori-beta', 'schema/manifest.schema.json');
    const schema = JSON.parse(readFileSync(path, 'utf8'));
    schema.title = 'edited here';
    writeFileSync(path, JSON.stringify(schema, null, 2));
  },
  ['config-packages/satori-beta/schema/manifest.schema.json differs'],
);

control(
  'a missing owned file is refused',
  1,
  ({ root }) => rmSync(pkg(root, 'presales-demo', 'schema/bootstrap.schema.json')),
  ['presales-demo/schema/bootstrap.schema.json is missing'],
);

control(
  'a template carrying an EJS tag is refused rather than compared',
  1,
  ({ templates }) => appendFileSync(join(templates, 'build.mjs__tmpl__'), '\n// <%= name %>\n'),
  ['EJS tag'],
);

control(
  'no packages at all is not a pass',
  1,
  ({ root }) => rmSync(join(root, 'config-packages'), { recursive: true, force: true }),
  ['compared nothing'],
);

control('--refresh restores a drifted copy, and the check then passes', 0, (tree) => {
  appendFileSync(pkg(tree.root, 'presales-demo', 'build.mjs'), '\n// local edit\n');
  const refreshed = run(tree, '--refresh');
  if (refreshed.code !== 0 || !refreshed.out.includes('updated  config-packages/presales-demo/build.mjs')) {
    throw new Error(`--refresh did not restore the copy: exit ${refreshed.code}\n${refreshed.out}`);
  }
});

let failed = 0;
for (const { name, ok, detail } of results) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} — ${name}`);
  if (!ok) {
    failed += 1;
    console.log(detail.replace(/^/gm, '        '));
  }
}
console.log(`\ncheck-platform-sync: ${failed === 0 ? 'pass' : 'FAIL'} — ${results.length} controls, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
