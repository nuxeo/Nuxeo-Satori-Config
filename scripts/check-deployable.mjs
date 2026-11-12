#!/usr/bin/env node
/**
 * Refuse a configuration package that would be unsafe, or silently inert, once installed.
 *
 *   node scripts/check-deployable.mjs [--root <dir>] [--package <name>]
 *
 * `build.mjs` checks what the server checks. These are the things the server does *not* check,
 * and that Nuxeo Satori UI guarded for these packages while they lived there. Each was ported when
 * the packages moved, because none of them can see this repository from where it was:
 *
 * 1. **Nothing switches the development override on.** `nuxeo.agentic.ui.config.dev=true` makes
 *    the configuration servlet read a directory on every request, which turns configuration —
 *    meant to need the privilege of deploying code — into something editable from the server's
 *    filesystem. A Marketplace package's `install.xml` can append `nuxeo.conf` lines, so a package
 *    is exactly where this could be switched on. Commented-out lines are allowed, and Markdown is
 *    out of scope: no server reads a `.md` file. Ported from `review-guardrails.mjs`,
 *    `checkDevConfigOverrideIsNotProductionReachable`, check 1.
 * 2. **Nothing ships the override directory.** If `agentic-ui-config-dev` is installed, "off
 *    because there is nothing there" becomes the only thing standing in the way. Same guardrail,
 *    check 3.
 * 3. **Every fragment key is one the application reads.** The application ignores an unknown
 *    top-level key without a word, so `brandings` or `sessions` reads as a customisation that did
 *    not work. Checked against the package's own schema, including inside presales presets.
 *    Generalised from `satori-beta-fragment.spec.ts`, which asked it of one package.
 * 4. **satori-beta keeps the hosted Beta's annotation viewer.** That package is what the hosted
 *    Beta deploys, and the only place the browser is told where its Nuxeo Enhanced Viewer is. When
 *    it named none, the Annotations tab said annotations were unavailable beside a healthy viewer
 *    (NXSAT-301). Ported from `satori-beta-fragment.spec.ts`.
 *
 * Keys the schema accepts but that nothing in the application reads — `navItems`, `actions`,
 * `rules` and `presets` at the top of a manifest, as of the pinned platform commit — are reported
 * as warnings, not failures: they are inert today, and refusing them would be stricter than the
 * platform.
 *
 * Exit 0 when deployable, 1 when not or when nothing was checked, 2 for a bad command line.
 * `check-deployable.selftest.mjs` breaks each rule in a scratch tree and requires this to go red.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const DEV_PROPERTY = 'nuxeo.agentic.ui.config.dev';
const DEV_ENABLED = /nuxeo\.agentic\.ui\.config\.dev\s*[=:]\s*["']?true/i;
const COMMENT = /^\s*(?:#|\/\/|<!--|\*)/;
const DEV_DIRECTORY = 'agentic-ui-config-dev';

const BETA_PACKAGE = 'satori-beta';
const BETA_VIEWER_ORIGIN = 'https://nev-satori.beta.nuxeocloud.com';

/** Accepted by the manifest schema, read by nothing in the application at the pinned commit. */
const INERT_MANIFEST_KEYS = ['navItems', 'actions', 'rules', 'presets'];

let options;
try {
  ({ values: options } = parseArgs({
    options: { root: { type: 'string' }, package: { type: 'string' } },
    strict: true,
  }));
} catch (error) {
  console.error(error.message);
  console.error('usage: node scripts/check-deployable.mjs [--root <dir>] [--package <name>]');
  process.exit(2);
}

const root = resolve(options.root ?? process.cwd());
const failures = [];
const warnings = [];
const rel = (path) => relative(root, path).split('\\').join('/');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'dist' || entry === 'node_modules' || entry === '.git') continue;
    const path = join(dir, entry);
    acc.push(path);
    if (statSync(path).isDirectory()) walk(path, acc);
  }
  return acc;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    failures.push(`${label}: cannot be read as JSON (${error.message})`);
    return null;
  }
}

function propertiesOf(schema, pointer) {
  let node = schema;
  for (const part of pointer) node = node?.[part];
  return node && typeof node === 'object' ? Object.keys(node) : null;
}

function unknownKeys(value, allowed, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      failures.push(`${where}: "${key}" is not a key the application reads, so it would be ignored in silence`);
    }
  }
}

/** The `<fragment layer=… src=…>` entries of a component XML, attributes in either order. */
function fragmentsOf(xml) {
  const found = [];
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of withoutComments.matchAll(/<fragment\b[^>]*>/g)) {
    const layer = /\blayer\s*=\s*"([^"]*)"/.exec(tag[0])?.[1];
    const src = /\bsrc\s*=\s*"([^"]*)"/.exec(tag[0])?.[1];
    if (layer && src) found.push({ layer, src });
  }
  return found;
}

function checkPackage(name) {
  const dir = join(root, 'config-packages', name);
  const files = walk(dir);

  for (const path of files) {
    // 2. The override directory, anywhere in the package.
    if (path.includes(DEV_DIRECTORY)) {
      failures.push(`${rel(path)} ships the development override directory "${DEV_DIRECTORY}"`);
    }
    // 1. The property, switched on, in anything a server could read.
    if (statSync(path).isDirectory() || /\.mdx?$/i.test(path)) continue;
    const body = readFileSync(path);
    if (body.includes(0)) continue; // binary: cannot carry a property line a server reads
    const text = body.toString('utf8');
    if (!text.includes(DEV_PROPERTY)) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (COMMENT.test(line) || !DEV_ENABLED.test(line)) return;
      failures.push(`${rel(path)}:${index + 1} sets ${DEV_PROPERTY}=true: ${line.trim()}`);
    });
  }

  // 3. Fragment keys against the package's own schema.
  const bootstrapSchema = readJson(join(dir, 'schema/bootstrap.schema.json'), `${name}/schema/bootstrap.schema.json`);
  const manifestSchema = readJson(join(dir, 'schema/manifest.schema.json'), `${name}/schema/manifest.schema.json`);
  const bootstrapKeys = bootstrapSchema && propertiesOf(bootstrapSchema, ['properties']);
  const overlayKeys = bootstrapSchema && propertiesOf(bootstrapSchema, ['definitions', 'overlay', 'properties']);
  const manifestKeys = manifestSchema && propertiesOf(manifestSchema, ['properties']);

  const componentDir = join(dir, 'bundle', 'OSGI-INF');
  const fragments = existsSync(componentDir)
    ? readdirSync(componentDir)
        .filter((file) => file.endsWith('.xml'))
        .flatMap((file) => fragmentsOf(readFileSync(join(componentDir, file), 'utf8')))
    : [];
  if (fragments.length === 0) {
    failures.push(`config-packages/${name}: its component XML declares no <fragment>, so nothing was checked`);
  }

  for (const { layer, src } of fragments) {
    const label = `config-packages/${name}/bundle/${src}`;
    const fragment = readJson(join(dir, 'bundle', src), label);
    if (!fragment) continue;
    if (layer === 'bootstrap' && bootstrapKeys) {
      unknownKeys(fragment, bootstrapKeys, label);
      for (const [preset, body] of Object.entries(fragment.presales?.presets ?? {})) {
        if (overlayKeys) unknownKeys(body?.bootstrap, overlayKeys, `${label} preset "${preset}".bootstrap`);
        if (manifestKeys) unknownKeys(body?.manifest, manifestKeys, `${label} preset "${preset}".manifest`);
      }
    } else if (layer === 'manifest' && manifestKeys) {
      unknownKeys(fragment, manifestKeys, label);
      for (const key of INERT_MANIFEST_KEYS) {
        if (key in fragment) {
          warnings.push(`${label}: "${key}" is accepted but nothing in the application reads it, so it has no effect`);
        }
      }
    }
  }

  // 4. The hosted Beta's viewer.
  if (name === BETA_PACKAGE) {
    const bootstrap = fragments.find((f) => f.layer === 'bootstrap');
    const fragment = bootstrap && readJson(join(dir, 'bundle', bootstrap.src), `${name} bootstrap`);
    const origin = fragment?.integrations?.arender?.viewerOrigin;
    // An exact match, deliberately. The original spec also asserted the origin was a bare https
    // origin — ARenderService refuses a base with a path, query or credentials — but once the value
    // must equal this constant, that assertion can only ever pass, so it is not repeated here. The
    // constant itself is the thing to get right, in review, when the viewer moves.
    if (origin !== BETA_VIEWER_ORIGIN) {
      failures.push(
        `config-packages/${name}: integrations.arender.viewerOrigin is ${JSON.stringify(origin ?? null)}, ` +
          `not ${BETA_VIEWER_ORIGIN}. This package is what the hosted Beta deploys; without it the ` +
          'Annotations tab is off beside a healthy viewer (NXSAT-301). If the viewer moved, change ' +
          'BETA_VIEWER_ORIGIN here in the same pull request.',
      );
    }
  }
}

const all = existsSync(join(root, 'config-packages'))
  ? readdirSync(join(root, 'config-packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, 'config-packages', entry.name, 'build.mjs')))
      .map((entry) => entry.name)
      .sort()
  : [];
const selected = options.package ? all.filter((name) => name === options.package) : all;

if (options.package && selected.length === 0) {
  console.error(`config-packages/${options.package}/build.mjs does not exist`);
  process.exit(1);
}
if (selected.length === 0) {
  console.error('no config-packages/*/build.mjs found, so this checked nothing');
  process.exit(1);
}
if (!options.package && !all.includes(BETA_PACKAGE)) {
  failures.push(
    `config-packages/${BETA_PACKAGE} is missing, so check 4 asserted nothing. If it was renamed, ` +
      'rename BETA_PACKAGE here; if the hosted Beta no longer deploys from this repository, remove check 4.',
  );
}

for (const name of selected) checkPackage(name);

for (const line of warnings) console.warn(`  warning  ${line}`);
if (failures.length > 0) {
  for (const line of failures) console.error(`  FAIL  ${line}`);
  process.exit(1);
}
console.log(`${selected.length} package(s) deployable: ${selected.join(', ')}`);
