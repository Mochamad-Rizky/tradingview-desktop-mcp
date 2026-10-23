import type { IncomingMessage } from 'node:http';
import type { JsonValue } from '../../utils/json.js';

// The arguments of a tool call are small: the largest, a Pine script, stays far below this.
const MAX_BODY_BYTES = 1_048_576;
// How much of a body the server does not want it reads and drops before it gives up on the
// client: one that sends more is not waiting for an answer.
const DISCARD_LIMIT = 16 * 1_048_576;

// Why a body could not be read, with the HTTP status that says so.
export class BodyError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(status: 400 | 413 | 415, message: string) {
    super(message);
    this.name = 'BodyError';
    this.status = status;
  }
}

// application/json, with or without parameters such as the charset.
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function tooLarge(maxBytes: number): BodyError {
  return new BodyError(413, `The body is larger than ${String(maxBytes)} bytes`);
}

// Reads what is left of a body and drops it, for a request that is answered without it. A client
// that is still sending would otherwise lose the answer: Node closes the connection after the
// answer when the client asked for that, and closing a socket that holds unread data resets it.
// Resolves once the body has ended or the client has gone; past maxBytes the request is destroyed.
export function discardBody(req: IncomingMessage, maxBytes = DISCARD_LIMIT): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) {
      resolve();
      return;
    }
    let size = 0;
    const done = (): void => {
      req.off('data', onData);
      req.off('end', done);
      req.off('error', done);
      req.off('close', done);
      resolve();
    };
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > maxBytes) {
        done();
        req.destroy();
      }
    }
    req.on('data', onData);
    req.on('end', done);
    req.on('error', done);
    req.on('close', done);
  });
}

// The whole body, or a BodyError once it passes maxBytes, given when the client has sent the rest
// (discardBody).
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAbort);
      req.off('close', onAbort);
    };
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > maxBytes) {
        stop();
        void discardBody(req).then(() => {
          reject(tooLarge(maxBytes));
        });
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      stop();
      resolve(Buffer.concat(chunks));
    }
    // The client went away. Nobody reads the answer then, but the call must not be made.
    function onAbort(): void {
      stop();
      reject(new BodyError(400, 'The request ended before its body was complete'));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
  });
}

// The JSON body of a request. A body it refuses is dropped before the error comes, so the answer
// reaches the client (discardBody). The error messages never repeat the body, which can hold
// anything a client sent.
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<JsonValue> {
  if (!isJson(req.headers['content-type'])) {
    await discardBody(req);
    throw new BodyError(415, 'Send the body as JSON, with Content-Type: application/json');
  }
  // A body announced as too large is not kept.
  if (Number(req.headers['content-length']) > maxBytes) {
    await discardBody(req);
    throw tooLarge(maxBytes);
  }
  // Decoded as a whole, so a character whose bytes arrive in two chunks stays whole.
  const text = (await readBody(req, maxBytes)).toString('utf8');
  try {
    // Without a reviver, JSON.parse yields nothing but JSON values.
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new BodyError(400, 'The body is not valid JSON');
  }
}
