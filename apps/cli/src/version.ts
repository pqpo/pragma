declare const __PRAGMA_CLI_VERSION__: string;

/**
 * The release bundle replaces this token from the staging manifest. Keeping a
 * development fallback makes source-level tests usable in an unreleased checkout.
 */
export const CLI_VERSION =
  typeof __PRAGMA_CLI_VERSION__ === "undefined" ? "0.0.0" : __PRAGMA_CLI_VERSION__;
