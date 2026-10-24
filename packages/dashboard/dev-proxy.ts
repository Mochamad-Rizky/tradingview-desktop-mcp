// The Origin that Vite's dev server sends on to the server with a request for the API, for
// `pnpm dev:dashboard`. The server refuses an Origin that is not its own, and the dev page runs on
// Vite's port: a request from that page, or one without an Origin, gets the server's address
// (`target`). Any other Origin, such as that of another site open in the browser, goes on as it
// is, for the server to refuse. `host` is the Host header of the request, which names Vite's
// address as the browser reached it.
export function proxiedOrigin(
  origin: string | undefined,
  host: string | undefined,
  target: string,
): string {
  if (origin === undefined || (host !== undefined && origin === `http://${host}`)) {
    return target;
  }
  return origin;
}
