// Tool results, error details and page-function return values all cross a JSON boundary (MCP
// text blocks, CDP returnByValue). Typing them as JSON instead of unknown turns an accidental
// Date, Map or undefined into a compile error rather than a silently dropped field.
export type JsonPrimitive = string | number | boolean | null;

// The object arm stays an inline index signature: TypeScript rejects a cycle that goes through
// the Record alias (TS2456), but accepts one through an object type literal.
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

// Values typed with an interface are not assignable here, because interfaces have no implicit
// index signature. Declare payload shapes as type aliases.
export type JsonObject = Record<string, JsonValue>;
