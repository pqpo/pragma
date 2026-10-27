import { getDistribution, getTerminalRegistrationIdentity } from "@pragma/shared/distribution";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "@pragma/core";

export const BEGIN = "# >>> Pragma Desktop CLI >>>";
export const END = "# <<< Pragma Desktop CLI <<<";
export const LAUNCHER_MARKER = "# Pragma Desktop CLI launcher";
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function shellPathBlock(directory: string, shell: "zsh" | "bash" | "fish"): string {
  const { begin: BEGIN, end: END } = getTerminalRegistrationIdentity();
  const path = shellQuote(directory);
  const body =
    shell === "fish"
      ? `set -l __pragma_paths
for __pragma_path in $PATH
  if test "$__pragma_path" != ${path}
    set -a __pragma_paths "$__pragma_path"
  end
end
set -gx PATH ${path} $__pragma_paths
set -e __pragma_paths
set -e __pragma_path`
      : shell === "zsh"
        ? `typeset -U path\npath=(${path} \${path:#${path}})\nexport PATH`
        : `__pragma_rest="$PATH"
__pragma_result=''
while :; do
  case "$__pragma_rest" in
    *:*) __pragma_part="\${__pragma_rest%%:*}"; __pragma_rest="\${__pragma_rest#*:}"; __pragma_more=yes ;;
    *) __pragma_part="$__pragma_rest"; __pragma_more=no ;;
  esac
  if [ "$__pragma_part" != ${path} ]; then
    __pragma_result="$__pragma_result:$__pragma_part"
  fi
  [ "$__pragma_more" = yes ] || break
done
export PATH=${path}"$__pragma_result"
unset __pragma_rest __pragma_result __pragma_part __pragma_more`;
  return `${BEGIN}\n${body}\n${END}\n`;
}

export function replaceShellBlock(source: string, block: string | undefined): string {
  const { begin: BEGIN, end: END } = getTerminalRegistrationIdentity();
  const startCount = source.split(BEGIN).length - 1;
  const endCount = source.split(END).length - 1;
  if (startCount !== endCount)
    throw new Error(
      "CLI_SHELL_CONFIG_INVALID: Repair the incomplete Pragma block in your shell configuration.",
    );
  let next = source;
  while (next.includes(BEGIN)) {
    const start = next.indexOf(BEGIN);
    const end = next.indexOf(END, start);
    const nested = next.indexOf(BEGIN, start + BEGIN.length);
    if (end < start || next.indexOf(END) < start || (nested >= 0 && nested < end))
      throw new Error("CLI_SHELL_CONFIG_INVALID: Pragma shell block markers are out of order.");
    next = next.slice(0, start) + next.slice(end + END.length).replace(/^\r?\n/u, "");
  }
  if (block === undefined) return next;
  return next + (next.length > 0 && !next.endsWith("\n") ? "\n" : "") + block;
}

export async function atomicWrite(path: string, content: string, mode = 0o700): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    // Creation applies umask; restore the requested mode before replacing the user's file.
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Follow existing config symlinks, keep permissions, and back up before changing user content. */
export async function updateShellConfig(path: string, block: string | undefined): Promise<void> {
  const target = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return path;
  });
  await mkdir(dirname(target), { recursive: true });
  await withFileLock(`${target}.pragma-lock`, async () => {
    let source = "";
    let mode = 0o600;
    let existed = false;
    try {
      source = await readFile(target, "utf8");
      mode = (await stat(target)).mode & 0o777;
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = replaceShellBlock(source, block);
    if (source === next) return;
    if (existed) {
      // One recoverable backup per file; never overwrite the user's original backup.
      try {
        await writeFile(`${target}.${getDistribution().id}-backup`, source, { flag: "wx", mode });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await atomicWrite(target, next, mode);
  });
}
