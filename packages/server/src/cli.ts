#!/usr/bin/env node
import { runCli } from './cli/run.js';

// The bin entry: everything else lives in runCli, which tests run in process.
process.exitCode = await runCli(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  process,
});

// Output on its way through a pipe would be cut off by process.exit().
await Promise.all(
  [process.stdout, process.stderr].map(
    (stream) =>
      new Promise<void>((resolve) => {
        stream.write('', () => {
          resolve();
        });
      }),
  ),
);
// The WebSocket stack of the CDP client can keep a close timer running for 30 s after a clean
// shutdown, so the process ends here instead of when its event loop drains.
process.exit();
