import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Whether the module at moduleUrl (its import.meta.url) is the script that node was started with
// (entry, process.argv[1] by default), such as `pnpm docs:tools`, and not a module that a test
// imports. Both paths are resolved, so a link in the path does not keep the script from running.
export function isEntryPoint(
  moduleUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
