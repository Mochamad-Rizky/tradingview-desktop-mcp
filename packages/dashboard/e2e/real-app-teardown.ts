import { removeRunDirectory } from './real-app-output.ts';

// The global teardown of a run against the user's TradingView: removes what Playwright wrote, the
// results of failed tests included (real-app-output.ts).
export default function teardown(): void {
  removeRunDirectory();
}
