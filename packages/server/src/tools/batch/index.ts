import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TvMcpError } from '../../core/errors.js';
import type { JsonObject } from '../../utils/json.js';
import { CLIENT_SAFE_BUDGET_MS } from '../chart/strategies.js';
import { defineTool, type AnyToolDefinition, type ToolContext, type ToolOutput } from '../types.js';

const BATCH_RUN = 'batch_run';
const MAX_STEPS = 20;

// The envelope the registry built for a step. Its fields are copied into the outcome of the step,
// so a step reads like a direct call of its tool.
const stepEnvelope = z.record(z.string(), z.json());

// Read back in the JSON form a client of a direct call receives, so a value JSON cannot carry (a
// NaN a handler computed, say) comes out as null there too instead of failing the batch.
function envelopeOf(result: CallToolResult): JsonObject {
  return stepEnvelope.parse(JSON.parse(JSON.stringify(result.structuredContent)));
}

export const batchRun = defineTool({
  name: BATCH_RUN,
  domain: 'batch',
  title: 'Run tools in a batch',
  description:
    'Runs up to 20 tool calls one after another and returns the outcome of each. Use it to chain ' +
    'steps that would otherwise take several requests, for example switching the symbol and then ' +
    'the timeframe. Every step is validated and runs exactly like a direct call of its tool, so ' +
    'it needs the same arguments, confirmations included. By default the first step that fails ' +
    'stops the batch and the remaining steps are skipped; set stopOnError to false to run them ' +
    'all. batch_run cannot be one of its own steps. Steps run in order, so the batch takes as ' +
    'long as its steps together, and no step starts once 45 s have gone by, so that no client ' +
    'gives up on the call and sends its steps again: the steps not started come back as a ' +
    'warning, to send in another batch. Returns steps (one entry per step that ran, with tool, ' +
    'ok, and data or error), completed (how many steps ran) and stopped (true when the rest were ' +
    'skipped, after a failure or for the time).',
  inputSchema: {
    steps: z
      .array(
        z.object({
          tool: z.string().describe('Name of the tool to run, for example chart_set_symbol.'),
          arguments: z
            .record(z.string(), z.unknown())
            .default({})
            .describe('Arguments for that tool, as its input schema describes them. Default: {}.'),
        }),
      )
      .min(1)
      .max(MAX_STEPS)
      .describe('The tool calls to make, in the order they should run (1 to 20).'),
    stopOnError: z
      .boolean()
      .default(true)
      .describe(
        'Stop at the first step that fails and skip the rest (default true). With false, every ' +
          'step runs whatever happened before it.',
      ),
  },
  annotations: {
    // Its steps can change the chart and delete objects, so it promises nothing a step does not.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  core: true,
  // In the tool events, a step shows what a call of its tool would (redaction.ts).
  handler: (input, ctx) => runBatch(input, ctx),
});

// What batch_run does, within budgetMs from its start, timed by now (a test gives its own): no step
// starts once the budget is spent, since a client that gave up on the call would send the steps
// again, and those that ran would run twice. A step that runs when the budget runs out is waited
// for.
export async function runBatch(
  {
    steps,
    stopOnError,
  }: { steps: { tool: string; arguments: Record<string, unknown> }[]; stopOnError: boolean },
  ctx: ToolContext,
  budgetMs: number = CLIENT_SAFE_BUDGET_MS,
  now: () => number = () => performance.now(),
): Promise<ToolOutput<JsonObject>> {
  const startedAt = now();
  // Checked for every step before the first one runs: a batch refused halfway would have left the
  // steps before the refusal done.
  const nested = steps.flatMap((step, index) => (step.tool === BATCH_RUN ? [index] : []));
  if (nested.length > 0) {
    throw new TvMcpError('INVALID_INPUT', 'batch_run cannot run batch_run as a step', {
      hint: 'Put the steps of the inner batch into this one, or send them as a batch of their own.',
      details: { steps: nested },
    });
  }

  const outcomes: JsonObject[] = [];
  const images: ImageContent[] = [];
  let outOfTime = false;
  for (const step of steps) {
    if (now() - startedAt >= budgetMs) {
      outOfTime = true;
      break;
    }
    // Through the registry, so the step is validated and logged like a direct call of its tool.
    const result = await ctx.registry.call(step.tool, step.arguments, 'batch');
    outcomes.push({ tool: step.tool, ...envelopeOf(result) });
    images.push(...result.content.filter((block) => block.type === 'image'));
    if (result.isError === true && stopOnError) {
      break;
    }
  }

  const left = steps.length - outcomes.length;
  return {
    // One outcome per step that ran, in order. `completed` counts them, and `stopped` says that a
    // failure, or the time, skipped the steps after them.
    data: {
      steps: outcomes,
      completed: outcomes.length,
      stopped: left > 0,
    },
    images,
    warnings: outOfTime
      ? [
          `Ran ${String(outcomes.length)} of ${String(steps.length)} steps within the ` +
            `${String(budgetMs / 1000)} s a call allows, and started none after that: send the ` +
            `other ${String(left)} in another batch_run.`,
        ]
      : [],
  };
}

export const batchTools: AnyToolDefinition[] = [batchRun];
