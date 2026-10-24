// The types of prepare-package.mjs, for the test that imports it.

/**
 * Makes the relative links of a README absolute: images point at the raw file on GitHub and every
 * other link at the file's page there. Absolute URLs, fragments and code are left as they are.
 */
export function rewriteReadmeLinks(markdown: string): string;
