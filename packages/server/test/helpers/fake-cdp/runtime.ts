import { clearTimeout, setInterval, setTimeout } from 'node:timers';
import vm from 'node:vm';
import { CDP_ERROR, FakeCdpError } from './protocol.js';

// What Runtime.evaluate does to the code it is given, minus the browser: run it as a script in
// a vm context whose global object is the fake window, so `window`, `self` and bare names such
// as TradingViewApi all resolve like they do on the real page.

type RemoteObject = Record<string, unknown>;

// Stack frames of the evaluated code read "<anonymous>:line:column" in Chrome. The same name is
// used as the script name, so the frames can be told apart from the frames of the host.
const SCRIPT_NAME = '<anonymous>';
const SCRIPT_FRAME = /^\s+at (?:.* \()?<anonymous>:(\d+):(\d+)\)?$/;

// Bounds a synchronous infinite loop in evaluated code, which would otherwise freeze the whole
// test process. Time spent waiting on promises or timers does not count.
const SYNC_TIMEOUT_MS = 5_000;

export interface PageRuntime {
  // Answers Runtime.evaluate with the `result` payload of the response. Throws FakeCdpError for
  // a protocol-level failure; a throw inside the evaluated code is part of the payload instead.
  evaluate(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  // Cancels the timers the page scheduled, so none outlives the server.
  dispose(): void;
}

type Callable = (...args: unknown[]) => unknown;

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function';
}

// Cross-realm safe: a promise made inside the vm context is not an instance of the host Promise.
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

// Errors of another realm fail `instanceof Error`, but not the tag check.
function isErrorObject(value: unknown): value is Error {
  return Object.prototype.toString.call(value) === '[object Error]';
}

// Numbers JSON cannot carry travel as text, next to a description.
function unserializableNumber(text: string): RemoteObject {
  return { type: 'number', unserializableValue: text, description: text };
}

function numberObject(value: number): RemoteObject {
  if (Number.isNaN(value)) {
    return unserializableNumber('NaN');
  }
  if (Object.is(value, -0)) {
    return unserializableNumber('-0');
  }
  if (value === Infinity) {
    return unserializableNumber('Infinity');
  }
  if (value === -Infinity) {
    return unserializableNumber('-Infinity');
  }
  return { type: 'number', value };
}

// returnByValue for objects: the value as JSON. Chrome refuses what it cannot serialize with a
// server error instead of a result, and so does this.
function objectByValue(value: unknown): RemoteObject {
  // JSON.stringify returns undefined for functions and symbols, although its type says string.
  let json: unknown;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    const circular =
      error instanceof TypeError && error.message.startsWith('Converting circular structure');
    throw new FakeCdpError(
      CDP_ERROR.serverError,
      circular ? 'Object reference chain is too long' : "Object couldn't be returned by value",
    );
  }
  if (typeof json !== 'string') {
    throw new FakeCdpError(CDP_ERROR.serverError, "Object couldn't be returned by value");
  }
  return { type: 'object', value: JSON.parse(json) as unknown };
}

function toRemoteObject(value: unknown): RemoteObject {
  if (value === null) {
    return { type: 'object', subtype: 'null', value: null };
  }
  switch (typeof value) {
    case 'undefined':
      return { type: 'undefined' };
    case 'boolean':
      return { type: 'boolean', value };
    case 'string':
      return { type: 'string', value };
    case 'number':
      return numberObject(value);
    case 'bigint':
      return {
        type: 'bigint',
        unserializableValue: `${String(value)}n`,
        description: `${String(value)}n`,
      };
    default:
      return objectByValue(value);
  }
}

function classNameOf(error: Error): string {
  const name = (error.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name !== '' ? name : 'Error';
}

// Chrome's description of an error is its stack. The frames of the host (the fake window, node:vm
// and the test runner) are dropped, because nothing like them exists on a page, which leaves
// the header and the frames of the evaluated code.
function describeError(error: Error): { description: string; line: number; column: number } {
  const stack = typeof error.stack === 'string' ? error.stack : '';
  const frames = stack.split('\n').filter((line) => SCRIPT_FRAME.test(line));
  const first = SCRIPT_FRAME.exec(frames[0] ?? '');
  return {
    description: [String(error), ...frames].join('\n'),
    // Chrome counts lines and columns from 0, a stack trace from 1.
    line: first?.[1] === undefined ? 0 : Number(first[1]) - 1,
    column: first?.[2] === undefined ? 0 : Number(first[2]) - 1,
  };
}

function exceptionPayload(
  thrown: unknown,
  text: string,
  exceptionId: number,
): Record<string, unknown> {
  if (isErrorObject(thrown)) {
    const { description, line, column } = describeError(thrown);
    const remote: RemoteObject = {
      type: 'object',
      subtype: 'error',
      className: classNameOf(thrown),
      description,
    };
    return {
      result: remote,
      exceptionDetails: {
        exceptionId,
        text,
        lineNumber: line,
        columnNumber: column,
        exception: remote,
      },
    };
  }
  let remote: RemoteObject;
  try {
    remote = toRemoteObject(thrown);
  } catch {
    // Something like `throw function () {}`: Chrome would hand out an object reference, which a
    // fake without object IDs cannot, so only the fact that something was thrown is reported.
    remote = { type: 'object', className: 'Object', description: 'Object' };
  }
  return {
    result: remote,
    exceptionDetails: { exceptionId, text, lineNumber: 0, columnNumber: 0, exception: remote },
  };
}

export function createPageRuntime(window: object): PageRuntime {
  const context = vm.createContext(window);
  const timers = new Map<number, NodeJS.Timeout>();
  let lastTimerId = 0;
  let lastExceptionId = 0;

  const define = (name: string, value: unknown): void => {
    // A window that brings its own definition wins.
    if (!(name in window)) {
      Object.defineProperty(window, name, {
        value,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }
  };

  // In a browser `window` is the global object, so `window.Array` or `window === globalThis`
  // hold. The vm global is not the sandbox object, so the name has to point at the global.
  const pageGlobal: unknown = vm.runInContext('globalThis', context);
  define('window', pageGlobal);
  define('self', pageGlobal);

  // The page schedules timers (for example to wait for dataReady), and a vm context has none.
  // They are numbers like in a browser, they never keep the process alive, and a throw inside
  // one is swallowed like the uncaught error of a page: it is reported to a console, never to
  // the caller of Runtime.evaluate.
  const schedule =
    (repeat: boolean) =>
    (callback: unknown, delay?: unknown, ...args: unknown[]): number => {
      if (!isCallable(callback)) {
        throw new TypeError('The callback provided as parameter 1 is not a function');
      }
      const milliseconds =
        typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : 0;
      const id = ++lastTimerId;
      const run = (): void => {
        if (!repeat) {
          timers.delete(id);
        }
        try {
          callback(...args);
        } catch {
          // See above: a page timer cannot fail its caller.
        }
      };
      const timer = repeat ? setInterval(run, milliseconds) : setTimeout(run, milliseconds);
      timer.unref();
      timers.set(id, timer);
      return id;
    };
  const cancel = (id: unknown): void => {
    if (typeof id !== 'number') {
      return;
    }
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  };
  define('setTimeout', schedule(false));
  define('setInterval', schedule(true));
  define('clearTimeout', cancel);
  define('clearInterval', cancel);

  return {
    async evaluate(params) {
      const { expression, awaitPromise } = params;
      if (typeof expression !== 'string') {
        throw new FakeCdpError(
          CDP_ERROR.invalidParams,
          'Invalid parameters',
          'expression: string value expected',
        );
      }

      let value: unknown;
      try {
        const script = new vm.Script(expression, { filename: SCRIPT_NAME });
        value = script.runInContext(context, { timeout: SYNC_TIMEOUT_MS, displayErrors: false });
      } catch (thrown) {
        return exceptionPayload(thrown, 'Uncaught', ++lastExceptionId);
      }

      if (isThenable(value)) {
        if (awaitPromise !== true) {
          // Chrome only logs the rejection of a promise nobody awaits, but Node would treat it
          // as unhandled and fail the test run.
          Promise.resolve(value).catch(() => undefined);
          return { result: objectByValue(value) };
        }
        try {
          value = await value;
        } catch (thrown) {
          return exceptionPayload(thrown, 'Uncaught (in promise)', ++lastExceptionId);
        }
      }
      return { result: toRemoteObject(value) };
    },

    dispose() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
