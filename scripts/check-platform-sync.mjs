#!/usr/bin/env node
/**
 * Keep each package's platform-owned files in step with the Nuxeo Satori UI generator.
 *
 *   node scripts/check-platform-sync.mjs                       compare against platform-ref.txt
 *   node scripts/check-platform-sync.mjs --ref main            compare against another ref
 *   node scripts/check-platform-sync.mjs --refresh [--ref main]  rewrite the files, and the pin
 *
 * Testing only: `--root <dir>` checks another tree, `--templates <dir>` reads the templates from a
 * directory laid out like the generator's `files/` instead of fetching them.
 *
 * ## Why this exists
 *
 * Three files in every package are not this repository's to edit: `build.mjs` and the two JSON
 * schemas under `schema/`. They are written by the `config-package` generator in Nuxeo Satori UI
 * (`tools/satori-generators/src/config-package/files/`), and `build.mjs` in particular is not glue:
 * it applies around 25 checks that mirror what the server does in nuxeo-agentic-core, so that a
 * package which builds is a package the server will apply. When the platform fixes one of those
 * checks — the JSON nesting limit in NXSAT-730, the Windows Node 20 stack limit after it — the fix
 * lands in the generator template and nowhere else.
 *
 * While these packages lived in Nuxeo Satori UI, `check-build-mjs-copies.mjs` there compared them
 * with the template on every pull request. That check cannot see this repository, so without this
 * one a package here would keep the old validator indefinitely and nothing would say so.
 *
 * ## How it compares
 *
 * Against a **pinned** commit of Nuxeo Satori UI, in `platform-ref.txt`, so that a pull request
 * here is judged against a fixed reference: a change somebody makes to the platform cannot turn an
 * unrelated pull request here red. Staleness of the pin is a separate question, asked by the weekly
 * `platform-drift` job with `--ref main`.
 *
 * `build.mjs` by bytes. That is only correct while the template carries no EJS tag — the generator
 * renders it, so a tag would make the written file differ from the template on purpose — so a tag
 * is refused rather than compared, with that reason.
 *
 * The schemas by parsed value. Nuxeo Satori UI formats committed JSON with Prettier and does not
 * format the `__tmpl__` files, so the copies it made differ from their template in whitespace
 * alone. A byte comparison would be red from the first run for a reason that means nothing, and a
 * check that is always red teaches people to ignore it.
 *
 * Exit 0 in step, 1 out of step or not checkable, 2 for a bad command line. A template that cannot
 * be fetched is exit 1: an unreachable reference is not a pass.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const PLATFORM_REPO = 'nuxeo/Nuxeo-Satori-UI';
const TEMPLATE_DIR = 'tools/satori-generators/src/config-package/files';

/** The files a package carries that the platform owns, and how each is compared. */
const OWNED = [
  { file: 'build.mjs', compare: 'bytes' },
  { file: 'schema/bootstrap.schema.json', compare: 'json' },
  { file: 'schema/manifest.schema.json', compare: 'json' },
];

const SHA = /^[0-9a-f]{40}$/;

function usage(message) {
  console.error(message);
  console.error(
    'usage: node scripts/check-platform-sync.mjs [--ref <ref>] [--refresh] [--root <dir>] [--templates <dir>]',
  );
  process.exit(2);
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      ref: { type: 'string' },
      refresh: { type: 'boolean', default: false },
      root: { type: 'string' },
      templates: { type: 'string' },
    },
    strict: true,
  }));
} catch (error) {
  usage(error.message);
}

const root = resolve(options.root ?? process.cwd());
const pinFile = join(root, 'platform-ref.txt');

/** Sorted recursively, so two values that differ only in key order or whitespace compare equal. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function packages() {
  const dir = join(root, 'config-packages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'build.mjs')))
    .map((entry) => entry.name)
    .sort();
}

function githubHeaders(accept) {
  const headers = { accept, 'user-agent': 'nuxeo-satori-config-sync' };
  // Optional. The platform repository is public, so this only raises the rate limit.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function resolveRef(ref) {
  if (SHA.test(ref)) return ref;
  const response = await fetch(
    `https://api.github.com/repos/${PLATFORM_REPO}/commits/${encodeURIComponent(ref)}`,
    { headers: githubHeaders('application/vnd.github.sha') },
  );
  if (!response.ok) throw new Error(`cannot resolve ${PLATFORM_REPO}@${ref}: HTTP ${response.status}`);
  const sha = (await response.text()).trim();
  if (!SHA.test(sha)) throw new Error(`${PLATFORM_REPO}@${ref} resolved to "${sha}", not a commit`);
  return sha;
}

async function readTemplate(sha, file) {
  if (options.templates) {
    const path = join(resolve(options.templates), `${file}__tmpl__`);
    if (!existsSync(path)) throw new Error(`no template at ${path}`);
    return readFileSync(path);
  }
  const url = `https://raw.githubusercontent.com/${PLATFORM_REPO}/${sha}/${TEMPLATE_DIR}/${file}__tmpl__`;
  const response = await fetch(url, { headers: githubHeaders('application/octet-stream') });
  if (!response.ok) throw new Error(`cannot fetch ${file} at ${sha.slice(0, 9)}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function differs(compare, actual, expected) {
  if (compare === 'bytes') return !actual.equals(expected);
  try {
    return (
      JSON.stringify(canonical(JSON.parse(actual.toString('utf8')))) !==
      JSON.stringify(canonical(JSON.parse(expected.toString('utf8'))))
    );
  } catch {
    // A copy that does not parse is out of step by definition: the template does.
    return true;
  }
}

async function main() {
  const names = packages();
  if (names.length === 0) {
    console.error('no config-packages/*/build.mjs found, so this compared nothing');
    process.exit(1);
  }

  let sha;
  if (options.templates) {
    sha = 'local-templates';
  } else if (options.ref) {
    sha = await resolveRef(options.ref);
  } else {
    if (!existsSync(pinFile)) {
      console.error(`${pinFile} is missing; it pins the Nuxeo Satori UI commit to compare with`);
      process.exit(1);
    }
    sha = readFileSync(pinFile, 'utf8').trim();
    if (!SHA.test(sha)) {
      console.error(`platform-ref.txt holds "${sha}", which is not a 40-character commit SHA`);
      process.exit(1);
    }
  }

  const templates = new Map();
  for (const { file } of OWNED) {
    const body = await readTemplate(sha, file);
    if (file.endsWith('.mjs') && body.toString('utf8').includes('<%')) {
      console.error(
        `the ${file} template at ${sha.slice(0, 9)} carries an EJS tag, so the generator renders it and ` +
          'a byte comparison is the wrong question. Teach this check to render the template first.',
      );
      process.exit(1);
    }
    templates.set(file, body);
  }

  if (options.refresh) {
    let changed = 0;
    for (const name of names) {
      for (const { file, compare } of OWNED) {
        const path = join(root, 'config-packages', name, file);
        const current = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
        if (differs(compare, current, templates.get(file))) {
          writeFileSync(path, templates.get(file));
          console.log(`  updated  config-packages/${name}/${file}`);
          changed += 1;
        }
      }
    }
    if (!options.templates) writeFileSync(pinFile, `${sha}\n`);
    console.log(
      `${changed} file(s) refreshed from ${PLATFORM_REPO}@${sha.slice(0, 9)}` +
        (options.templates ? '' : '; platform-ref.txt now pins it'),
    );
    return;
  }

  const drift = [];
  for (const name of names) {
    for (const { file, compare } of OWNED) {
      const path = join(root, 'config-packages', name, file);
      if (!existsSync(path)) {
        drift.push(`config-packages/${name}/${file} is missing`);
      } else if (differs(compare, readFileSync(path), templates.get(file))) {
        drift.push(`config-packages/${name}/${file} differs from the platform template`);
      }
    }
  }

  const against = options.templates ? 'the local templates' : `${PLATFORM_REPO}@${sha.slice(0, 9)}`;
  if (drift.length === 0) {
    console.log(`${names.length} package(s) in step with ${against}: ${names.join(', ')}`);
    return;
  }

  for (const line of drift) console.error(`  ${line}`);
  if (options.ref && !options.templates) {
    console.error(
      `\nThe platform has moved since platform-ref.txt. These files are owned by Nuxeo Satori UI, so\n` +
        `bring them up to date rather than editing them:\n\n` +
        `  node scripts/check-platform-sync.mjs --refresh --ref ${options.ref}\n\n` +
        `then open a pull request with the result.`,
    );
  } else {
    console.error(
      `\nOut of step with ${against}. These files are owned by Nuxeo Satori UI and are not edited in\n` +
        `this repository. Restore them with:\n\n  node scripts/check-platform-sync.mjs --refresh\n`,
    );
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
