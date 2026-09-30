/** Redact the complete diagnostic before bounding it for IPC or display. */
export function redactGitDiagnostic(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/giu, "$1[redacted]@")
    .replace(/([?&][^\s?&#=]+)=([^\s&#]*)/gu, "$1=[redacted]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s]+/giu, "$1[redacted]")
    .replace(
      /(["']?(?:password|passwd|[\w-]*token|[\w-]*secret|api[_-]?key|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/giu,
      "$1[redacted]",
    )
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("")
    .slice(0, 2_000);
}
