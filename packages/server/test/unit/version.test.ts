import pkg from '../../package.json' with { type: 'json' };
import { VERSION } from '../../src/version.js';

test('VERSION matches package.json version', () => {
  expect(VERSION).toBe(pkg.version);
});
