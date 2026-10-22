import { z } from 'zod';
import { isTvMcpError, TvMcpError } from '../../core/errors.js';
import { defineTool } from '../types.js';
import { evaluateExpression } from './page.js';

// ui_evaluate, the opt-in power tool of the low-level interface (design spec 5.3, rules 4 and 5):
// JavaScript a client wrote, run in the chart tab of the user's live, signed-in TradingView. It is
// off unless the user started the server with TV_MCP_ALLOW_EVAL=true (--allow-eval), it runs in the
// chart tab only and never in the window chrome, whose renderer has Node integration, and it refuses
// before anything is sent an expression that names a credential, identity, storage, network or Node
// surface. That denylist reads the text of the expression, so a name built while the code runs gets
// past it; the page function therefore also never writes out the objects that hold the user and
// the credentials (EVAL_WITHHELD_GLOBALS), whatever the code reached them by. Neither the expression
// nor its value is ever logged.

export type EvalDeniedCategory =
  'tvd' | 'identity' | 'cookies' | 'storage' | 'credentials' | 'network' | 'node';

// A name in a pattern below is a whole word unless it is said otherwise: no letter, digit or $
// next to it, while an underscore may be, so that __TVD__ and user_id count.
// The names in `names` are looked for in the squashed reading of the text as they are written in
// JavaScript, capitals and all (see readings).
const DENIED: readonly {
  category: EvalDeniedCategory;
  surface: string;
  patterns: readonly RegExp[];
  names?: readonly string[];
}[] = [
  {
    category: 'tvd',
    surface: 'the desktop bridge of TradingView (TVD), which holds the credentials of the user',
    patterns: [/(?<![a-z0-9$])tvd(?![a-z0-9$])/i],
    names: ['TVD'],
  },
  {
    category: 'identity',
    surface: 'the user object and the identity of the user (user ids and names, session ids)',
    patterns: [/(?<![a-z0-9$])user(?![a-z0-9$])/i, /user_?(?:id|name)/i, /session_?id/i],
  },
  {
    category: 'cookies',
    surface: 'the cookies of the page',
    patterns: [/cookie/i],
    names: ['cookie'],
  },
  {
    category: 'storage',
    surface: 'the storage of the page (localStorage, sessionStorage, indexedDB)',
    patterns: [/localstorage/i, /sessionstorage/i, /indexeddb/i],
    names: ['localStorage', 'sessionStorage', 'indexedDB'],
  },
  {
    category: 'credentials',
    surface: 'credentials (passwords, tokens, signing in and authentication)',
    // auth, but not author or authority: authorization and authorise still count. A sign-in inside
    // a camelCase name, such as showSignInDialog, is told by its capital S, the one pattern that
    // does not ignore case.
    patterns: [
      /credential/i,
      /(?<![a-z0-9$])sign_?in/i,
      /Sign_?[Ii]n/,
      /passw(?:or)?d/i,
      /token/i,
      /auth(?!or(?!i[sz]))/i,
    ],
    names: ['getCredentials', 'setCredentials', 'insertCredentialsText'],
  },
  {
    category: 'network',
    surface:
      'requests to the network (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, import())',
    patterns: [
      /(?<![a-z0-9$])fetch/i,
      /xmlhttprequest/i,
      /websocket/i,
      /eventsource/i,
      /sendbeacon/i,
      /(?<![a-z0-9$])import(?![a-z0-9$])/i,
    ],
  },
  {
    category: 'node',
    surface: 'Node.js (require, the process object, child_process, electron)',
    patterns: [
      /(?<![a-z0-9$])require(?![a-z0-9$])/i,
      /(?<![a-z0-9$])process(?![a-z0-9$])/i,
      /child_process/i,
      /electron/i,
    ],
  },
];

// What ui_evaluate refuses, as one list of patterns, each matched against the text of an expression
// read three ways (see deniedSurface), all of them ignoring case but the one for a sign-in inside a
// camelCase name. Frozen, so that no caller can shorten it.
export const EVAL_DENYLIST: readonly RegExp[] = Object.freeze(
  DENIED.flatMap(({ patterns }) => patterns),
);

// The names of the riskiest surfaces, which ui_evaluate also looks for in the squashed reading of
// an expression, as JavaScript writes them (see deniedSurface). Frozen as well.
export const EVAL_DENIED_NAMES: readonly string[] = Object.freeze(
  DENIED.flatMap(({ names }) => names ?? []),
);

// The globals of the page whose objects never come back in a value of ui_evaluate: the user object,
// the desktop bridge and the storage of the page (evaluateExpression).
export const EVAL_WITHHELD_GLOBALS: readonly string[] = Object.freeze([
  'user',
  'TVD',
  'localStorage',
  'sessionStorage',
  'TVLocalStorage',
  'indexedDB',
  'cookieStore',
]);

// How much JSON a value of ui_evaluate takes up at most, in bytes of UTF-8: 100 kB.
export const EVAL_MAX_RESULT_BYTES = 100_000;

const MAX_EXPRESSION = 10_000;

// The two quotes of strings joined with +, and what lies between them besides the +: white space
// and comments.
const SEAM =
  /(['"`])(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\+(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*(['"`])/g;

function fromCodePoint(hex: string): string {
  const code = Number.parseInt(hex, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

// The text of an expression, read the ways the denylist looks at it:
// - as it is, which keeps every word of the expression, since the other readings could hide one;
// - decoded: its escapes written as the characters they stand for (\x54, \u0054 and \u{0054},
//   with any number of zeros, are T, in a string as in a name; an octal escape likewise; a backslash
//   that ends a line inside a string, before a CR, an LF, both, or a line or paragraph separator,
//   stands for nothing; any other escaped character is itself);
// - joined: the decoded text with the strings that + joins written as one ('T' + 'VD' is 'TVD',
//   comments between them too) and a string put into a template as its text;
// - squashed: the decoded text without white space, quotes, backticks, +, brackets, the ${ and }
//   of templates and .concat(, in which only the names of the riskiest surfaces are looked for:
//   'T'.concat('VD') reads TVD there.
function readings(expression: string): {
  texts: [string, string, string];
  squashed: string;
} {
  const decoded = expression
    .replace(/\\u\{0*([0-9a-f]{1,6})\}/gi, (_match, hex: string) => fromCodePoint(hex))
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => fromCodePoint(hex))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => fromCodePoint(hex))
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8) & 0xff),
    )
    .replace(/\\(?:\r\n|[\r\n\u2028\u2029])/g, '')
    .replace(/\\([\s\S])/g, '$1');
  const joined = decoded.replace(/\$\{\s*(['"`])([^'"`]*)\1\s*\}/g, '$2').replace(SEAM, '');
  const squashed = decoded
    .replace(/\s+/g, '')
    .replace(/\.concat\(/g, '')
    .replace(/\$\{/g, '')
    .replace(/['"`+[\]}]/g, '');
  return { texts: [expression, decoded, joined], squashed };
}

// The surface an expression names that ui_evaluate refuses, by its category and in words, or null
// for none. It reads only the text: it is best effort, and a name built while the code runs gets
// past it.
export function deniedSurface(
  expression: string,
): { category: EvalDeniedCategory; surface: string } | null {
  const { texts, squashed } = readings(expression);
  for (const { category, surface, patterns, names = [] } of DENIED) {
    if (
      patterns.some((pattern) => texts.some((text) => pattern.test(text))) ||
      names.some((name) => squashed.includes(name))
    ) {
      return { category, surface };
    }
  }
  return null;
}

export const uiEvaluate = defineTool({
  name: 'ui_evaluate',
  domain: 'ui',
  title: 'Evaluate JavaScript in the chart tab',
  description:
    'A power tool, off by default: runs JavaScript in the chart tab of TradingView and returns ' +
    'its value, for what no other tool reads. It is refused with CAPABILITY_UNAVAILABLE unless ' +
    'the server was started with TV_MCP_ALLOW_EVAL=true or --allow-eval, which only the user can ' +
    'do. It runs in the chart tab only, never in the window chrome, which has Node integration. ' +
    "The code runs in the user's live, signed-in page and can change anything the page can, so " +
    'prefer the other tools, and read rather than change. expression is an expression, or ' +
    'statements whose last value is the result, as the console of the browser runs them; a ' +
    'promise is awaited. The page stops synchronous code that runs longer than the call timeout ' +
    'allows (PAGE_EVALUATION_FAILED), but code that runs after an await is not stopped. Before ' +
    'anything is sent, a denylist refuses with UNSAFE_ACTION_BLOCKED an expression that names ' +
    'the desktop bridge (TVD), the user object, user ids or names or session ids, cookies, the ' +
    'storage of the page (localStorage, sessionStorage, indexedDB), credentials (passwords, ' +
    'tokens, signing in, authentication), requests to the network (fetch, XMLHttpRequest, ' +
    'WebSocket, EventSource, sendBeacon, import()) or Node.js (require, process, child_process, ' +
    'electron), in the spacing, bracket, quote, joined-string, concat and escaped forms it ' +
    'knows. The denylist is best effort: it reads the text of the expression, and a name built ' +
    'in other ways while the code runs gets ' +
    'past it, so the user object, the desktop bridge and the storage of the page never come back ' +
    'in a value either, whatever the code reached them by: they are [withheld]. Returns value, ' +
    'the result as JSON (undefined becomes null; a function or a DOM node its type, such as ' +
    '[object Function]; a date its ISO time; a map, a set or an error what they hold; [circular] ' +
    'where an object comes back into itself), at most 100 kB of it, and truncated, true when the ' +
    'value was cut to fit or nested deeper than 32 levels, with a warning. What the code throws ' +
    'is PAGE_EVALUATION_FAILED with its message, never a stack. Neither the expression nor the ' +
    'value is logged.',
  inputSchema: {
    expression: z
      .string()
      .min(1)
      .max(MAX_EXPRESSION)
      .describe(
        'The JavaScript to run in the chart tab, 1 to 10000 characters: an expression, or ' +
          'statements whose last value is the result.',
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // The expression stays out of the tool events, as it stays out of the logs.
  redactArgs: true,
  async handler({ expression }, ctx) {
    if (!ctx.config.allowEval) {
      throw new TvMcpError(
        'CAPABILITY_UNAVAILABLE',
        'ui_evaluate is off: the server allows it only when it was started with TV_MCP_ALLOW_EVAL=true or --allow-eval',
        {
          hint:
            "It runs JavaScript in the user's live, signed-in TradingView, so it is off by " +
            'default and only the user can turn it on. The other tools cover most needs.',
        },
      );
    }
    const denied = deniedSurface(expression);
    if (denied !== null) {
      throw new TvMcpError(
        'UNSAFE_ACTION_BLOCKED',
        `ui_evaluate refuses an expression that reaches ${denied.surface}`,
        {
          hint:
            'The denylist reads the text of the expression and errs on the side of refusing. ' +
            'Leave that out: this server reads no credentials, identity, cookies or storage of ' +
            'the user, and sends no requests of its own.',
          details: { category: denied.category },
        },
      );
    }
    const page = await ctx.connection.chartPage();
    // The page stops the script a margin before the call would give up on it, so that a script
    // that runs without end comes back as a failure of its own and does not leave the page frozen.
    const callTimeoutMs = ctx.config.callTimeoutMs;
    const terminateAfterMs = callTimeoutMs - Math.min(1000, callTimeoutMs / 4);
    const result = await page.bridge
      .evaluate(
        evaluateExpression,
        [expression, EVAL_MAX_RESULT_BYTES, [...EVAL_WITHHELD_GLOBALS]],
        { terminateAfterMs },
      )
      .catch((error: unknown) => {
        // What the page function says has a hint. A failure without one came from the page
        // itself, most likely a script it stopped.
        if (
          isTvMcpError(error) &&
          error.code === 'PAGE_EVALUATION_FAILED' &&
          error.hint === undefined
        ) {
          throw new TvMcpError(error.code, error.message, {
            hint:
              `The page stops synchronous code of the expression after ${String(terminateAfterMs)} ms ` +
              'and answers with this failure. Shorten what runs at once; code that runs after an ' +
              'await is not stopped.',
            ...(error.details === undefined ? {} : { details: error.details }),
          });
        }
        throw error;
      });
    return {
      data: result,
      via: 'cdp',
      warnings: result.truncated
        ? [
            'The value was cut to fit in 100 kB of JSON, or nested deeper than 32 levels: ask ' +
              'for a smaller part of it.',
          ]
        : [],
    };
  },
});
