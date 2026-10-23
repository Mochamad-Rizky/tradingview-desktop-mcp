import { alertDelete } from '../../../src/tools/alert/index.js';
import {
  CHANGES,
  CHANGES_IDEMPOTENT,
  DESTRUCTIVE,
  DESTRUCTIVE_IDEMPOTENT,
  READ_ONLY,
} from '../../../src/tools/annotations.js';
import { dataTools } from '../../../src/tools/data/index.js';
import { drawingClearAll, drawingRemove } from '../../../src/tools/drawing/index.js';
import { indicatorTools } from '../../../src/tools/indicator/index.js';
import { layoutNew, layoutSwitch } from '../../../src/tools/layout/index.js';
import { pineTools } from '../../../src/tools/pine/index.js';
import {
  replayAutoplay,
  replayStart,
  replayStep,
  replayStop,
} from '../../../src/tools/replay/index.js';
import { strategyTools } from '../../../src/tools/strategy/index.js';
import { uiPressKey, uiTypeText } from '../../../src/tools/ui/keyboard.js';
import { uiClick, uiHover, uiScroll } from '../../../src/tools/ui/pointer.js';
import {
  watchlistAdd,
  watchlistAddBulk,
  watchlistRemove,
} from '../../../src/tools/watchlist/index.js';
import type { AnyToolDefinition } from '../../../src/tools/types.js';

// The annotation presets the tool definitions share, each set of hints under a name of its own, so
// that every tool that only reads says it with one and the same set of hints, and no two different
// sets go by one name.

test('READ_ONLY says that a tool only reads and reaches nothing beyond the local app', () => {
  expect(READ_ONLY).toEqual({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('the presets of the tools that change something differ, each by its name', () => {
  expect(CHANGES).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });
  expect(CHANGES_IDEMPOTENT).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  expect(DESTRUCTIVE).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  expect(DESTRUCTIVE_IDEMPOTENT).toEqual({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test.each([
  ['data', dataTools],
  ['indicator', indicatorTools],
  ['Pine', pineTools],
  ['Strategy Tester', strategyTools],
])('every %s tool that only reads shares READ_ONLY', (_domain, tools) => {
  const readers = tools.filter(({ annotations }) => annotations.readOnlyHint === true);

  // Not an empty loop: each of these domains has tools that read.
  expect(readers.length).toBeGreaterThan(0);
  for (const tool of readers) {
    // The object itself, not a copy of its values: a local constant would pass a deep comparison.
    expect(tool.annotations, tool.name).toBe(READ_ONLY);
  }
});

const SHARED: [AnyToolDefinition, string, object][] = [
  [uiClick, 'DESTRUCTIVE', DESTRUCTIVE],
  [uiScroll, 'DESTRUCTIVE', DESTRUCTIVE],
  [uiTypeText, 'DESTRUCTIVE', DESTRUCTIVE],
  [uiPressKey, 'DESTRUCTIVE', DESTRUCTIVE],
  [drawingRemove, 'DESTRUCTIVE', DESTRUCTIVE],
  [drawingClearAll, 'DESTRUCTIVE', DESTRUCTIVE],
  [alertDelete, 'DESTRUCTIVE', DESTRUCTIVE],
  [layoutNew, 'DESTRUCTIVE', DESTRUCTIVE],
  // Switching to the layout shown already answers changed: false, and changes nothing more.
  [layoutSwitch, 'DESTRUCTIVE_IDEMPOTENT', DESTRUCTIVE_IDEMPOTENT],
  [watchlistRemove, 'DESTRUCTIVE_IDEMPOTENT', DESTRUCTIVE_IDEMPOTENT],
  [replayStart, 'CHANGES', CHANGES],
  [replayStep, 'CHANGES', CHANGES],
  [replayAutoplay, 'CHANGES_IDEMPOTENT', CHANGES_IDEMPOTENT],
  [replayStop, 'CHANGES_IDEMPOTENT', CHANGES_IDEMPOTENT],
  [watchlistAdd, 'CHANGES_IDEMPOTENT', CHANGES_IDEMPOTENT],
  [watchlistAddBulk, 'CHANGES_IDEMPOTENT', CHANGES_IDEMPOTENT],
  [uiHover, 'CHANGES_IDEMPOTENT', CHANGES_IDEMPOTENT],
];

test.each(SHARED.map(([tool, name, preset]) => [tool.name, name, tool, preset] as const))(
  '%s shares the preset %s',
  (_tool, _name, tool, preset) => {
    // The object itself, not a copy of its values.
    expect(tool.annotations).toBe(preset);
  },
);
