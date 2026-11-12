# Nuxeo Satori configuration packages

Marketplace packages that rebrand and reshape [Nuxeo Satori UI](https://github.com/nuxeo/Nuxeo-Satori-UI)
**without a rebuild of the application**: the product name, logo, favicon and colours, the
languages offered, navigation entries, columns, toolbar actions and tabs, per-type property
layouts, sign-in buttons, session timeouts, and presales presets switched with `?preset=<name>`.

This repository holds configuration only — JSON, SVG and XML. Nothing here is compiled, nothing
needs installing, and you do not need access to the application's source to change it.

| Package | What it is |
| --- | --- |
| [`presales-demo`](config-packages/presales-demo/) | Demo presets — `?preset=insurance`, `?preset=logistics` |
| [`satori-beta`](config-packages/satori-beta/) | What the hosted Beta deploys, plus a full test set of customisations |

## Change a package

Everything a package does is in `config-packages/<name>/bundle/agentic-ui-config/`:

- `bootstrap.json` — branding, themes, languages, session, sign-in, presets (Layer 0)
- `manifest.json` — labels, feature toggles, and what the application shows (Layer 1)
- `assets/` — images, each declared as an `<asset>` in `bundle/OSGI-INF/*-config.xml`
- `layouts/` — per-type property layouts, each declared as a `<layout>` in the same XML

Every key, every registered ID and what each one does is in the
[extension reference](https://github.com/nuxeo/Nuxeo-Satori-UI/blob/main/docs/extension-reference.md).
The `schema/` files give your editor completion and catch a misspelt key as you type.

**This repository is public.** Use fictional companies only — Acme, Globex — and never a real
prospect's or customer's name, logo, colours or URL. That a prospect is being pitched is itself
confidential. To demo a named prospect, put their branding on that demo server through the
development override directory, which never leaves the server: see
[The fast loop while you are tuning a value](config-packages/presales-demo/README.md#the-fast-loop-while-you-are-tuning-a-value).

**Nothing here is secret-safe either.** The configuration is served to the browser without
authentication, before sign-in. Never put a password, token or private URL in a package.

## Build and check it

You need Node 20 or newer, and nothing else.

```bash
node config-packages/presales-demo/build.mjs     # writes config-packages/presales-demo/dist/<name>-<version>.zip
node scripts/check-deployable.mjs                # what the server does not check — see below
node scripts/check-platform-sync.mjs             # the platform-owned files are up to date
```

`build.mjs` refuses anything the server would refuse, with the file and the reason, so a package
that builds is a package that applies. `check-deployable.mjs` refuses what the server would accept
and then get wrong: switching the development override on, a key the application ignores in
silence (a typo like `brandings`), and `satori-beta` losing the hosted Beta's annotation viewer.

The same three run on every pull request.

## Publish it to the Marketplace

**Actions → Publish Configuration Package → Run workflow.** Choose the branch, type the package
directory name, and tick *Publish to Nuxeo Marketplace preprod*. Leave it unticked to build and
download the zip without publishing.

You never edit the version to publish. `package.xml` holds the **base** version, and every
publish is stamped `<base>-<timestamp>-BUILD-<run>`, so two publishes never collide. Bump the base
only when you mean something by it, such as `1.1.0` to `2.0.0` for a rebrand.

## Add a package

Copy an existing one and rename it everywhere it is named: the directory, `name` in
`package/package.xml`, `Bundle-Name` and `Bundle-SymbolicName` in `bundle/META-INF/MANIFEST.MF`,
the component XML file and its `name`, and the `name` of each `<fragment>` in it. Miss the last one
and the copy's fragments share a name with the original's, so installing both makes one replace
the other. Or scaffold a fresh one from a Nuxeo Satori UI checkout, run from this repository's root:

```bash
node <path-to>/Nuxeo-Satori-UI/tools/satori-generators/src/config-package/create.mjs acme-config --owner=acme
```

The generator refuses names the platform reserves, such as `defaults` and `nuxeo-agentic-ui`.

## Three files you do not edit

`build.mjs`, `schema/bootstrap.schema.json` and `schema/manifest.schema.json` in every package
belong to Nuxeo Satori UI. `build.mjs` mirrors around 25 checks the server makes, and when the
platform fixes one, the fix arrives in its generator — not here. So:

- CI compares them with the Nuxeo Satori UI commit pinned in [`platform-ref.txt`](platform-ref.txt)
  and goes red if one was edited.
- A **weekly job** compares them with Nuxeo Satori UI `main`. When it goes red, refresh rather
  than edit, and open a pull request with the result:

  ```bash
  node scripts/check-platform-sync.mjs --refresh --ref main
  ```

## Repository setup

Publishing needs two secrets on this repository, or access to organisation secrets of these
names: `CONNECT_PREPROD_USERNAME` and `CONNECT_PREPROD_PASSWORD`.

## History

Until November 2026 these packages lived in Nuxeo Satori UI under `config-packages/`. Their
history before the move is there: the last commit to carry them is
[`727d0f2`](https://github.com/nuxeo/Nuxeo-Satori-UI/tree/727d0f283fa59abd2ab165ac38f3a8110343e8fc/config-packages).
