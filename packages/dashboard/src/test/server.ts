import { setupServer } from 'msw/node';
import { handlers } from './handlers';

// The API the tests talk to, in process, answering every route with the fixtures. A test that needs
// other answers adds them with server.use(), which the setup undoes after the test; a request that no
// handler answers fails the test, so nothing reaches the network.
export const server = setupServer(...handlers);
