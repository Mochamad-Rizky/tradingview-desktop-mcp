import { clearToken, readToken } from './token';

// The dashboard's calls to the server's API under /api, on the origin the page came from. Every
// call sends the token as `Authorization: Bearer`, the only place the server takes it from.

// An answer that is not a success: the HTTP status, and the server's own message.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// A success whose body is not the JSON of the contract, such as the page of a proxy that answered
// in the server's place: something answered, but not the server.
export class UnexpectedAnswerError extends Error {
  constructor() {
    super('The server sent an unexpected answer');
    this.name = 'UnexpectedAnswerError';
  }
}

const unauthorizedListeners = new Set<() => void>();

// `fn` hears of every 401 to the stored token, after the token was cleared: the token gate then
// asks for it again. Returns the unsubscribe function.
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

// A 401 to `token`. When `token` is the stored one, it is wrong now (the server restarted with
// another, say), so it is cleared and the listeners told. A request still on its way when the
// user entered another token, or one made with a token the caller passed, says nothing about the
// stored token.
function unauthorized(token: string | null): void {
  if (token === null || token !== readToken()) {
    return;
  }
  clearToken();
  for (const listener of [...unauthorizedListeners]) {
    listener();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The server's message from the JSON body of an error answer ({ error }), or the status.
async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    // Not JSON: a proxy's page, say.
  }
  return `The server answered ${String(response.status)}`;
}

// The ApiError of an answer that is not a success, sent with `token`; a 401 goes to the token
// gate first.
export async function errorFrom(response: Response, token: string | null): Promise<ApiError> {
  const error = new ApiError(response.status, await errorMessage(response));
  if (response.status === 401) {
    unauthorized(token);
  }
  return error;
}

// The headers of a request with `token`, or with none when there is no token.
export function authorization(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

export interface RequestOptions {
  signal?: AbortSignal;
  // A token to send instead of the stored one: the token gate checks one before it stores it.
  token?: string;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: RequestOptions,
): Promise<T> {
  const token = options.token ?? readToken();
  const headers: Record<string, string> = { Accept: 'application/json', ...authorization(token) };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  const response = await fetch(path, init);
  if (!response.ok) {
    throw await errorFrom(response, token);
  }
  // The server answers with the JSON of the contract for each route. A connection that breaks
  // while the body comes, or a request that is aborted, fails as it is.
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UnexpectedAnswerError();
    }
    throw error;
  }
}

export function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>('GET', path, undefined, options);
}

export function apiPost<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>('POST', path, body, options);
}
