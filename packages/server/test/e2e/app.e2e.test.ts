import { callOk, e2eEnabled, startE2eServer, type E2eServer } from './setup.js';

// The app tools against the real TradingView Desktop. Both tools only read.

interface Health {
  cdp: { reachable: boolean; endpoint: string; browser?: string };
  chart: { found: boolean; tabs: number };
  app: { ready: boolean; connected?: boolean; buildTime?: string | null };
  capabilities: Record<string, boolean | string | null> | null;
}

interface Discovery {
  executable: string | null;
  running: boolean;
  cdpReachable: boolean;
  targets: { id: string; kind: string; title: string; url: string }[];
}

describe.skipIf(!e2eEnabled())('the app tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function client() {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e.client;
  }

  test('app_health reports a ready app', async () => {
    const { data, warnings } = await callOk<Health>(client(), 'app_health');

    expect(data.cdp.reachable).toBe(true);
    expect(data.cdp.browser).toMatch(/^Chrome\//);
    expect(data.chart.found).toBe(true);
    expect(data.app).toMatchObject({ ready: true, connected: true });
    expect(data.app.buildTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.capabilities).toMatchObject({
      tradingViewApi: true,
      activeChart: true,
      chartModel: true,
      webpackRegistry: true,
      tvd: true,
    });
    expect(warnings).toEqual([]);
  });

  test('app_discover finds the chart target', async () => {
    const { data } = await callOk<Discovery>(client(), 'app_discover');

    expect(data.cdpReachable).toBe(true);
    expect(data.running).toBe(true);
    const kinds = data.targets.map((target) => target.kind);
    expect(kinds).toContain('chart');
    expect(kinds).toContain('window-chrome');
    const chart = data.targets.find((target) => target.kind === 'chart');
    expect(chart?.url).toMatch(/^https:\/\/([a-z0-9-]+\.)?tradingview\.com\/chart\//);
  });
});
