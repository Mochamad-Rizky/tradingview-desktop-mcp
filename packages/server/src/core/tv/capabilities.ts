import type { PageBridge } from './page-bridge.js';
import type { TvWindow } from './tv-window.js';

// What the page of a chart tab offers to the strategies of a tool (design spec 6), found out in one
// look, so that the health report and the tools can choose a way by what exists instead of by
// failing.

// The probe is a page function: the page bridge sends its source text into the page, so it uses
// nothing of this module. It changes nothing, and it never throws, because it is asked in just the
// states in which parts of the app are missing or half built. A flag says that the member leading
// to a feature is there, which is not the same as the feature working. Every flag is false on a page
// that lacks the feature, such as a blank page or one whose app has not started.
//
// - tradingViewApi: window.TradingViewApi is an object, the way into the public API (tier api).
// - activeChart: the API has an activeChart() that returns an object. That is the one call the
//   probe makes. It is a getter that only reads, and it throws while no chart is active.
// - chartModel: that chart holds the widget the internal tier goes through, and the widget has a
//   model(). The model itself is not asked for.
// - replayApi, pineEditorApi: the API has these members as functions. They are not called, because
//   nothing is known about what calling them sets going, and being there is all a strategy needs.
// - webpackRegistry: the webpack chunk list is an array. Reaching the module registry takes a push
//   to that list, which runs code of the app's loader, so the probe checks the type of the list
//   and nothing else: it neither pushes to it nor reads it.
// - tvd: window.TVD, the desktop bridge, is an object. It is not called, and its members are not
//   read, because some of them hold the user's credentials.
// - buildTime: BUILD_TIME when it is a string, otherwise null.
export function probeCapabilities(win: TvWindow): {
  tradingViewApi: boolean;
  activeChart: boolean;
  chartModel: boolean;
  replayApi: boolean;
  pineEditorApi: boolean;
  webpackRegistry: boolean;
  tvd: boolean;
  buildTime: string | null;
} {
  // Everything is read as unknown, because another build can drop or reshape any of it. A read
  // that throws, such as a getter of an app that is half built, counts as absent.
  const attempt = (read: () => unknown): unknown => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null;
  const memberOf = (owner: unknown, name: string): unknown =>
    attempt(() => (isObject(owner) ? (owner as Record<string, unknown>)[name] : undefined));

  const api = attempt(() => win.TradingViewApi);
  const getChart = memberOf(api, 'activeChart');
  // Called on the API, because its methods may rely on being the receiver.
  const chart = attempt(() => (typeof getChart === 'function' ? getChart.call(api) : undefined));
  const buildTime = attempt(() => win.BUILD_TIME);
  return {
    tradingViewApi: isObject(api),
    activeChart: isObject(chart),
    chartModel: typeof memberOf(memberOf(chart, '_chartWidget'), 'model') === 'function',
    replayApi: typeof memberOf(api, 'replayApi') === 'function',
    pineEditorApi: typeof memberOf(api, 'pineEditorApi') === 'function',
    webpackRegistry: Array.isArray(attempt(() => win.webpackChunktradingview)),
    tvd: isObject(attempt(() => win.TVD)),
    buildTime: typeof buildTime === 'string' ? buildTime : null,
  };
}

// What probeCapabilities reports. It is derived from the page function and not written as an
// interface, because the bridge takes only results that are JSON, and an interface is not
// assignable to the JSON object type (see utils/json.ts).
export type Capabilities = ReturnType<typeof probeCapabilities>;

// Asks a page what it offers. Nothing is cached, because the app starts after the page has loaded
// and an earlier answer can be out of date. The errors of the bridge pass through unchanged: a
// page that cannot be asked is not the same as a page that offers nothing.
export function readCapabilities(page: { readonly bridge: PageBridge }): Promise<Capabilities> {
  return page.bridge.evaluate(probeCapabilities, []);
}
