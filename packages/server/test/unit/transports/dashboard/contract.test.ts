import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Profile, TransportKind } from '../../../../src/config/schema.js';
import type { HealthReport } from '../../../../src/core/connection.js';
import type { ErrorCode } from '../../../../src/core/errors.js';
import type { ToolCallEvent } from '../../../../src/core/events.js';
import type { toolInputJsonSchema, toolProfiles } from '../../../../src/tools/schema-export.js';
import type { Domain } from '../../../../src/tools/types.js';
import type {
  DashboardCallRequest,
  DashboardCallResult,
  DashboardError,
  DashboardEvent,
  DashboardHealth,
  DashboardInfo,
  DashboardTool,
  DashboardToolList,
  JsonSchemaObject,
  JsonValue,
} from '../../../../src/transports/dashboard/contract.js';
import type { JsonValue as ServerJsonValue } from '../../../../src/utils/json.js';

// The content blocks the registry puts in a result: text, and images in front of it.
type ServerBlock = Extract<CallToolResult['content'][number], { type: 'text' | 'image' }>;

// The assertions are checked by the type checker (pnpm typecheck); at run time they do nothing.
test("the dashboard contract accepts the server's own types", () => {
  expectTypeOf<HealthReport>().toExtend<DashboardHealth>();
  expectTypeOf<ToolCallEvent>().toExtend<DashboardEvent>();
  expectTypeOf<{
    content: ServerBlock[];
    isError?: boolean;
  }>().toExtend<DashboardCallResult>();
  expectTypeOf<ServerBlock>().toExtend<DashboardCallResult['content'][number]>();
});

// Assignable one way only, the contract could lack a field the server added. These fail as soon as
// the two differ in a field, an optional one included.
test('the dashboard contract mirrors the server types field for field', () => {
  expectTypeOf<DashboardHealth>().toEqualTypeOf<HealthReport>();
  expectTypeOf<DashboardEvent>().toEqualTypeOf<ToolCallEvent>();
  expectTypeOf<DashboardEvent['errorCode']>().toEqualTypeOf<ErrorCode | undefined>();
  expectTypeOf<DashboardInfo['profile']>().toEqualTypeOf<Profile>();
  expectTypeOf<DashboardInfo['transport']>().toEqualTypeOf<TransportKind>();
  expectTypeOf<DashboardTool['domain']>().toEqualTypeOf<Domain>();
  expectTypeOf<DashboardTool['profiles']>().toEqualTypeOf<ReturnType<typeof toolProfiles>>();
  expectTypeOf<DashboardTool['inputSchema']>().toEqualTypeOf<
    ReturnType<typeof toolInputJsonSchema>
  >();
  expectTypeOf<JsonValue>().toEqualTypeOf<ServerJsonValue>();
});

// So the API can hand them to anything that takes JSON, an event stream included, without a cast.
test('every contract type is JSON', () => {
  expectTypeOf<DashboardInfo>().toExtend<JsonValue>();
  expectTypeOf<DashboardHealth>().toExtend<JsonValue>();
  expectTypeOf<DashboardEvent>().toExtend<JsonValue>();
  expectTypeOf<ToolCallEvent>().toExtend<JsonValue>();
  expectTypeOf<DashboardTool>().toExtend<JsonValue>();
  expectTypeOf<DashboardToolList>().toExtend<JsonValue>();
  expectTypeOf<DashboardCallRequest>().toExtend<JsonValue>();
  expectTypeOf<DashboardCallResult>().toExtend<JsonValue>();
  expectTypeOf<DashboardError>().toExtend<JsonValue>();
  expectTypeOf<JsonSchemaObject>().toExtend<JsonValue>();
});

// The dashboard type-checks the contract on its own, where no server module resolves.
test('the dashboard contract imports nothing', () => {
  const source = readFileSync(
    new URL('../../../../src/transports/dashboard/contract.ts', import.meta.url),
    'utf8',
  );

  expect(source).not.toMatch(/^\s*import\b/m);
  expect(source).not.toMatch(/\bfrom\s+['"]/);
  expect(source).not.toMatch(/\bimport\s*\(/);
  expect(source).not.toMatch(/\brequire\s*\(/);
  expect(source).not.toMatch(/\/\/\/\s*<reference/);
});
