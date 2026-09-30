/** Redact the complete diagnostic before bounding it for IPC or display. */
export function redactGitDiagnostic(message: string): string {
  return redactCredentialFields(
    message
      .replace(/([a-z][a-z0-9+.-]*:(?:\\*\/){2})[^\s/]*@/giu, "$1[redacted]@")
      .replace(/([?&][^\s?&#=]+)=([^\s&#]*)/gu, "$1=[redacted]")
      .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s]+/giu, "$1[redacted]"),
  )
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("")
    .slice(0, 2_000);
}

function redactCredentialFields(message: string): string {
  const fields =
    /(?:\\*["'])?(?:password|passwd|[\w-]*token|[\w-]*secret|api[_-]?key|authorization)(?:\\*["'])?\s*[:=]\s*/giu;
  let result = "";
  let copied = 0;
  for (let match = fields.exec(message); match !== null; match = fields.exec(message)) {
    const start = fields.lastIndex;
    const delimiter = /^(\\*)(["'])/u.exec(message.slice(start));
    let end = message.length;
    if (delimiter !== null) {
      const depth = delimiter[1]!.length;
      const quote = delimiter[2]!;
      let backslashes = 0;
      for (let index = start + delimiter[0].length; index < message.length; index += 1) {
        const character = message[index];
        // At each JSON encoding layer an embedded quote gains more escapes
        // than a closing quote. Preserve that distinction, including values
        // ending in escaped backslashes, instead of globally unescaping text.
        if (character === quote && backslashes % (2 * (depth + 1)) === depth) {
          end = index + 1;
          break;
        }
        backslashes = character === "\\" ? backslashes + 1 : 0;
      }
    } else {
      const value = /^[^\s,;&]*/u.exec(message.slice(start));
      end = start + (value?.[0].length ?? 0);
    }
    result += `${message.slice(copied, start)}[redacted]`;
    copied = end;
    fields.lastIndex = end;
  }
  return result + message.slice(copied);
}
