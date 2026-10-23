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

// A tool that changes what the app shows or holds and destroys nothing, each call doing more:
// replay_start and replay_step.
export const CHANGES = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

// A tool that brings the app to a state and destroys nothing: a second call with the same arguments
// leaves it as it is, such as adding a symbol a list holds already, or stopping replay.
export const CHANGES_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// A tool that can change or remove what the user has, each call doing more: a click, a key or a
// text, the removal of drawings or alerts, a new layout in place of the current one.
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

// A tool that can remove what the user has, where a second call with the same arguments removes
// nothing more: removing symbols the list no longer holds, switching to the layout shown already.
export const DESTRUCTIVE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
