import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { MOCK_URL } from './e2e/fixtures.mjs';
import type { Target } from './e2e/support.ts';

// The end-to-end tests of the dashboard, in Chromium, as one of three projects per run:
// - mocked (the default, and what CI runs): the built dashboard against e2e/mock-server.mjs, which
//   answers like the server with synthetic data (pnpm test:e2e);
// - real: the dashboard as the built server ships it, against the fake TradingView of the server's
//   tests (pnpm test:e2e:real, after pnpm build); with TV_E2E=1, against the user's TradingView,
//   where only the tests tagged @app run, and they only read;
// - screenshots: the images of the README, from the mock server (pnpm docs:screenshots).
//
// Each project needs a server of its own, and Playwright starts the web servers of a run before it
// looks at the projects, so a run is of one project: the one named with --project, mocked without.
// The worker processes, which load this file again without the command line, read it back from the
// environment.

const PROJECTS = ['mocked', 'real', 'screenshots'] as const;
type ProjectName = (typeof PROJECTS)[number];

const PROJECT_VARIABLE = 'DASHBOARD_E2E_PROJECT';

function isProjectName(name: string | undefined): name is ProjectName {
  return PROJECTS.some((project) => project === name);
}

// The project the command line names, as --project <name> or --project=<name>.
function projectOfCommandLine(args: readonly string[]): ProjectName {
  const named = new Set(
    args.flatMap((arg, index) => {
      if (arg.startsWith('--project=')) {
        return [arg.slice('--project='.length)];
      }
      const next = args[index + 1];
      return arg === '--project' && next !== undefined ? [next] : [];
    }),
  );
  if (named.size === 0) {
    return 'mocked';
  }
  const [name] = named;
  if (named.size > 1 || !isProjectName(name)) {
    throw new Error(`Run one project at a time, one of ${PROJECTS.join(', ')}`);
  }
  return name;
}

const fromEnvironment = process.env[PROJECT_VARIABLE];
const project = isProjectName(fromEnvironment)
  ? fromEnvironment
  : projectOfCommandLine(process.argv);
process.env[PROJECT_VARIABLE] = project;

// The user's own TradingView, with their account and charts on the page: nothing of the page may be
// kept or shown. Traces, screenshots and videos are off, the HTML report is not written, and
// Playwright is kept from writing a snapshot of the page next to a failure.
const realApp = project === 'real' && process.env.TV_E2E === '1';
if (realApp) {
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
}

// Where the script that starts the real server writes its address and token, for the tests.
const SERVER_FILE = fileURLToPath(new URL('./e2e/.real-server.json', import.meta.url));

interface WorkerOptions {
  target: Target;
  serverFile: string;
}

type Config = PlaywrightTestConfig<object, WorkerOptions>;

const browser = {
  ...devices['Desktop Chrome'],
  // Times on the page are local times: one zone and one locale for every machine.
  locale: 'en-US',
  timezoneId: 'UTC',
};

const mockServer: NonNullable<Config['webServer']> = {
  command: 'node e2e/mock-server.mjs',
  url: `${MOCK_URL}/healthz`,
  // Another server on the port, such as vite preview, would answer the page without the API.
  reuseExistingServer: false,
  timeout: 30_000,
};

const PER_PROJECT: Record<ProjectName, Config> = {
  mocked: {
    webServer: mockServer,
    retries: process.env.CI === undefined ? 0 : 1,
    projects: [
      {
        name: 'mocked',
        testIgnore: /screenshots\.spec\.ts$/,
        grepInvert: /@screenshots/,
        use: { ...browser, target: 'mocked' },
      },
    ],
  },
  real: {
    webServer: {
      command: 'tsx ../server/scripts/dashboard-e2e-server.ts',
      env: { DASHBOARD_E2E_SERVER_FILE: SERVER_FILE },
      // The script says when the server answers. It never prints the token, which goes through
      // the file.
      wait: { stdout: /dashboard-e2e-server: ready/ },
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 60_000,
      // The script stops the server and the fake app, and removes the file, on SIGTERM.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    retries: 0,
    expect: { timeout: 15_000 },
    projects: [
      {
        name: 'real',
        testIgnore: /screenshots\.spec\.ts$/,
        grep: realApp ? /@app/ : /@real/,
        use: {
          ...browser,
          target: 'real',
          serverFile: SERVER_FILE,
          ...(realApp ? { trace: 'off', screenshot: 'off', video: 'off' } : {}),
        },
      },
    ],
  },
  screenshots: {
    webServer: mockServer,
    retries: 0,
    projects: [
      {
        name: 'screenshots',
        testMatch: /screenshots\.spec\.ts$/,
        grep: /@screenshots/,
        use: {
          ...browser,
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
          colorScheme: 'light',
          // No pulsing badge or spinner caught halfway.
          reducedMotion: 'reduce',
          target: 'mocked',
        },
      },
    ],
  },
};

export default defineConfig<object, WorkerOptions>({
  testDir: 'e2e',
  // The tests of a project share one server, and the mock's tests set it back before each one.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: realApp ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  ...PER_PROJECT[project],
});
