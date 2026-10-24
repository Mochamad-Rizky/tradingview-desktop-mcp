import type { PageLib } from '../../src/core/tv/page-lib.js';
import type { TvWindow } from '../../src/core/tv/tv-window.js';
import type { JsonObject, JsonValue } from '../../src/utils/json.js';
import { callTool } from '../helpers/mcp-client.js';
import {
  callFailure,
  callOk,
  describeFailure,
  e2eEnabled,
  HarnessError,
  observe,
  planLimitSkipReason,
  sameJson,
  startE2eServer,
  type E2eServer,
  type ToolFailure,
} from './setup.js';

// The alert tools against the real TradingView Desktop. Alerts live in the user's account on the
// alerts server, and no test touches one of the user's: the suite creates one alert of its own, only
// while the plan has room for it (SERVER_SIDE_ALERTS), on a price ten times the last one, so that it
// cannot fire, with an expiration a day ahead and a message that says what it is, and deletes it
// again however the test ended. The symbol, the prices and the messages of the user's alerts are
// never printed.

const TEST_MESSAGE = 'tradingview-mcp E2E alert (safe to delete)';
const DAY_SECONDS = 86_400;

interface ListedAlert {
  id: string;
  symbol: string | null;
  kind: string | null;
  condition: string | null;
  price: number | null;
  indicator: string | null;
  value: number | null;
  message: string | null;
  status: 'active' | 'triggered' | 'stopped';
  expiration: number | null;
  expirationIso: string | null;
  createdByServer: boolean;
}

interface CreatedAlert {
  id: string;
  symbol: string;
  condition: string;
  price: number;
  expiration: number;
  expirationIso: string;
}

// The record of one alert as the alerts client of the app lists it, by the names and types of its
// fields, the formats of its times and the fields of its first condition: what the server stores of
// an alert of the test's own. Its symbol, price and message are not read out. Null when the client
// does not list the alert. It only reads (the request the alerts panel of the app sends).
function readAlertRecordShape(
  _win: TvWindow,
  lib: PageLib,
  id: number,
  waitMs: number,
): Promise<JsonObject | null> {
  const factory = lib.findExport('getAlertsRestApi') as
    (() => { listAlerts(): Promise<unknown> }) | null;
  const typeOf = (value: unknown): string =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  // A flag or a name of the app as it is, anything else by its type.
  const plain = (value: unknown): JsonValue =>
    typeof value === 'boolean' || typeof value === 'string' || value === null
      ? value
      : typeOf(value);
  const formatOf = (value: unknown): string => {
    if (typeof value !== 'string') {
      return typeOf(value);
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
      return 'iso-utc';
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/.test(value)) {
      return 'iso-utc-fraction';
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:?\d{2}$/.test(value)) {
      return 'iso-offset';
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
      return 'local-without-zone';
    }
    return `other(${String(value.length)})`;
  };
  const fieldsOf = (value: unknown): Record<string, string> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeOf(item)]))
      : {};
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, waitMs);
  });
  const listing = Promise.resolve()
    .then(() => factory?.().listAlerts())
    .then((list: unknown): JsonObject | null => {
      const record = (Array.isArray(list) ? (list as Record<string, unknown>[]) : []).find(
        (item) => item.alert_id === id,
      );
      if (record === undefined) {
        return null;
      }
      const conditions = Array.isArray(record.conditions) ? (record.conditions as unknown[]) : [];
      const first = (conditions[0] ?? {}) as Record<string, unknown>;
      const series = Array.isArray(first.series) ? (first.series as unknown[]) : [];
      const policy = record.expiration_policy as Record<string, unknown> | null | undefined;
      return {
        fields: fieldsOf(record),
        conditions: conditions.length,
        conditionFields: fieldsOf(first),
        conditionType: typeof first.type === 'string' ? first.type : null,
        frequency: typeof first.frequency === 'string' ? first.frequency : null,
        seriesTypes: series.map((item) => plain((item as { type?: unknown } | null)?.type ?? null)),
        barsetFields: fieldsOf(series[0]),
        valueFields: fieldsOf(series[1]),
        expirationPolicyFields: fieldsOf(policy),
        expirationPolicy: typeof policy?.policy === 'string' ? policy.policy : null,
        times: {
          create_time: formatOf(record.create_time),
          last_fire_time: formatOf(record.last_fire_time),
          last_fire_bar_time: formatOf(record.last_fire_bar_time),
          expiration: formatOf(record.expiration),
          expirationPolicyTime: formatOf(policy?.time),
        },
        symbolEncoded: typeof record.symbol === 'string' && record.symbol.startsWith('='),
        proSymbolPlain:
          typeof record.pro_symbol === 'string' && /^[^=:]+:[^:]+$/.test(record.pro_symbol),
        kinds: Array.isArray(record.kinds) ? (record.kinds as unknown[]).map(plain) : null,
        complexity: typeof record.complexity === 'string' ? record.complexity : null,
        type: typeof record.type === 'string' ? record.type : null,
        active: plain(record.active),
        autoDeactivate: plain(record.auto_deactivate),
        popup: plain(record.popup),
        email: plain(record.email),
        mobilePush: plain(record.mobile_push),
        soundFile: typeOf(record.sound_file),
        webHook: typeOf(record.web_hook),
        name: typeOf(record.name),
        lastStopReason: typeOf(record.last_stop_reason),
      };
    })
    .catch(() => null);
  return Promise.race([listing, timeout]);
}

describe.skipIf(!e2eEnabled())('the alert tools against TradingView Desktop', () => {
  let e2e: E2eServer | undefined;

  beforeAll(async () => {
    e2e = await startE2eServer();
  });

  afterAll(async () => {
    await e2e?.close();
  });

  function server(): E2eServer {
    if (e2e === undefined) {
      throw new Error('The server did not start');
    }
    return e2e;
  }

  async function listAlerts(status?: string): Promise<ListedAlert[]> {
    return (
      await callOk<{ alerts: ListedAlert[] }>(
        server().client,
        'alert_list',
        status === undefined ? {} : { status },
      )
    ).data.alerts;
  }

  test('lists the alerts of the account', async () => {
    const all = await listAlerts();
    const active = await listAlerts('active');
    expect(active.every(({ status }) => status === 'active')).toBe(true);
    expect(active.length).toBeLessThanOrEqual(all.length);
    for (const alert of all) {
      expect(/^[1-9]\d*$/.test(alert.id), 'an alert id is a positive integer').toBe(true);
      expect(['active', 'triggered', 'stopped']).toContain(alert.status);
      expect(alert.createdByServer).toBe(false);
    }
    observe('alerts of the account', {
      total: all.length,
      active: active.length,
      triggered: all.filter(({ status }) => status === 'triggered').length,
      stopped: all.filter(({ status }) => status === 'stopped').length,
      withPrice: all.filter(({ price }) => price !== null).length,
      withExpiration: all.filter(({ expiration }) => expiration !== null).length,
      // What the alerts watch (price, indicator or the name TradingView gives), and how many name
      // their indicator; the names themselves are not printed.
      kinds: Object.fromEntries(
        [...new Set(all.map(({ kind }) => String(kind)))].map((kind) => [
          kind,
          all.filter((alert) => String(alert.kind) === kind).length,
        ]),
      ),
      withIndicator: all.filter(({ indicator }) => indicator !== null).length,
    });
  });

  test('creates a far-away price alert within the plan, reads it back and deletes it', async (context) => {
    const { client, ctx } = server();
    const before = await listAlerts();
    const beforeIds = new Set(before.map(({ id }) => id));
    // Every active alert is counted against the room, price alerts or not: the test needs one.
    const active = before.filter(({ status }) => status === 'active').length;
    const full = await planLimitSkipReason(client, 'SERVER_SIDE_ALERTS', active, 1);
    if (full !== null) {
      return context.skip(full);
    }
    const { data: ohlcv } = await callOk<{ bars: { close: number }[] }>(client, 'data_get_ohlcv', {
      count: 1,
    });
    const last = ohlcv.bars.at(-1)?.close;
    if (last === undefined || !(last > 0)) {
      return context.skip('The chart reports no last price to put the test alert far above');
    }
    // Ten times the last price, to be crossed upwards: the alert cannot fire.
    const price = Number((last * 10).toPrecision(6));
    const expiration = Math.floor(Date.now() / 1000) + DAY_SECONDS;

    // The alert of the test, once alert_create answers its id.
    const own: { alert?: CreatedAlert } = {};
    // However the test ends, after a timeout too: the test alert goes, and so does an alert of its
    // message the creation left without answering its id, which only the test makes; the account
    // then holds the alerts of before, and only they.
    onTestFinished(async () => {
      const failures: string[] = [];
      try {
        const now = await listAlerts();
        const left = now.filter(
          ({ id, message }) =>
            id === own.alert?.id || (!beforeIds.has(id) && message === TEST_MESSAGE),
        );
        if (left.length > 0) {
          try {
            await callOk(client, 'alert_delete', {
              alertIds: left.map(({ id }) => id),
              // Only for an alert the session could not record: one of the test's message.
              ...(left.some(({ id }) => id !== own.alert?.id) ? { confirm: true } : {}),
            });
          } catch (error) {
            failures.push(describeFailure(error));
          }
        }
        const after = await listAlerts();
        if (!sameJson(after.map(({ id }) => id).sort(), [...beforeIds].sort())) {
          failures.push(
            `The account holds ${String(after.length)} alerts after the test and held ` +
              `${String(before.length)} before, or other ones`,
          );
        }
      } catch (error) {
        failures.push(describeFailure(error));
      }
      if (failures.length > 0) {
        throw new HarnessError(`The alert test could not clean up: ${failures.join('; ')}`);
      }
    });

    const result = await callTool(client, 'alert_create', {
      condition: 'crossing_up',
      price,
      message: TEST_MESSAGE,
      expiration,
    });
    if (result.isError === true) {
      const { error } = result.structuredContent as { error: ToolFailure };
      if (error.code === 'PLAN_LIMIT') {
        // The plan, or the chart's timeframe, leaves no room: nothing was created.
        return context.skip(
          `alert_create refused with PLAN_LIMIT (${String(error.details?.feature)}): nothing was created`,
        );
      }
    }
    const envelope = result.structuredContent as {
      ok: boolean;
      data?: CreatedAlert;
      error?: ToolFailure;
      meta: { warnings?: string[] };
    };
    if (result.isError === true || envelope.data === undefined) {
      throw new HarnessError(`alert_create failed with ${envelope.error?.code ?? 'UNKNOWN'}`);
    }
    const created = envelope.data;
    own.alert = created;
    expect(/^[1-9]\d*$/.test(created.id)).toBe(true);
    expect(created.condition).toBe('crossing_up');
    // A price derived from the chart's, so compared without being printed.
    expect(created.price === price, 'alert_create reports the price').toBe(true);
    expect(created.expiration).toBe(expiration);
    expect((envelope.meta.warnings ?? []).length === 0, 'alert_create gives no warning').toBe(true);

    const listed = (await listAlerts()).find(({ id }) => id === created.id);
    expect(listed, 'alert_list lists the new alert').toBeDefined();
    expect(listed?.status).toBe('active');
    expect(listed?.kind).toBe('price');
    expect(listed?.condition).toBe('crossing_up');
    expect(listed?.price === price, 'the price reads back').toBe(true);
    expect(listed?.indicator).toBeNull();
    expect(listed?.value).toBeNull();
    expect(listed?.message === TEST_MESSAGE, 'the message reads back').toBe(true);
    expect(listed?.symbol === created.symbol, 'the symbol reads back').toBe(true);
    expect(listed?.createdByServer).toBe(true);
    const activeNow = await listAlerts('active');
    expect(activeNow.some(({ id }) => id === created.id)).toBe(true);

    const page = await ctx.connection.chartPage();
    const shape = await page.bridge.evaluateWithLib(readAlertRecordShape, [
      Number(created.id),
      10_000,
    ]);
    observe('the test alert as the server stores it', {
      record: shape,
      expirationReadBackOffsetSeconds:
        listed?.expiration === null || listed?.expiration === undefined
          ? null
          : listed.expiration - expiration,
      symbolIsExchangeTicker: /^[^:]+:[^:]+$/.test(created.symbol),
    });
    expect(shape, 'the alerts client lists the test alert').not.toBeNull();

    // An id the account does not have: nothing is deleted.
    const unknownId = ['1', '2', '3'].find((id) => !beforeIds.has(id) && id !== created.id);
    if (unknownId !== undefined) {
      const unknown = await callFailure(client, 'alert_delete', { alertIds: [unknownId] });
      expect(unknown.code).toBe('INVALID_INPUT');
      expect(sameJson(unknown.details?.unknown, [unknownId]), 'the unknown id is named').toBe(true);
    }

    // The session created it, so it goes without confirm.
    const deleted = await callOk<{ deleted: string[] }>(client, 'alert_delete', {
      alertIds: [created.id],
    });
    expect(deleted.data.deleted).toEqual([created.id]);
    expect(deleted.warnings.length === 0, 'alert_delete gives no warning').toBe(true);
    const after = await listAlerts();
    expect(after.some(({ id }) => id === created.id)).toBe(false);
    expect(after.length).toBe(before.length);
  });
});
