/**
 * Host-side filesystem Context adapters. Importing this package explicitly marks
 * the composition root as Node/filesystem-aware; Mission Board and Core Context
 * contracts remain independent from the persistence mechanism.
 */
export {
  FileSystemContextStore,
  type FileSystemContextStoreAuthorizer,
  type FileSystemContextStoreCommandResult,
  type FileSystemContextStoreCommandRunner,
  type FileSystemContextStoreOperation,
  type FileSystemContextStoreOptions,
} from "./file-system-context-store.ts";
export {
  JsonContextStore,
  type JsonContextStoreMetadata,
  type JsonContextStoreOptions,
} from "./json-context-store.ts";
export * from "./legacy-execution-output-context-store.ts";
