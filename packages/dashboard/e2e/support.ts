import { readFileSync } from 'node:fs';
import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import type {
  DashboardCallResult,
  DashboardEvent,
  DashboardInfo,
  JsonValue,
} from '../../server/src/transports/dashboard/contract.ts';
import { MOCK_TOKEN, MOCK_URL } from './fixtures.mjs';

// What every spec of the dashboard takes from here: the server under test, a sign-in, the API with
// the token, and the controls of the mock server.
//
// The tests run against one of two servers (the projects of playwright.config.ts):
// - mocked: the mock server of e2e/mock-server.mjs, with synthetic data, set back to its fixtures
//   before every test;
// - real: the built server of the package, started by packages/server/scripts/dashboard-e2e-server.ts
//   against the fake TradingView of the server's tests, or against the user's TradingView with
//   TV_E2E=1. Its address and token are in a file that the script writes once it is up.
//
// Tests tagged @real run against the real server too; those tagged @app also run against the
// user's TradingView, where they may only read: they show what the page says without printing it.

export type Target = 'mocked' | 'real';

export interface DashboardServer {
  // The origin of the dashboard, such as http://127.0.0.1:4173.
  url: string;
  token: string;
}

export type HealthState = 'ready' | 'background' | 'unreachable';

// A tool event to push onto the mock's bus: the mock numbers it, and stamps it with the time of
// now when it has no time of its own.
export type ScriptedEvent = Omit<DashboardEvent, 'seq' | 'at'> & { at?: string };

// The test-only routes of the mock server (/__control/*), which the real server does not have.
export interface MockControl {
  // Pushes events onto the bus, as tool calls of any client would, and returns them numbered.
  emit(events: ScriptedEvent[]): Promise<DashboardEvent[]>;
  // The tool calls the dashboard made, in order.
  calls(): Promise<{ name: string; arguments: Record<string, JsonValue> }[]>;
  // What /api/health reports from now on.
  setHealth(state: HealthState): Promise<void>;
  // The token the API accepts from now on, as after a restart with another TV_MCP_AUTH_TOKEN.
  setToken(token: string): Promise<void>;
  // Breaks every open event stream, as a network that failed: the bus and its seqs stay.
  dropStreams(): Promise<void>;
  // A server that restarted: a new boot id, an empty bus, and every event stream broken.
  restart(): Promise<void>;
}

interface WorkerFixtures {
  target: Target;
  // Where the real server's address and token are, for the real project.
  serverFile: string;
  server: DashboardServer;
}

interface TestFixtures {
  mock: MockControl;
  api: DashboardApiClient;
}

function readServerFile(file: string): DashboardServer {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `${file} is missing: the real project reads the address of the server that ` +
        'packages/server/scripts/dashboard-e2e-server.ts starts. Run it with test:e2e:real.',
    );
  }
  const parsed = JSON.parse(text) as Partial<DashboardServer>;
  if (typeof parsed.url !== 'string' || typeof parsed.token !== 'string') {
    throw new Error(`${file} does not hold the url and the token of the server`);
  }
  return { url: parsed.url, token: parsed.token };
}

async function expectOk(response: APIResponse, what: string): Promise<void> {
  if (!response.ok()) {
    throw new Error(`${what} answered ${String(response.status())}: ${await response.text()}`);
  }
}

function mockControl(request: APIRequestContext): MockControl {
  const post = async (path: string, data: JsonValue): Promise<APIResponse> => {
    const response = await request.post(`${MOCK_URL}/__control/${path}`, { data });
    await expectOk(response, `POST /__control/${path}`);
    return response;
  };
  return {
    async emit(events) {
      const response = await post('emit', { events });
      return ((await response.json()) as { events: DashboardEvent[] }).events;
    },
    async calls() {
      const response = await request.get(`${MOCK_URL}/__control/calls`);
      await expectOk(response, 'GET /__control/calls');
      return (
        (await response.json()) as {
          calls: { name: string; arguments: Record<string, JsonValue> }[];
        }
      ).calls;
    },
    async setHealth(state) {
      await post('health', { state });
    },
    async setToken(token) {
      await post('token', { token });
    },
    async dropStreams() {
      await post('drop', {});
    },
    async restart() {
      await post('restart', {});
    },
  };
}

function refusingMockControl(): MockControl {
  const refuse = (): never => {
    throw new Error(
      'Only the mock server has the /__control routes: tag this test for mocked only',
    );
  };
  return {
    emit: refuse,
    calls: refuse,
    setHealth: refuse,
    setToken: refuse,
    dropStreams: refuse,
    restart: refuse,
  };
}

// The dashboard API with the token, as the page calls it.
export class DashboardApiClient {
  readonly #request: APIRequestContext;
  readonly #server: DashboardServer;

  constructor(request: APIRequestContext, server: DashboardServer) {
    this.#request = request;
    this.#server = server;
  }

  get #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#server.token}` };
  }

  async info(): Promise<DashboardInfo> {
    const response = await this.#request.get(`${this.#server.url}/api/info`, {
      headers: this.#headers,
    });
    await expectOk(response, 'GET /api/info');
    return (await response.json()) as DashboardInfo;
  }

  // Runs a tool through the registry, as another dashboard tab would.
  async callTool(name: string, args: Record<string, JsonValue> = {}): Promise<DashboardCallResult> {
    const response = await this.#request.post(
      `${this.#server.url}/api/tools/${encodeURIComponent(name)}`,
      { headers: this.#headers, data: { arguments: args } },
    );
    await expectOk(response, `POST /api/tools/${name}`);
    return (await response.json()) as DashboardCallResult;
  }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  target: ['mocked', { option: true, scope: 'worker' }],
  serverFile: ['', { option: true, scope: 'worker' }],
  server: [
    async ({ target, serverFile }, use) => {
      await use(
        target === 'mocked' ? { url: MOCK_URL, token: MOCK_TOKEN } : readServerFile(serverFile),
      );
    },
    { scope: 'worker' },
  ],
  // The real server listens on a port it found free, known only once it is up.
  baseURL: async ({ server }, use) => {
    await use(server.url);
  },
  // Every test starts from the mock's fixtures. Tests run one at a time (workers: 1), because they
  // share the mock's bus.
  mock: [
    async ({ target, request }, use) => {
      if (target !== 'mocked') {
        await use(refusingMockControl());
        return;
      }
      const response = await request.post(`${MOCK_URL}/__control/reset`, { data: {} });
      await expectOk(response, 'POST /__control/reset');
      await use(mockControl(request));
    },
    { auto: true },
  ],
  api: async ({ request, server }, use) => {
    await use(new DashboardApiClient(request, server));
  },
});

export { expect };

// Opens `path` and connects with the token through the token screen, as a user does.
export async function signIn(page: Page, server: DashboardServer, path = '/'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Access token').fill(server.token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&');
}

// The value of a fact (a row of a description list) in `scope`, by its exact label.
export function fact(scope: Locator, label: string): Locator {
  return scope
    .locator('dt')
    .filter({ hasText: new RegExp(`^${escapeRegExp(label)}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

// The rows of the live log's table, newest first.
export function callRows(page: Page): Locator {
  return page.getByRole('table', { name: 'Tool calls, newest first' }).locator('tbody tr');
}

// The row of a call in the live log, by its tool name.
export function callRow(page: Page, tool: string): Locator {
  return callRows(page).filter({
    has: page.getByRole('button', { name: new RegExp(`^Details of ${escapeRegExp(tool)} at `) }),
  });
}

// The header's word on TradingView.
export function connectionBadge(page: Page): Locator {
  return page.getByRole('banner').getByRole('status');
}
