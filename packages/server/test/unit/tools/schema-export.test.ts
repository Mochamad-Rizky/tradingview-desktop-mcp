import { z } from 'zod';
import type { Profile } from '../../../src/config/schema.js';
import { allTools } from '../../../src/tools/index.js';
import { selectTools } from '../../../src/tools/registry.js';
import { toolInputJsonSchema, toolProfiles } from '../../../src/tools/schema-export.js';
import { defineTool, type AnyToolDefinition } from '../../../src/tools/types.js';
import type { JsonValue } from '../../../src/utils/json.js';

const PROFILES: Profile[] = ['core', 'full', 'readonly'];

function names(tools: AnyToolDefinition[]): string[] {
  return tools.map(({ name }) => name);
}

function fake(inputSchema: z.ZodRawShape): AnyToolDefinition {
  return defineTool({
    name: 'chart_fake',
    domain: 'chart',
    title: 'Fake',
    description: 'Stands in for a tool.',
    inputSchema,
    annotations: {},
    handler: () => Promise.resolve({ data: null }),
  });
}

function propertiesOf(
  schema: Record<string, JsonValue>,
): Record<string, Record<string, JsonValue>> {
  return schema.properties as Record<string, Record<string, JsonValue>>;
}

test('toolInputJsonSchema describes every registered tool as an object schema with its descriptions', () => {
  for (const tool of allTools) {
    const schema = toolInputJsonSchema(tool);

    expect(schema.type, tool.name).toBe('object');
    expect(schema, tool.name).toHaveProperty('properties');
    const properties = propertiesOf(schema);
    expect(Object.keys(properties), tool.name).toEqual(Object.keys(tool.inputSchema));
    for (const [key, field] of Object.entries(tool.inputSchema)) {
      const description = z.globalRegistry.get(field)?.description;
      expect(description, `${tool.name}.${key}`).toEqual(expect.any(String));
      expect(properties[key]?.description, `${tool.name}.${key}`).toBe(description);
    }
  }
});

test('toolInputJsonSchema builds the schema of a tool once', () => {
  const [first, second] = allTools;
  if (first === undefined || second === undefined) {
    throw new Error('The catalog has fewer than two tools');
  }

  expect(toolInputJsonSchema(first)).toBe(toolInputJsonSchema(first));
  expect(toolInputJsonSchema(second)).not.toBe(toolInputJsonSchema(first));
});

// What a client sends, not what the handler gets: a field with a default may be left out.
test('toolInputJsonSchema describes the input a client sends', () => {
  const schema = toolInputJsonSchema(
    fake({
      text: z.string().describe('The text to show'),
      count: z.number().int().default(1).describe('How many times'),
    }),
  );

  expect(schema.required).toEqual(['text']);
  // The bounds zod writes for an integer are its own business.
  expect(propertiesOf(schema).count).toMatchObject({
    type: 'integer',
    default: 1,
    description: 'How many times',
  });
});

// Whether `value` and everything inside it is frozen.
function deeplyFrozen(value: JsonValue): boolean {
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

// One schema object serves every caller, so none of them may change it for the others.
test('toolInputJsonSchema hands out a schema that no caller can change', () => {
  for (const tool of allTools) {
    expect(deeplyFrozen(toolInputJsonSchema(tool)), tool.name).toBe(true);
  }
  const tool = fake({ text: z.string().describe('The text to show') });
  const schema = toolInputJsonSchema(tool);

  expect(() => {
    schema.type = 'array';
  }).toThrow(TypeError);
  expect(() => {
    propertiesOf(schema).text = {};
  }).toThrow(TypeError);
  expect(toolInputJsonSchema(tool)).toMatchObject({
    type: 'object',
    properties: { text: { type: 'string' } },
  });
});

// The tool list must not fail because one field has no JSON Schema form: such a field accepts
// anything in the description, and the registry still validates it.
test('toolInputJsonSchema describes a field that JSON Schema cannot express as any value', () => {
  const schema = toolInputJsonSchema(
    fake({ when: z.date().describe('A moment'), size: z.bigint().describe('A size') }),
  );

  expect(propertiesOf(schema)).toEqual({
    when: { description: 'A moment' },
    size: { description: 'A size' },
  });
});

test('toolProfiles matches the profile selection of the registry for every tool', () => {
  for (const profile of PROFILES) {
    expect(names(allTools.filter((tool) => toolProfiles(tool).includes(profile))), profile).toEqual(
      names(selectTools(allTools, { profile, patterns: [] })),
    );
  }
  // Every tool is in full; core and readonly take only the tools that say so (design spec 5.4).
  for (const tool of allTools) {
    expect(toolProfiles(tool), tool.name).toEqual([
      'full',
      ...(tool.core === true ? ['core'] : []),
      ...(tool.annotations.readOnlyHint === true ? ['readonly'] : []),
    ]);
  }
});

test('toolProfiles counts only an explicit hint and an explicit core', () => {
  const tool = (annotations: AnyToolDefinition['annotations'], core?: boolean) => ({
    ...fake({}),
    annotations,
    ...(core === undefined ? {} : { core }),
  });

  expect(toolProfiles(tool({}))).toEqual(['full']);
  expect(toolProfiles(tool({ readOnlyHint: false }, false))).toEqual(['full']);
  expect(toolProfiles(tool({ readOnlyHint: true }))).toEqual(['full', 'readonly']);
  expect(toolProfiles(tool({ readOnlyHint: true }, true))).toEqual(['full', 'core', 'readonly']);
  expect(toolProfiles(tool({}, true))).toEqual(['full', 'core']);
});
