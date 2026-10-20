import type { CdpSession, CdpTargetInfo } from '../../../../src/core/cdp/types.js';
import type { PageHandle } from '../../../../src/core/connection.js';
import { TvMcpError } from '../../../../src/core/errors.js';
import { createPageBridge } from '../../../../src/core/tv/page-bridge.js';
import {
  ensureEditorOpen,
  readEditorState,
  requireUnmodifiedOrConfirmed,
  type PineEditorState,
} from '../../../../src/tools/pine/editor.js';
import { createPageRuntime } from '../../../helpers/fake-cdp/runtime.js';
import { loadTvFixture, type TvStateFixture } from '../../../helpers/fake-tv/fixture.js';
import { createFakeWebpack } from '../../../helpers/fake-tv/webpack.js';
import { createFakeTvWindow, inspectFakeWindow } from '../../../helpers/fake-tv/window.js';

// The Node side of the Pine Editor access layer: the state of the editor read through a page
// bridge on a fake page, and the guard that keeps unsaved editor text from being replaced without
// confirm. Sources are synthetic.

const fixture = loadTvFixture();

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

const target: CdpTargetInfo = {
  id: 'PAGE1',
  type: 'page',
  title: 'Chart',
  url: 'https://www.tradingview.com/chart/FIXTURE1/',
};

function pageOf(win: object): PageHandle {
  const runtime = createPageRuntime(win);
  disposers.push(() => {
    runtime.dispose();
  });
  const send = (method: string, params?: unknown): Promise<unknown> =>
    method === 'Runtime.evaluate'
      ? runtime.evaluate(params as Record<string, unknown>)
      : Promise.reject(new Error(`Unexpected command ${method}`));
  const session: CdpSession = {
    targetId: 'PAGE1',
    isClosed: false,
    send: send as CdpSession['send'],
    onClose: () => undefined,
    close: () => Promise.resolve(),
  };
  return {
    target,
    session,
    bridge: createPageBridge(session, { timeoutMs: 5000 }),
  };
}

function withEditor(
  open: 'dialog' | 'bottom' | null,
  editor: Partial<TvStateFixture['pineEditor']> = {},
): TvStateFixture {
  return { ...fixture, pineEditor: { ...fixture.pineEditor, open, ...editor } };
}

const SCRIPT = {
  id: fixture.pineEditor.script?.scriptIdPart ?? '',
  version: fixture.pineEditor.script?.version ?? '',
};

describe('readEditorState', () => {
  test('reports a closed editor without warnings', async () => {
    const warnings: string[] = [];

    await expect(readEditorState(pageOf(createFakeTvWindow(fixture)), warnings)).resolves.toEqual({
      open: false,
      placement: null,
      modified: false,
      draft: false,
      script: null,
    });
    expect(warnings).toEqual([]);
  });

  test('warns about each member of the facade it could not read', async () => {
    const facade = {
      isModified: () => {
        throw new Error('not ready');
      },
      isDraft: () => null,
      getScriptIdVersion: () => 42,
    };
    const win = {
      webpackChunktradingview: createFakeWebpack({
        1: {
          getOpenPineEditor: (placement: string) =>
            placement === 'dialog' ? { getFacade: () => facade } : null,
        },
      }),
    };
    const warnings: string[] = [];

    const state = await readEditorState(pageOf(win), warnings);

    expect(state).toEqual({
      open: true,
      placement: 'dialog',
      modified: true,
      draft: true,
      script: null,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('id and version');
    expect(warnings[1]).toContain('modified: true');
    expect(warnings[2]).toContain('draft');
  });

  test('warns once when the facade itself cannot be had', async () => {
    const win = {
      webpackChunktradingview: createFakeWebpack({
        1: {
          getOpenPineEditor: (placement: string) =>
            placement === 'bottom' ? { getFacade: () => null } : null,
        },
      }),
    };
    const warnings: string[] = [];

    await expect(readEditorState(pageOf(win), warnings)).resolves.toMatchObject({
      open: true,
      modified: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('modified: true');
  });

  test('works without a list of warnings', async () => {
    await expect(
      readEditorState(pageOf(createFakeTvWindow(withEditor('dialog')))),
    ).resolves.toEqual({
      open: true,
      placement: 'dialog',
      modified: false,
      draft: false,
      script: SCRIPT,
    });
  });
});

describe('ensureEditorOpen', () => {
  test('ensureEditorOpen opens the editor and reports its placement', async () => {
    const win = createFakeTvWindow(fixture, { pineEditorReadyMs: 50 });

    const state = await ensureEditorOpen(pageOf(win), 2000);

    expect(state).toEqual({
      open: true,
      placement: 'dialog',
      modified: false,
      draft: false,
      script: SCRIPT,
    });
    expect(inspectFakeWindow(win).callsTo('pineEditorApi.open')).toHaveLength(1);
  });

  test('reports the bottom placement, and leaves an open editor as it is', async () => {
    const closed = createFakeTvWindow(withEditor(null, { opensAt: 'bottom' }));
    await expect(ensureEditorOpen(pageOf(closed), 2000)).resolves.toMatchObject({
      placement: 'bottom',
    });

    const open = createFakeTvWindow(withEditor('dialog'));
    const warnings: string[] = [];
    await expect(ensureEditorOpen(pageOf(open), 2000, warnings)).resolves.toMatchObject({
      placement: 'dialog',
    });
    expect(inspectFakeWindow(open).callsTo('pineEditorApi.open')).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('fails TIMEOUT when the editor does not get ready', async () => {
    const win = createFakeTvWindow(fixture, { pineEditorReadyMs: Infinity });

    await expect(ensureEditorOpen(pageOf(win), 100)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('requireUnmodifiedOrConfirmed', () => {
  const state = (modified: boolean): PineEditorState => ({
    open: true,
    placement: 'dialog',
    modified,
    draft: false,
    script: SCRIPT,
  });

  test('requireUnmodifiedOrConfirmed refuses modified content without confirm', () => {
    for (const confirm of [undefined, false]) {
      let thrown: unknown;
      try {
        requireUnmodifiedOrConfirmed(state(true), confirm, 'pine_set_source');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TvMcpError);
      const error = thrown as TvMcpError;
      expect(error.code).toBe('CONFIRMATION_REQUIRED');
      expect(error.message).toContain('pine_set_source');
      expect(error.message).toContain('unsaved');
      expect(error.hint).toContain('confirm: true');
      expect(error.hint).toContain('pine_save');
      expect(error.details).toEqual({ action: 'pine_set_source' });
    }
  });

  test('allows it with confirm', () => {
    expect(() => {
      requireUnmodifiedOrConfirmed(state(true), true, 'pine_set_source');
    }).not.toThrow();
  });

  test('allows unmodified content without confirm', () => {
    expect(() => {
      requireUnmodifiedOrConfirmed(state(false), undefined, 'pine_new');
    }).not.toThrow();
  });
});
