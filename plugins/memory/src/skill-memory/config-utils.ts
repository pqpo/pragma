export function describeConfigInput(input: unknown): string {
  if (input === null) {
    return "null";
  }

  if (Array.isArray(input)) {
    return "array";
  }

  return typeof input;
}
