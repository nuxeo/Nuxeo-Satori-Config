#!/usr/bin/env node
/**
 * Controls for `check-deployable.mjs`: break each rule in a scratch copy of the real packages and
 * require the check to go red for that reason, and keep the forms that must stay green, green.
 *
 * A control that throws is reported as that control's failure rather than ending the run, so one
 * broken fixture cannot hide the verdicts of the controls after it.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(repo, 'scripts', 'check-deployable.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deployable-'));
  for (const name of ['presales-demo', 'satori-beta']) {
    cpSync(join(repo, 'config-packages', name), join(root, 'config-packages', name), {
      recursive: true,
      filter: (src) => !src.includes(`${name}/dist`),
    });
  }
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function edit(path, change) {
  writeFileSync(path, change(readFileSync(path, 'utf8')));
}

const beta = (root, file) => join(root, 'config-packages', 'satori-beta', file);
const results = [];

function control(name, expectCode, setup, mustMention = []) {
  let root;
  try {
    root = fixture();
    setup(root);
    const { code, out } = run(root);
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
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

control('pristine packages are deployable', 0, () => {});

control(
  'install.xml switching the dev override on is refused',
  1,
  (root) =>
    edit(beta(root, 'package/install.xml'), (xml) =>
      xml.replace('</install>', '  <config append="true">nuxeo.agentic.ui.config.dev=true</config>\n</install>'),
    ),
  ['install.xml:', 'nuxeo.agentic.ui.config.dev=true'],
);

control('a commented-out enabling line stays green', 0, (root) =>
  edit(beta(root, 'package/install.xml'), (xml) =>
    xml.replace('</install>', '  <!-- nuxeo.agentic.ui.config.dev=true -->\n</install>'),
  ),
);

control('the enabling line in Markdown stays green', 0, (root) =>
  edit(beta(root, 'README.md'), (md) => `${md}\n    nuxeo.agentic.ui.config.dev=true\n`),
);

control(
  'shipping the override directory is refused',
  1,
  (root) => {
    const dir = beta(root, 'bundle/agentic-ui-config-dev');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bootstrap.json'), '{}\n');
  },
  ['agentic-ui-config-dev'],
);

control(
  'a misspelt bootstrap key is refused',
  1,
  (root) =>
    edit(beta(root, 'bundle/agentic-ui-config/bootstrap.json'), (json) => {
      const value = JSON.parse(json);
      value.brandings = { applicationTitle: 'typo' };
      return JSON.stringify(value, null, 2);
    }),
  ['"brandings"'],
);

control(
  'a misspelt key inside a presales preset is refused',
  1,
  (root) =>
    edit(beta(root, 'bundle/agentic-ui-config/bootstrap.json'), (json) => {
      const value = JSON.parse(json);
      value.presales.presets.claims.bootstrap.defaultTheme = 'acme';
      return JSON.stringify(value, null, 2);
    }),
  ['preset "claims".bootstrap', '"defaultTheme"'],
);

control(
  'a misspelt manifest key is refused',
  1,
  (root) =>
    edit(beta(root, 'bundle/agentic-ui-config/manifest.json'), (json) => {
      const value = JSON.parse(json);
      value.label = { 'nav.item.tasks': 'typo' };
      return JSON.stringify(value, null, 2);
    }),
  ['"label"'],
);

control(
  'an inert manifest key warns without failing',
  0,
  (root) =>
    edit(beta(root, 'bundle/agentic-ui-config/manifest.json'), (json) => {
      const value = JSON.parse(json);
      value.navItems = [];
      return JSON.stringify(value, null, 2);
    }),
  ['warning', '"navItems"'],
);

control(
  'satori-beta losing the hosted Beta viewer is refused',
  1,
  (root) =>
    edit(beta(root, 'bundle/agentic-ui-config/bootstrap.json'), (json) => {
      const value = JSON.parse(json);
      delete value.integrations;
      return JSON.stringify(value, null, 2);
    }),
  ['viewerOrigin', 'NXSAT-301'],
);

control(
  'a near-miss viewer origin is refused, not just a missing one',
  1,
  (root) =>
    edit(beta(root, 'bundle/agentic-ui-config/bootstrap.json'), (json) =>
      json.replace('"https://nev-satori.beta.nuxeocloud.com"', '"https://nev-satori.beta.nuxeocloud.com/viewer"'),
    ),
  ['viewerOrigin', '/viewer'],
);

control(
  'no packages at all is not a pass',
  1,
  (root) => rmSync(join(root, 'config-packages'), { recursive: true, force: true }),
  ['checked nothing'],
);

let failed = 0;
for (const { name, ok, detail } of results) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} — ${name}`);
  if (!ok) {
    failed += 1;
    console.log(detail.replace(/^/gm, '        '));
  }
}
console.log(`\ncheck-deployable: ${failed === 0 ? 'pass' : 'FAIL'} — ${results.length} controls, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
