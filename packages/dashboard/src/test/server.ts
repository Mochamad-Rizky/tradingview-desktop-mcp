import { setupServer } from 'msw/node';

// The API the tests talk to, in process. Tests add the routes they need with server.use(); a request
// that no handler answers fails the test, so nothing reaches the network.
export const server = setupServer();
