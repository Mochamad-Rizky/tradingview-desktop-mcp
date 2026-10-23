import type { JsonSchemaObject } from '@contract';
import {
  alertDeleteSchema,
  batchRunSchema,
  chartSetSymbolSchema,
  COLOR_PATTERN,
  drawingCreateSchema,
  indicatorAddSchema,
  SHAPES,
} from '@/test/tool-schemas';
import { schemaFields } from './schema';

const CHART_INDEX = {
  name: 'chartIndex',
  type: 'integer',
  required: false,
  description:
    'Which chart of a multi-chart layout, counted from 0. Leave it out for the active chart.',
  // zod bounds every integer by the safe integers, which says nothing about the field.
  constraints: ['at least 0'],
};

test('schemaFields reads the fields of chart_set_symbol', () => {
  expect(schemaFields(chartSetSymbolSchema)).toEqual([
    {
      name: 'symbol',
      type: 'string',
      required: true,
      description: 'Symbol to show, best in the EXCHANGE:SYMBOL form such as NASDAQ:AAPL.',
      constraints: ['length 1 to 200'],
    },
    CHART_INDEX,
  ]);
});

test('schemaFields reads the nested points and style of drawing_create, and the union of a time', () => {
  expect(schemaFields(drawingCreateSchema)).toEqual([
    {
      name: 'shape',
      type: 'string',
      required: true,
      description: 'What to draw, one of the curated shapes.',
      constraints: [`one of: ${SHAPES.join(', ')}`],
    },
    {
      name: 'points',
      type: 'array of object',
      required: true,
      description: 'Where to draw, as many points as the shape takes.',
      constraints: ['1 to 10 items'],
    },
    {
      name: 'points[].time',
      type: 'string | number',
      required: true,
      description: 'When: ISO 8601 date/time or Unix timestamp in seconds/milliseconds.',
      constraints: ['length 1 to 64 (string)'],
    },
    {
      name: 'points[].price',
      type: 'number',
      required: true,
      description: 'The price, on the price scale of the chart.',
      constraints: [],
    },
    {
      name: 'text',
      type: 'string',
      required: false,
      description: 'The text of the drawing. Default: none.',
      constraints: ['length 1 to 5,000'],
    },
    {
      name: 'style',
      type: 'object',
      required: false,
      description: 'The look of the drawing.',
      constraints: [],
    },
    {
      name: 'style.color',
      type: 'string',
      required: false,
      description: 'The color.',
      constraints: [`pattern ${COLOR_PATTERN}`],
    },
    {
      name: 'style.lineWidth',
      type: 'integer',
      required: false,
      description: 'The line width, 1 to 4.',
      constraints: ['1 to 4'],
    },
    {
      name: 'style.lineStyle',
      type: 'string',
      required: false,
      description: 'solid, dotted or dashed.',
      constraints: ['one of: solid, dotted, dashed'],
    },
    {
      name: 'style.fontSize',
      type: 'integer',
      required: false,
      description: 'The font size, 8 to 40.',
      constraints: ['8 to 40'],
    },
    CHART_INDEX,
  ]);
});

test('schemaFields reads the steps of batch_run, with an open object and defaults', () => {
  expect(schemaFields(batchRunSchema)).toEqual([
    {
      name: 'steps',
      type: 'array of object',
      required: true,
      description: 'The tool calls to make, in order (1 to 20).',
      constraints: ['1 to 20 items'],
    },
    {
      name: 'steps[].tool',
      type: 'string',
      required: true,
      description: 'Name of the tool to run.',
      constraints: [],
    },
    {
      // Any keys and any values: nothing more to say than its default.
      name: 'steps[].arguments',
      type: 'object',
      required: false,
      description: 'Arguments for that tool. Default: {}.',
      constraints: ['default: {}'],
    },
    {
      name: 'stopOnError',
      type: 'boolean',
      required: false,
      description: 'Stop at the first step that fails (default true).',
      constraints: ['default: true'],
    },
  ]);
});

test('schemaFields says what the keys and values of a record may be, and what each item of a list must match', () => {
  const [, inputs] = schemaFields(indicatorAddSchema);
  expect(inputs).toEqual({
    name: 'inputs',
    type: 'object',
    required: false,
    description: 'Input values by input id or name.',
    constraints: [
      'keys: length 1 to 200',
      'values: string | number | boolean',
      'values: length at most 10,000 (string)',
    ],
  });

  expect(schemaFields(alertDeleteSchema)).toEqual([
    {
      name: 'alertIds',
      type: 'array of string',
      required: false,
      description: 'The ids of the alerts to delete: 1 to 50 of them.',
      constraints: ['1 to 50 items', 'items: pattern ^[1-9]\\d{0,14}$'],
    },
    {
      name: 'confirm',
      type: 'boolean',
      required: false,
      description: 'Must be true to delete an alert of the user.',
      constraints: [],
    },
  ]);
});

test('schemaFields names every other constraint and type a schema can state', () => {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: {
      ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.25 },
      floor: { type: 'number', minimum: -2.5 },
      ceiling: { type: 'integer', maximum: 10, minimum: -9007199254740991 },
      code: { type: 'string', minLength: 3, maxLength: 3, format: 'uuid' },
      short: { type: 'string', maxLength: 8 },
      long: { type: 'string', minLength: 2 },
      label: { type: ['string', 'null'], default: null },
      nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      either: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'boolean' }] },
      both: { allOf: [{ type: 'object' }, { type: 'object' }] },
      fixed: { const: 'v1' },
      levels: { enum: [1, 2, 'max', null, [3]] },
      point: { properties: { x: { type: 'number' } }, required: ['x'] },
      names: { items: { type: 'string', minLength: 1 } },
      pair: { type: 'array', minItems: 2, maxItems: 2 },
      some: {
        type: 'array',
        minItems: 1,
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      many: { type: 'array', maxItems: 1 },
      closed: {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
      linked: { $ref: '#/$defs/Point' },
      self: { $ref: '#' },
      anything: {},
      shown: true,
    },
  };
  const fields = Object.fromEntries(
    schemaFields(schema).map(({ name, type, constraints }) => [name, { type, constraints }]),
  );
  expect(fields).toEqual({
    ratio: { type: 'number', constraints: ['more than 0', 'less than 1', 'multiple of 0.25'] },
    floor: { type: 'number', constraints: ['at least -2.5'] },
    ceiling: { type: 'integer', constraints: ['at most 10'] },
    code: { type: 'string', constraints: ['length 3', 'format uuid'] },
    short: { type: 'string', constraints: ['length at most 8'] },
    long: { type: 'string', constraints: ['length at least 2'] },
    label: { type: 'string | null', constraints: ['default: null'] },
    nullable: { type: 'string | null', constraints: [] },
    either: { type: 'integer | boolean', constraints: ['at least 1 (integer)'] },
    both: { type: 'object & object', constraints: [] },
    fixed: { type: 'string', constraints: ['exactly "v1"'] },
    levels: {
      type: 'number | string | null | array',
      constraints: ['one of: 1, 2, max, null, [3]'],
    },
    // Without a type, properties make an object and items a list.
    point: { type: 'object', constraints: [] },
    'point.x': { type: 'number', constraints: [] },
    names: { type: 'array of string', constraints: ['items: length at least 1'] },
    pair: { type: 'array', constraints: ['exactly 2 items'] },
    some: { type: 'array of (string | number)', constraints: ['at least 1 item'] },
    many: { type: 'array', constraints: ['at most 1 item'] },
    closed: { type: 'object', constraints: ['no other keys'] },
    'closed.a': { type: 'string', constraints: [] },
    linked: { type: 'Point', constraints: [] },
    self: { type: 'reference', constraints: [] },
    anything: { type: 'any', constraints: [] },
    shown: { type: 'any', constraints: [] },
  });
});

test('schemaFields takes a schema it cannot read without failing', () => {
  // As the dashboard receives it: JSON, whatever its shape.
  const odd = (value: unknown) => value as JsonSchemaObject;
  expect(schemaFields(odd(null))).toEqual([]);
  expect(schemaFields(odd([]))).toEqual([]);
  expect(schemaFields({ type: 'object' })).toEqual([]);
  expect(schemaFields({ type: 'object', properties: [] })).toEqual([]);
  expect(schemaFields({ type: 'object', properties: { a: 1 }, required: 'a' })).toEqual([
    { name: 'a', type: 'any', required: false, constraints: [] },
  ]);
  expect(
    schemaFields({
      type: 'object',
      properties: {
        a: { type: 7, description: 3, enum: 'x', anyOf: 'y', items: 'z', minimum: '1' },
        b: { type: 'array', items: [{ type: 'string' }] },
        c: { anyOf: [1, { type: 'number' }], description: '' },
      },
      required: ['a', 2],
    }),
  ).toEqual([
    { name: 'a', type: 'any', required: true, constraints: [] },
    { name: 'b', type: 'array', required: false, constraints: [] },
    { name: 'c', type: 'any | number', required: false, constraints: [] },
  ]);

  // A schema nested beyond reason is read to a depth, and no further.
  let deep: JsonSchemaObject = { type: 'string' };
  for (let level = 0; level < 5000; level += 1) {
    deep = { type: 'object', properties: { x: deep }, anyOf: [deep] };
  }
  const fields = schemaFields(deep);
  expect(fields.length).toBeGreaterThan(0);
  expect(fields.length).toBeLessThan(20);
});
