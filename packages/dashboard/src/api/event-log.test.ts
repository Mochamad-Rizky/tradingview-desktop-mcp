import { TEST_TOKEN } from '@/test/fixtures';
import { createEventStream } from '@/test/handlers';
import { server } from '@/test/server';
import { EventLog } from './event-log';
import { storeToken } from './token';

test('starting the log twice opens one stream, and stopping it closes that stream', async () => {
  storeToken(TEST_TOKEN);
  const stream = createEventStream();
  server.use(stream.handler);
  const log = new EventLog();
  log.start();
  log.start();
  const connection = await stream.next();
  await vi.waitFor(() => {
    expect(log.getSnapshot().status).toBe('live');
  });
  expect(stream.connections).toHaveLength(1);
  log.stop();
  await vi.waitFor(() => {
    expect(connection.closed).toBe(true);
  });
});
