import type { DashboardTool, JsonSchemaObject } from '@contract';

// Input schemas as the server sends them for a few of its tools: what zod writes with toJSONSchema
// in input mode, descriptions cut short. They hold the shapes the schema reader has to handle:
// nested objects, arrays of objects, unions (anyOf), records (propertyNames and
// additionalProperties), and the safe-integer bounds zod puts on every integer.

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

const chartIndex = {
  description:
    'Which chart of a multi-chart layout, counted from 0. Leave it out for the active chart.',
  type: 'integer',
  minimum: 0,
  maximum: 9007199254740991,
};

const time = {
  anyOf: [{ type: 'string', minLength: 1, maxLength: 64 }, { type: 'number' }],
  description: 'When: ISO 8601 date/time or Unix timestamp in seconds/milliseconds.',
};

export const chartSetSymbolSchema: JsonSchemaObject = {
  $schema: SCHEMA,
  type: 'object',
  properties: {
    symbol: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Symbol to show, best in the EXCHANGE:SYMBOL form such as NASDAQ:AAPL.',
    },
    chartIndex,
  },
  required: ['symbol'],
};

export const SHAPES = [
  'horizontal_line',
  'vertical_line',
  'horizontal_ray',
  'trend_line',
  'ray',
  'extended',
  'arrow',
  'rectangle',
  'circle',
  'ellipse',
  'triangle',
  'parallel_channel',
  'fib_retracement',
  'text',
  'note',
  'price_label',
  'arrow_up',
  'arrow_down',
  'flag',
];

export const COLOR_PATTERN =
  '^(?:#[0-9a-fA-F]{6}|rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(?:,\\s*(?:0|1|0?\\.\\d+|1\\.0+)\\s*)?\\))$';

export const drawingCreateSchema: JsonSchemaObject = {
  $schema: SCHEMA,
  type: 'object',
  properties: {
    shape: {
      type: 'string',
      enum: SHAPES,
      description: 'What to draw, one of the curated shapes.',
    },
    points: {
      minItems: 1,
      maxItems: 10,
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time,
          price: { type: 'number', description: 'The price, on the price scale of the chart.' },
        },
        required: ['time', 'price'],
      },
      description: 'Where to draw, as many points as the shape takes.',
    },
    text: {
      description: 'The text of the drawing. Default: none.',
      type: 'string',
      minLength: 1,
      maxLength: 5000,
    },
    style: {
      description: 'The look of the drawing.',
      type: 'object',
      properties: {
        color: { description: 'The color.', type: 'string', pattern: COLOR_PATTERN },
        lineWidth: {
          description: 'The line width, 1 to 4.',
          type: 'integer',
          minimum: 1,
          maximum: 4,
        },
        lineStyle: {
          description: 'solid, dotted or dashed.',
          type: 'string',
          enum: ['solid', 'dotted', 'dashed'],
        },
        fontSize: {
          description: 'The font size, 8 to 40.',
          type: 'integer',
          minimum: 8,
          maximum: 40,
        },
      },
    },
    chartIndex,
  },
  required: ['shape', 'points'],
};

export const batchRunSchema: JsonSchemaObject = {
  $schema: SCHEMA,
  type: 'object',
  properties: {
    steps: {
      minItems: 1,
      maxItems: 20,
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Name of the tool to run.' },
          arguments: {
            default: {},
            description: 'Arguments for that tool. Default: {}.',
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: {},
          },
        },
        required: ['tool'],
      },
      description: 'The tool calls to make, in order (1 to 20).',
    },
    stopOnError: {
      default: true,
      description: 'Stop at the first step that fails (default true).',
      type: 'boolean',
    },
  },
  required: ['steps'],
};

export const indicatorAddSchema: JsonSchemaObject = {
  $schema: SCHEMA,
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200, description: 'The indicator.' },
    inputs: {
      description: 'Input values by input id or name.',
      type: 'object',
      propertyNames: { type: 'string', minLength: 1, maxLength: 200 },
      additionalProperties: {
        anyOf: [{ type: 'string', maxLength: 10000 }, { type: 'number' }, { type: 'boolean' }],
      },
    },
    chartIndex,
  },
  required: ['name'],
};

export const alertDeleteSchema: JsonSchemaObject = {
  $schema: SCHEMA,
  type: 'object',
  properties: {
    alertIds: {
      minItems: 1,
      maxItems: 50,
      type: 'array',
      items: { type: 'string', pattern: '^[1-9]\\d{0,14}$' },
      description: 'The ids of the alerts to delete: 1 to 50 of them.',
    },
    confirm: { description: 'Must be true to delete an alert of the user.', type: 'boolean' },
  },
};

export const drawingCreate: DashboardTool = {
  name: 'drawing_create',
  domain: 'drawing',
  title: 'Create a drawing',
  description: 'Draws on a chart, as the drawing tools of TradingView would.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  profiles: ['full', 'core'],
  inputSchema: drawingCreateSchema,
};
