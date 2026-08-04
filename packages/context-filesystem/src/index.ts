/**
 * Host-side filesystem Context adapters. Importing this package explicitly marks
 * the composition root as Node/filesystem-aware; Mission Board and Core Context
 * contracts remain independent from the persistence mechanism.
 */
export {
  FileSystemContextStore,
  JsonContextStore,
  withFileLock,
  type FileSystemContextStoreAuthorizer,
  type FileSystemContextStoreCommandResult,
  type FileSystemContextStoreCommandRunner,
  type FileSystemContextStoreOperation,
  type FileSystemContextStoreOptions,
  type JsonContextStoreMetadata,
  type JsonContextStoreOptions,
} from "@pragma/core";
export * from "./legacy-execution-output-context-store.ts";
