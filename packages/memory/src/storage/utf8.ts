export function trimUtf8ToByteLimit(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const marker = "\n…";
  const suffix = Buffer.byteLength(marker) <= maxBytes ? marker : "";
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character + suffix) > maxBytes) break;
    result += character;
  }
  return `${result}${suffix}`;
}
