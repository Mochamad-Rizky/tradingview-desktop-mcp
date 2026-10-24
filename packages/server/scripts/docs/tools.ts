import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allTools } from '../../src/tools/index.js';
import { toolInputJsonSchema, toolProfiles } from '../../src/tools/schema-export.js';
import type { AnyToolDefinition, Domain } from '../../src/tools/types.js';
import type { JsonObject, JsonValue } from '../../src/utils/json.js';

// Generates docs/tools.md (`pnpm docs:tools`): every tool with its title, hints, profiles,
// description and inputs, written from the tool definitions, so the page cannot say anything the
// code does not. A test compares it with the committed file. Nothing on it depends on the clock.

export const TOOLS_PATH = fileURLToPath(new URL('../../../../docs/tools.md', import.meta.url));

const DOMAIN_TITLES: Record<Domain, string> = {
  app: 'App',
  chart: 'Chart',
  data: 'Market data',
  indicator: 'Indicators',
  pine: 'Pine Script',
  strategy: 'Strategy Tester',
  drawing: 'Drawings',
  alert: 'Alerts',
  watchlist: 'Watchlists',
  layout: 'Layouts',
  pane: 'Panes',
  tab: 'Tabs',
  replay: 'Bar replay',
  screenshot: 'Screenshots',
  ui: 'Low-level UI',
  batch: 'Batch',
};

// How GitHub turns the text of a heading into the anchor that links to it.
function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replaceAll(/\s/g, '-');
}

function escapeCell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll(/\r?\n/g, '<br>');
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// The type of a JSON Schema node as a reader would say it: string, integer, object[], or
// "string or number" for a choice.
function typeOf(node: JsonObject): string {
  if (Array.isArray(node.anyOf)) {
    const names = node.anyOf.map((option) => (isObject(option) ? typeOf(option) : 'any'));
    return [...new Set(names)].join(' or ');
  }
  const type = node.type;
  if (type === 'array') {
    const items = node.items;
    const inner = isObject(items) ? typeOf(items) : 'any';
    return inner.includes(' or ') ? `(${inner})[]` : `${inner}[]`;
  }
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type) && type.length > 0) {
    return type.filter((name) => typeof name === 'string').join(' or ');
  }
  return 'any';
}

// The node an array's members are described by, or the node itself.
function memberOf(node: JsonObject): JsonObject {
  const items = node.items;
  return node.type === 'array' && isObject(items) ? items : node;
}

function formatValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// The constraints, enum and default of a node, as sentences that follow its description.
function notesOf(node: JsonObject): string[] {
  const notes: string[] = [];
  const options = Array.isArray(node.enum) ? node.enum : [];
  if (options.length > 0) {
    notes.push(`One of: ${options.map((option) => `\`${formatValue(option)}\``).join(', ')}.`);
  }
  const { minimum, maximum, minLength, maxLength, minItems, maxItems, pattern } = node;
  const span = (low: JsonValue | undefined, high: JsonValue | undefined, unit: string): void => {
    const hasLow = typeof low === 'number';
    const hasHigh = typeof high === 'number' && high !== MAX_SAFE;
    const suffix = unit === '' ? '' : ` ${unit}`;
    if (hasLow && hasHigh) {
      notes.push(`${String(low)} to ${String(high)}${suffix}.`);
    } else if (hasLow) {
      notes.push(`At least ${String(low)}${suffix}.`);
    } else if (hasHigh) {
      notes.push(`At most ${String(high)}${suffix}.`);
    }
  };
  span(minimum, maximum, '');
  span(minLength, maxLength, 'characters');
  span(minItems, maxItems, 'items');
  if (typeof pattern === 'string') {
    notes.push(`Pattern: \`${pattern}\`.`);
  }
  return notes;
}

// The fields of an object input, for "Fields: `a` (string), `b` (number)", nested one level only
// by name and type.
function fieldsOf(node: JsonObject): string | null {
  const member = memberOf(node);
  const properties = member.properties;
  if (!isObject(properties) || Object.keys(properties).length === 0) {
    return null;
  }
  const required = new Set(stringList(member.required));
  const parts = Object.entries(properties).map(([name, child]) => {
    const type = isObject(child) ? typeOf(child) : 'any';
    return `\`${name}\` (${type}${required.has(name) ? ', required' : ''})`;
  });
  return `Fields: ${parts.join(', ')}.`;
}

function inputRow(name: string, node: JsonObject, required: boolean): string {
  const description = typeof node.description === 'string' ? node.description : '';
  const parts: string[] = description === '' ? [] : [description];
  const notes = notesOf(node);
  // A node with a pattern or a range at its items (an array of strings) carries them there.
  const items = node.items;
  if (isObject(items)) {
    notes.push(...notesOf(items).map((note) => `Each item: ${note.replace(/^One of/, 'one of')}`));
  }
  parts.push(...notes);
  const fields = fieldsOf(node);
  if (fields !== null) {
    parts.push(fields);
  }
  // The text of a description often states the default itself; it is not said twice.
  if ('default' in node && !/default/i.test(description)) {
    const value = node.default;
    parts.push(`Default: \`${formatValue(value ?? null)}\`.`);
  }
  return `| \`${name}\` | ${escapeCell(typeOf(node))} | ${required ? 'yes' : 'no'} | ${escapeCell(parts.join(' '))} |`;
}

function renderInputs(tool: AnyToolDefinition): string {
  const schema = toolInputJsonSchema(tool);
  const properties = schema.properties;
  if (!isObject(properties) || Object.keys(properties).length === 0) {
    return 'No inputs.';
  }
  const required = new Set(stringList(schema.required));
  const rows = Object.entries(properties).map(([name, node]) =>
    inputRow(name, isObject(node) ? node : {}, required.has(name)),
  );
  return ['| Input | Type | Required | Description |', '| --- | --- | --- | --- |', ...rows].join(
    '\n',
  );
}

function badgesOf(tool: AnyToolDefinition): string {
  const { readOnlyHint, destructiveHint, idempotentHint } = tool.annotations;
  const badges: string[] = [];
  if (readOnlyHint === true) {
    badges.push('Read-only');
  }
  if (destructiveHint === true) {
    badges.push('Destructive');
  }
  if (idempotentHint === true) {
    badges.push('Idempotent');
  }
  badges.push(...toolProfiles(tool).filter((profile) => profile !== 'full'));
  return badges.length === 0 ? '' : badges.map((badge) => `\`${badge}\``).join(' ');
}

function plural(count: number): string {
  return `${String(count)} ${count === 1 ? 'tool' : 'tools'}`;
}

export function renderToolReference(tools: readonly AnyToolDefinition[]): string {
  const domains: Domain[] = [];
  for (const { domain } of tools) {
    if (!domains.includes(domain)) {
      domains.push(domain);
    }
  }
  const countIn = (profile: 'core' | 'readonly'): number =>
    tools.filter((tool) => toolProfiles(tool).includes(profile)).length;

  const headingOf = (domain: Domain): string =>
    `${DOMAIN_TITLES[domain]} (${plural(tools.filter((tool) => tool.domain === domain).length)})`;

  const blocks: string[] = [
    '# Tool reference',
    'Generated by `pnpm docs:tools` from the tool definitions. Do not edit it by hand.',
    `${String(tools.length)} tools: ${String(countIn('core'))} in the core profile, ${String(countIn('readonly'))} in the readonly profile.`,
    domains.map((domain) => `- [${headingOf(domain)}](#${anchorOf(headingOf(domain))})`).join('\n'),
  ];

  for (const domain of domains) {
    blocks.push(`## ${headingOf(domain)}`);
    for (const tool of tools.filter((candidate) => candidate.domain === domain)) {
      blocks.push(`### ${tool.name}`, `**${tool.title}**`);
      const badges = badgesOf(tool);
      if (badges !== '') {
        blocks.push(badges);
      }
      blocks.push(tool.description.trim(), renderInputs(tool));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

function main(): void {
  writeFileSync(TOOLS_PATH, renderToolReference(allTools));
  process.stdout.write(`Wrote ${TOOLS_PATH} (${String(allTools.length)} tools)\n`);
}

// Whether this module is the script that node was started with (`pnpm docs:tools`) and not a
// module that a test imports.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
