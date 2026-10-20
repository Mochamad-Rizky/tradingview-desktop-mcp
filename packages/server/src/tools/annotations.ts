// The annotation sets that the tool definitions share (design spec 5.1). They live in a module of
// their own that imports nothing, so that every tool file can use them without importing another
// tool file.

// A tool that only reads: it changes nothing, so calling it again changes nothing more, and it
// reaches nothing beyond the local app. It is also what the readonly profile keeps.
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
