import pkg from '../package.json' with { type: 'json' };

// The bundler inlines the JSON at build time, so the published bundle never reads package.json
// from disk to report its version.
export const VERSION: string = pkg.version;

// Also the command a user types: the bin entry is named after the package.
export const PACKAGE_NAME: string = pkg.name;
