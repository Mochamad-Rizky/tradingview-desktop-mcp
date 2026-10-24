import type { Reporter } from '@playwright/test/reporter';
import { removeRunDirectory } from './real-app-output.ts';

// A reporter of a run against the user's TradingView that reports nothing. At the very end of the
// run, after the global teardown, Playwright writes .last-run.json into the output directory, which
// creates the run's directory again: this removes it once more, when every reporter has ended.
export default class RemoveRunDirectory implements Reporter {
  printsToStdio(): boolean {
    return false;
  }

  onExit(): Promise<void> {
    removeRunDirectory();
    return Promise.resolve();
  }
}
