import { setupServer } from 'msw/node';

// The API the tests talk to, in process. The setup gives each test a fresh fake API with every route
// answered by the fixtures (createFakeApi); a test that needs other answers adds them with
// server.use(), which the setup undoes after the test. A request that no handler answers fails the
// test, so nothing reaches the network.
export const server = setupServer();
