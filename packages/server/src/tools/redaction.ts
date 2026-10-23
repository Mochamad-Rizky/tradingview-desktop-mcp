// What the tool events keep out of the arguments of a call. The events are for people watching the
// calls go by (the dashboard), which keeps hundreds of them, so a tool that takes what should not
// linger there is named here, by name, whatever tools the server offers: a client can name any
// tool, in a call of its own or in a step of batch_run, and the event shows what it sent. A module of
// its own that imports nothing, like the annotations, so that the registry and every tool file can
// read it. The handler gets the arguments as ever.

// Every argument (true) of a tool that takes code or text typed for the user, and the named
// arguments, at any depth, of a tool with one such argument: the message of an alert, which can carry
// the secret of a webhook.
export const REDACTED_ARGUMENTS: Readonly<Record<string, true | readonly string[]>> = Object.freeze(
  {
    ui_evaluate: true,
    ui_type_text: true,
    alert_create: Object.freeze(['message']),
  },
);

// What stands in the event for what it keeps out.
const REDACTED = { redacted: true } as const;

const BATCH_RUN = 'batch_run';

// Deeper than any event shows (it cuts at a smaller depth), and a bound for the walk through what a
// caller in this process might pass, a cycle say.
const MAX_DEPTH = 32;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ruleOf(tool: string): true | readonly string[] | undefined {
  return Object.hasOwn(REDACTED_ARGUMENTS, tool) ? REDACTED_ARGUMENTS[tool] : undefined;
}

// `value` with every property named in `keys` kept out, at any depth.
function withoutKeys(value: unknown, keys: readonly string[], depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withoutKeys(item, keys, depth + 1));
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      keys.includes(key) ? REDACTED : withoutKeys(item, keys, depth + 1),
    ]),
  );
}

// The arguments of batch_run with every step in them redacted the way a call of its tool is: an
// object with a tool name, wherever it is, which is where the steps go and where a client may put
// one beside them. A step carries arguments under any key a client gives it, not only under
// arguments, so every key of it but tool is redacted, and those of a batch in it are steps again.
function withRedactedSteps(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withRedactedSteps(item, depth + 1));
  }
  if (!isObject(value)) {
    return value;
  }
  const { tool } = value;
  if (typeof tool !== 'string') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withRedactedSteps(item, depth + 1)]),
    );
  }
  const rule = ruleOf(tool);
  if (rule !== undefined && rule !== true) {
    return withoutKeys(value, rule, depth);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'tool' ? item : redactedArgs(tool, item, depth + 1),
    ]),
  );
}

// The arguments of a call of `tool` as the tool events show them, before they are cut to size:
// { redacted: true } for a tool that keeps every argument out, the named arguments kept out for one
// that names some, the steps of batch_run each as its tool would show them, and anything else as it
// is. It reads the arguments as the client sent them, before they are validated, and a getter that
// throws makes it throw.
export function redactedArgs(tool: string, args: unknown, depth = 0): unknown {
  const rule = ruleOf(tool);
  if (rule === true) {
    return REDACTED;
  }
  if (rule !== undefined) {
    return withoutKeys(args, rule, depth);
  }
  return tool === BATCH_RUN ? withRedactedSteps(args, depth) : args;
}
