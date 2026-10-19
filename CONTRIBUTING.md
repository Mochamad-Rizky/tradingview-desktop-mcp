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

| Script                               | What it does                                                                |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `pnpm lint`                          | ESLint, with type-aware rules for the TypeScript                            |
| `pnpm format`                        | Prettier, rewriting the files                                               |
| `pnpm typecheck`                     | `tsc --noEmit`                                                              |
| `pnpm build`                         | Bundles `packages/server/dist/index.js` and `cli.js` with tsup              |
| `pnpm test`                          | Unit and integration tests                                                  |
| `pnpm test:unit`, `test:integration` | One of the two levels                                                       |
| `pnpm test:e2e`                      | End-to-end tests against the real app, local only (see below)               |
| `pnpm test:coverage`                 | Unit and integration tests with coverage, failing under 80% on any metric   |
| `pnpm re:probe`, `pnpm re:record`    | Read-only probes and the fixture recorder for the real app                  |
| `node scripts/smoke-node20.mjs`      | Starts the built CLI over stdio and lists its tools; run after `pnpm build` |

Before you push, run the whole gate:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:coverage
```

## Tests

There are three levels, described in [docs/testing.md](docs/testing.md):

- **Unit** tests use fakes and open no socket, apart from the tests of the fake debug-port server,
  which listen on the loopback address.
- **Integration** tests start the real server and talk to it with MCP clients, against a fake
  debug-port server and a fake TradingView window. They refuse to run against a build older than
  the sources, so run `pnpm build` first.
- **End-to-end** tests drive the TradingView Desktop on your machine. They run only on request
  (`TV_E2E=1 pnpm test:e2e`), never in CI, and are safe by design: they change only the symbol,
  timeframe, chart type and visible range of the active chart, put them back, and never touch
  drawings, indicators, alerts, layouts, watchlists, Pine scripts or replay, or anything that
  trades. Read the safety rules in [docs/testing.md](docs/testing.md) before you run them or add a
  suite.

Code in `packages/server/src` needs at least 80% coverage on lines, branches, functions and
statements, counting the unit and integration tests together.

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

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request. The
`verify` job installs with the frozen lockfile, then lints, type-checks, builds, runs the unit and
integration tests and checks the coverage. The `runtime-node20` job then takes the build from
`verify`, installs only the production dependencies on Node.js 20.19 and runs
`scripts/smoke-node20.mjs`, so that the bundle is proven on the oldest runtime it supports.

Maintainers: the coverage report goes to Codecov, which needs the repository enabled on
[codecov.io](https://codecov.io). Add the upload token as the `CODECOV_TOKEN` repository secret. The
upload never fails a run, so a missing token only leaves the coverage badge empty.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, and not in an issue.
