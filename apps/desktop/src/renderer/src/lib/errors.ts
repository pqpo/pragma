export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The change could not be saved.";
}
