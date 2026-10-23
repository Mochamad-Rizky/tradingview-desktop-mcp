// The access token of the dashboard API: TV_MCP_AUTH_TOKEN, as the user entered it. It lives in
// sessionStorage, so it is gone when the tab closes, and it only ever leaves the page in the
// Authorization header: never in a URL, a cookie or a log.

const KEY = 'tvmcp.token';

// Where the token is kept when the browser refuses to store it (cookies blocked, say), so that the
// dashboard still works for as long as the page is open. It comes first: some browsers read
// storage but refuse to write to it, and storage then holds no token or an older one.
let unstored: string | null = null;

export function readToken(): string | null {
  if (unstored !== null) {
    return unstored;
  }
  try {
    const token = sessionStorage.getItem(KEY);
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

// Trims the token, as a pasted one often brings a space or a line break along.
export function storeToken(t: string): void {
  const token = t.trim();
  if (token === '') {
    clearToken();
    return;
  }
  try {
    sessionStorage.setItem(KEY, token);
    unstored = null;
  } catch {
    unstored = token;
    // An older token left in storage would come back with a reload.
    removeStored();
  }
}

function removeStored(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing was stored.
  }
}

export function clearToken(): void {
  unstored = null;
  removeStored();
}

// The token in a fragment such as `token=…` or `a=1&token=…`, as written: a plus sign stays a plus
// sign, which URLSearchParams would read as a space.
const TOKEN_IN_FRAGMENT = /(?:^#|&)token=([^&]*)/;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// A link such as http://127.0.0.1:8787/#token=… signs the dashboard in. The fragment never reaches
// the server, and it is taken out of the address at once, so that the token stays out of the
// history and out of any link copied from the address bar. Returns the token it stored, or null.
export function takeTokenFromLocation(): string | null {
  const raw = TOKEN_IN_FRAGMENT.exec(window.location.hash)?.[1];
  if (raw === undefined) {
    return null;
  }
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}`);
  const token = decode(raw).trim();
  if (token === '') {
    return null;
  }
  storeToken(token);
  return token;
}
