# Contributing

Thanks for your interest. The project is young, so open an issue before you start on anything big.
Keep changes small and focused, and keep the checks below green.

## Local setup

- Node.js 24. `.nvmrc` names it, so `nvm use` picks it. The tooling needs Node.js 22.22 or newer, and
  the published package runs on Node.js 20.19 or newer.
- [pnpm](https://pnpm.io). The `packageManager` field of `package.json` pins the version.
- TradingView Desktop, only for the end-to-end tests and for trying your changes on the real app.

```sh
pnpm install   # also installs the Git hooks
pnpm build     # the integration tests start the built CLI, so build before you run them
```

## Scripts

Run them from the repository root.

| Script                                             | What it does                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                        | ESLint, with type-aware rules for the TypeScript                                                        |
| `pnpm format`                                      | Prettier, rewriting the files                                                                           |
| `pnpm typecheck`                                   | `tsc --noEmit`                                                                                          |
| `pnpm build`                                       | Builds the dashboard, then the server: tsup bundles `dist/`, and the page is copied to `dist/dashboard` |
| `pnpm test`                                        | Unit and integration tests                                                                              |
| `pnpm test:unit`, `test:integration`               | One of the two levels                                                                                   |
| `pnpm test:e2e`                                    | End-to-end tests against the real app, local only (see below)                                           |
| `pnpm test:e2e:dashboard`                          | The dashboard's Playwright tests (mocked); needs the dashboard's build and Chromium                     |
| `pnpm test:coverage`                               | Unit and integration tests with coverage, failing under 80% on any metric                               |
| `pnpm dev:dashboard`                               | The dashboard on Vite's dev server with hot reload (see below)                                          |
| `pnpm re:probe`, `pnpm re:record`                  | Read-only probes and the fixture recorder for the real app                                              |
| `pnpm docs:tools`, `docs:examples`, `docs:clients` | Regenerate the generated documents (see "Generated docs"); a test checks each                           |
| `node scripts/smoke-node20.mjs`                    | Starts the built CLI over stdio and over HTTP; run after `pnpm build`                                   |

Before you push, run the whole gate:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:coverage
```

## The dashboard

The web dashboard lives in `packages/dashboard` (React, Vite, Tailwind and shadcn components). The
package is private and is not published: every dependency in it is a devDependency, because
`pnpm build` bundles the page into the server and the published package gains no runtime
dependency.

To work on it with hot reload, start the server with a token and the dashboard on, then the dev
server beside it:

```sh
TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" node packages/server/dist/cli.js --transport http
pnpm dev:dashboard   # in a second terminal; open the address Vite prints
```

Vite hands `/api` and `/healthz` to the server on `TV_MCP_HTTP_PORT` (8787 by default). The server
refuses a request whose `Host` or `Origin` is not its own, so the proxy rewrites the `Host`, and the
`Origin` of the dev page or of a request without one; the `Origin` of any other page goes on as it
is, for the server to refuse. Open the
dev page, paste the token on the token screen, or open it once as `#token=<token>`.

To add a shadcn component, use the pinned CLI from `packages/dashboard`:

```sh
pnpm dlx shadcn@4.22.1 add <component>
```

Then point what it generated back at our own code, by hand:

- import `cn` from `@/lib/utils`, not from a `cn` package;
- remove any import of `shadcn/tailwind.css`, which we do not install;
- put the variants and utilities it needs in `src/styles/shadcn.css`.

Components under `src/components/ui/` are vendored, so they are not counted in the
coverage. The screenshots of the README come from `pnpm --filter
tradingview-desktop-mcp-dashboard docs:screenshots`; see [docs/testing.md](docs/testing.md).

## Tests

There are three levels, described in [docs/testing.md](docs/testing.md):

- **Unit** tests use fakes and open no socket, apart from the tests of the fake debug-port server,
  which listen on the loopback address.
- **Integration** tests start the real server and talk to it with MCP clients, against a fake
  debug-port server and a fake TradingView window. They refuse to run against a build older than
  the sources, so run `pnpm build` first.
- **End-to-end** tests drive the TradingView Desktop on your machine. They run only on request
  (`TV_E2E=1 pnpm test:e2e`), never in CI. They change the chart and put it back, create and
  remove drawings, an alert, a watchlist symbol and a tab of their own, and run bar replay, as
  [Safety rules](docs/testing.md#safety-rules) and
  [What a run may leave behind, when allowed](docs/testing.md#what-a-run-may-leave-behind-when-allowed)
  describe, so read both before you run them or add a suite.

Code in `packages/server/src` needs at least 80% coverage on lines, branches, functions and
statements, counting the unit and integration tests together. So does `packages/dashboard/src`,
apart from the generated components. The dashboard also has unit tests and Playwright end-to-end
tests, which [docs/testing.md](docs/testing.md#dashboard-tests) describes.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), and commitlint
checks them: `type(scope): subject`, with a type such as `feat`, `fix`, `docs`, `test`, `refactor`,
`perf`, `build`, `ci` or `chore`, a lower-case subject without a full stop, and no line longer than
100 characters. Make small, atomic commits.

Two Git hooks, installed by `pnpm install`, run on every commit:

- `pre-commit` runs ESLint (fixing what it can) and Prettier on the staged files.
- `commit-msg` runs commitlint.

Do not skip them with `--no-verify`. When a hook fails, fix what it reports.

## Code conventions

- TypeScript in strict mode, ESM only, and no `any`.
- Comments, documentation, logs, errors, CLI output and test names are in English. A comment says
  why, not what.
- In stdio mode stdout carries only MCP messages. Log through the logger, which writes to stderr,
  and never call `console` in `packages/server/src`.
- A tool name is `snake_case` and starts with its domain, and every input has a Zod schema whose
  fields carry `.describe()` text.
- A committed fixture holds no personal data and only synthetic prices.
- The server only automates the local, logged-in app. It does not work around logins, paywalls or
  plan limits, and it does not call TradingView's servers. The debug port host must be loopback,
  and TradingView is never started with `--options=clean` or `--remote-debugging-address`.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push of a branch and every pull
request; a pushed tag starts the release workflow instead, which runs the same gate. The `verify`
job installs with the frozen lockfile, then lints, type-checks and builds. It packs the package from
that build and checks the tarball against an allowlist of files (no source maps, no dotfiles under
`dist/`, nothing outside `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md` and `dist/`), then
runs the unit and integration tests and checks the coverage. After it, the `runtime-node20` job
installs that tarball into an empty directory on Node.js 20.19, runs the installed bin with
`--version` and runs `scripts/smoke-node20.mjs` against it, so that the package a user installs is
proven on the oldest runtime it supports. The `dashboard-e2e` job, also after `verify`, builds
everything and runs the dashboard's Playwright tests in Chromium twice: against a mock server, and
against the built CLI with the fake TradingView of the tests. The run against your own TradingView
(`TV_E2E=1`) stays local only.

Maintainers: the coverage report goes to Codecov, which needs the repository enabled on
[codecov.io](https://codecov.io). Add the upload token as the `CODECOV_TOKEN` repository secret. The
upload never fails a run, so a missing token only leaves the coverage badge empty.

## Generated docs

Three documents are generated from the code, and a test fails when one is stale. Run the command
after you change what it reads, and commit the result:

| Command              | Regenerates                              | Run it after you change                                                        |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm docs:tools`    | `docs/tools.md`, the tool reference      | a tool, its description, inputs, annotations or profile                        |
| `pnpm docs:examples` | `docs/examples.md`, the usage examples   | a tool the scenarios call, or the scenarios in `packages/server/scripts/docs/` |
| `pnpm docs:clients`  | the config blocks of `docs/clients/*.md` | the output of `config <client>`, or the client list                            |

`pnpm --filter tradingview-desktop-mcp-dashboard docs:screenshots` rewrites the dashboard images of
the README in `docs/images/` from the mock server. Run it after a visible change to the dashboard;
no test checks the images. Edit the text of the tutorials by hand: `docs:clients` leaves everything
outside the markers alone.

## Releasing

The maintainer makes the release; contributors do not tag. The workflow
[`.github/workflows/release.yml`](.github/workflows/release.yml) runs only when a tag of the form
`vX.Y.Z` is pushed, and nothing else starts it.

1. Set `version` in `packages/server/package.json`, and date the section of that version in
   `CHANGELOG.md` (`## [X.Y.Z] - YYYY-MM-DD`). Its text becomes the notes of the GitHub release.
2. Merge that to `main`.
3. Tag the commit on `main` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The workflow refuses the tag, before it builds anything, when it is not a plain `vX.Y.Z` (no
prerelease), when it does not name the version of the package, when its commit is not on `main`,
when `CHANGELOG.md` has no dated section for the version, or when npm has the version already. It
then runs the whole of `ci.yml`, including the tarball check and the install on Node.js 20.19, and
publishes the tarball that the gate checked, in the job `publish`, which uses the GitHub environment
`npm`. The last job creates the GitHub release. If that job alone fails, re-run the failed jobs: a
new run would stop at the check, because npm has the version.

### npm authentication

The workflow publishes with [trusted publishing](https://docs.npmjs.com/trusted-publishers), which
needs no token: npm exchanges the OIDC token of the run and adds provenance by itself.

A trusted publisher can only be linked to a package that exists
([`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)), so the first publish, 0.1.0,
cannot use it:

1. Store a token for the first publish:
   - Create the `npm` environment first: in the repository on GitHub, Settings → Environments → New
     environment, name it `npm` and select Configure environment
     ([Managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
     Only then can `NPM_TOKEN` be stored as a secret of that environment (Environment secrets → Add
     secret), which only the publish job, the one job that uses the environment, can read. A
     repository secret also works, but then every job can read it.
   - Create the token on npmjs.com as a granular access token (Access Tokens → Generate New Token,
     [Creating and viewing access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens)).
     Tick "Bypass two-factor authentication", and under "Packages and scopes" set the permissions to
     "Read and write (publish and stage)", or it cannot publish from CI.
   - A package that does not exist yet cannot be picked under "Only select packages and scopes", so
     this first token needs "All Packages". `tradingview-desktop-mcp` has no scope that could be
     picked instead.
   - The workflow uses the secret only when it is set. Delete the token once trusted publishing
     works (step 3).
2. Push the tag for 0.1.0.
3. Once the package exists, open its settings on npmjs.com and add a trusted publisher for GitHub
   Actions: the owner and name of this repository, the workflow filename `release.yml`, and the
   environment name `npm`. Allow `npm publish`. Then delete the `NPM_TOKEN` secret, so that the next
   release goes through the trusted publisher, and once it has, delete the token on npmjs.com
   (Access Tokens).

npm expects a new trusted-publisher configuration to make its first successful publish within 2
days, or it expires. Add it close to the next release, not long before. When trusted publishing
works, npm recommends the package setting "Require two-factor authentication and disallow tokens".

You may add a required reviewer to the `npm` environment, so that each publish waits for approval.
If you add deployment branch or tag rules to it, include a rule for `v*.*.*` tags, or the runs of
the tags are blocked.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, and not in an issue.
