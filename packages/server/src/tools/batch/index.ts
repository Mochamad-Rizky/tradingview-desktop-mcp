import type { CallToolResult, ImageContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TvMcpError } from '../../core/errors.js';
import type { JsonObject } from '../../utils/json.js';
import { defineTool, type AnyToolDefinition } from '../types.js';

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
    'long as its steps together. Returns steps (one entry per step that ran, with tool, ok, and ' +
    'data or error), completed (how many steps ran) and stopped (true when a failure skipped the ' +
    'rest).',
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
  // In the tool events, a step of a tool that keeps its arguments out of them (ui_evaluate,
  // ui_type_text) shows { redacted: true } in their place, as a call of that tool would. Arguments
  // that are no list of steps show as they are: the call refuses them anyway.
  eventArgs(args, redacts) {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return args;
    }
    const { steps } = args as { steps?: unknown };
    if (!Array.isArray(steps)) {
      return args;
    }
    return {
      ...args,
      steps: steps.map((step: unknown) => {
        const tool: unknown =
          typeof step === 'object' && step !== null ? (step as { tool?: unknown }).tool : undefined;
        return typeof tool === 'string' && redacts(tool)
          ? { ...(step as object), arguments: { redacted: true } }
          : step;
      }),
    };
  },
  async handler({ steps, stopOnError }, ctx) {
    // Checked for every step before the first one runs: a batch refused halfway would have left
    // the steps before the refusal done.
    const nested = steps.flatMap((step, index) => (step.tool === BATCH_RUN ? [index] : []));
    if (nested.length > 0) {
      throw new TvMcpError('INVALID_INPUT', 'batch_run cannot run batch_run as a step', {
        hint:
          'Put the steps of the inner batch into this one, or send them as a batch of their ' +
          'own.',
        details: { steps: nested },
      });
    }

    const outcomes: JsonObject[] = [];
    const images: ImageContent[] = [];
    for (const step of steps) {
      // Through the registry, so the step is validated and logged like a direct call of its tool.
      const result = await ctx.registry.call(step.tool, step.arguments, 'batch');
      outcomes.push({ tool: step.tool, ...envelopeOf(result) });
      images.push(...result.content.filter((block) => block.type === 'image'));
      if (result.isError === true && stopOnError) {
        break;
      }
    }

    return {
      // One outcome per step that ran, in order. `completed` counts them, and `stopped` says that
      // a failure skipped the steps after it.
      data: {
        steps: outcomes,
        completed: outcomes.length,
        stopped: outcomes.length < steps.length,
      },
      images,
    };
  },
});

export const batchTools: AnyToolDefinition[] = [batchRun];
