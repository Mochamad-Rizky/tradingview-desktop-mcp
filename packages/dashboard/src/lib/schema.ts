import type { JsonSchemaObject, JsonValue } from '@contract';
import { formatCount } from './format';
import { isJsonObject } from './tool-result';

// The input fields of a tool, read from the JSON Schema that zod writes for its input: what each
// field takes and what it must satisfy. The server validates every call with the zod schema
// itself, so this is a reference for the reader, never a check. Whatever shape the schema has, it
// is read without failing: a part this reader does not know counts as any value.

export interface SchemaField {
  // The path of the field: points[].time for the time of each point, style.color for the color of
  // the style.
  name: string;
  type: string;
  // Required in the object that holds it.
  required: boolean;
  description?: string;
  constraints: string[];
}

type Schema = Record<string, JsonValue>;

// How deep nested objects are listed, and how deep a type or a constraint is followed.
const MAX_FIELD_DEPTH = 5;
const MAX_TYPE_DEPTH = 8;

// The bounds zod states for every integer: they say nothing about the field.
const SAFE_BOUNDS = new Set([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);

// A part of a schema as a schema: `true`, `{}` and anything this reader cannot read accept any
// value.
function asSchema(value: JsonValue | undefined): Schema {
  return isJsonObject(value) ? value : {};
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function union(schema: Schema): JsonValue[] | null {
  const members = schema.anyOf ?? schema.oneOf;
  return Array.isArray(members) ? members : null;
}

function jsonType(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

// What a field takes, such as string, integer | null or array of object.
function typeOf(schema: Schema, depth = 0): string {
  if (depth > MAX_TYPE_DEPTH) {
    return 'any';
  }
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    // The name of a definition (#/$defs/Point), or the schema itself (#).
    const name = ref.slice(ref.lastIndexOf('/') + 1);
    return name === '' || name === '#' ? 'reference' : name;
  }
  const members = union(schema);
  if (members !== null) {
    return unique(members.map((member) => typeOf(asSchema(member), depth + 1))).join(' | ');
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map((member) => typeOf(asSchema(member), depth + 1)).join(' & ');
  }
  const { type } = schema;
  let names: string[] = [];
  if (typeof type === 'string') {
    names = [type];
  } else if (Array.isArray(type)) {
    names = type.filter((name) => typeof name === 'string');
  } else if (schema.const !== undefined) {
    names = [jsonType(schema.const)];
  } else if (Array.isArray(schema.enum)) {
    names = unique(schema.enum.map(jsonType));
  } else if (isJsonObject(schema.properties)) {
    names = ['object'];
  } else if (isJsonObject(schema.items)) {
    names = ['array'];
  }
  if (names.length === 0) {
    return 'any';
  }
  return names
    .map((name) => {
      if (name !== 'array' || !isJsonObject(schema.items)) {
        return name;
      }
      const items = typeOf(schema.items, depth + 1);
      return `array of ${items.includes(' ') ? `(${items})` : items}`;
    })
    .join(' | ');
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// A number as the reference writes it: whole numbers with grouped digits.
function formatNumber(value: number): string {
  return Number.isInteger(value) ? formatCount(value) : String(value);
}

// "1 to 500", "at least 1" or "at most 500"; null without either bound.
function between(min: number | undefined, max: number | undefined): string | null {
  if (min !== undefined && max !== undefined) {
    return `${formatNumber(min)} to ${formatNumber(max)}`;
  }
  if (min !== undefined) {
    return `at least ${formatNumber(min)}`;
  }
  return max === undefined ? null : `at most ${formatNumber(max)}`;
}

function itemCount(min: number | undefined, max: number | undefined): string | null {
  if (min !== undefined && min === max) {
    return `exactly ${formatNumber(min)} ${min === 1 ? 'item' : 'items'}`;
  }
  const range = between(min, max);
  if (range === null) {
    return null;
  }
  return `${range} ${(max ?? min) === 1 ? 'item' : 'items'}`;
}

function literal(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// What a value must satisfy, in words: its range, length, count of items, allowed values, pattern
// and default, and those of the members of a union, the items of a list and the keys and values
// of a record.
function constraintsOf(schema: Schema, depth = 0): string[] {
  if (depth > MAX_TYPE_DEPTH) {
    return [];
  }
  const out: string[] = [];
  const add = (text: string | null) => {
    if (text !== null) {
      out.push(text);
    }
  };
  const bound = (value: JsonValue | undefined) => {
    const found = number(value);
    return found === undefined || SAFE_BOUNDS.has(found) ? undefined : found;
  };

  add(between(bound(schema.minimum), bound(schema.maximum)));
  const above = number(schema.exclusiveMinimum);
  add(above === undefined ? null : `more than ${formatNumber(above)}`);
  const below = number(schema.exclusiveMaximum);
  add(below === undefined ? null : `less than ${formatNumber(below)}`);

  const minLength = number(schema.minLength);
  const maxLength = number(schema.maxLength);
  if (minLength !== undefined && minLength === maxLength) {
    add(`length ${formatNumber(minLength)}`);
  } else {
    const length = between(minLength, maxLength);
    add(length === null ? null : `length ${length}`);
  }
  add(itemCount(number(schema.minItems), number(schema.maxItems)));

  if (Array.isArray(schema.enum)) {
    add(`one of: ${schema.enum.map(literal).join(', ')}`);
  }
  if (schema.const !== undefined) {
    add(`exactly ${JSON.stringify(schema.const)}`);
  }
  if (typeof schema.pattern === 'string') {
    add(`pattern ${schema.pattern}`);
  }
  if (typeof schema.format === 'string') {
    add(`format ${schema.format}`);
  }
  const step = number(schema.multipleOf);
  add(step === undefined ? null : `multiple of ${formatNumber(step)}`);

  // What a member of a union must satisfy holds when the value is of that member's type.
  const members = union(schema);
  if (members !== null) {
    for (const member of members.map(asSchema)) {
      const type = typeOf(member, depth + 1);
      for (const each of constraintsOf(member, depth + 1)) {
        add(members.length > 1 ? `${each} (${type})` : each);
      }
    }
  }
  // The items of a list of objects are fields of their own; those of any other list are said here.
  if (isJsonObject(schema.items) && !isJsonObject(schema.items.properties)) {
    for (const each of constraintsOf(schema.items, depth + 1)) {
      add(`items: ${each}`);
    }
  }
  if (isJsonObject(schema.propertyNames)) {
    for (const each of constraintsOf(schema.propertyNames, depth + 1)) {
      add(`keys: ${each}`);
    }
  }
  const values = schema.additionalProperties;
  if (values === false) {
    add('no other keys');
  } else if (isJsonObject(values) && Object.keys(values).length > 0) {
    add(`values: ${typeOf(values, depth + 1)}`);
    for (const each of constraintsOf(values, depth + 1)) {
      add(`values: ${each}`);
    }
  }

  if (schema.default !== undefined) {
    add(`default: ${JSON.stringify(schema.default)}`);
  }
  return out;
}

// The object whose properties are the fields below `schema`: its own, or those of each item of a
// list of objects.
function nested(schema: Schema): { object: Schema; path: string } | null {
  if (isJsonObject(schema.properties)) {
    return { object: schema, path: '.' };
  }
  const { items } = schema;
  if (isJsonObject(items) && isJsonObject(items.properties)) {
    return { object: items, path: '[].' };
  }
  return null;
}

function addFields(object: Schema, prefix: string, depth: number, out: SchemaField[]): void {
  const { properties, required } = object;
  if (!isJsonObject(properties)) {
    return;
  }
  const requiredKeys = new Set(
    Array.isArray(required) ? required.filter((key) => typeof key === 'string') : [],
  );
  for (const [key, value] of Object.entries(properties)) {
    const schema = asSchema(value);
    const name = `${prefix}${key}`;
    const field: SchemaField = {
      name,
      type: typeOf(schema),
      required: requiredKeys.has(key),
      constraints: constraintsOf(schema),
    };
    if (typeof schema.description === 'string' && schema.description !== '') {
      field.description = schema.description;
    }
    out.push(field);
    const below = nested(schema);
    if (below !== null && depth < MAX_FIELD_DEPTH) {
      addFields(below.object, `${name}${below.path}`, depth + 1, out);
    }
  }
}

// The fields of a tool's input schema, in the order the schema lists them, each followed by the
// fields nested in it.
export function schemaFields(schema: JsonSchemaObject): SchemaField[] {
  const fields: SchemaField[] = [];
  // The schema comes from the server as JSON, so it is checked like any JSON.
  const root: JsonValue = schema;
  if (isJsonObject(root)) {
    addFields(root, '', 0, fields);
  }
  return fields;
}
