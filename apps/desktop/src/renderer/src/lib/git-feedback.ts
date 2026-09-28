import { errorMessage } from "./errors.ts";

/** Never expose provider stderr, IPC wrappers or validation objects in product UI. */
export function gitFailureKey(error: unknown): string {
  const message = (typeof error === "string" ? error : errorMessage(error)).toLowerCase();
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "asset_git_stale_conflict" || /snapshot changed|stale.conflict/.test(message))
    return "stale";
  if (/user.name|user.email/.test(message)) return "identity";
  if (
    /permission denied|authentication|could not read username|publickey|access denied/.test(message)
  )
    return "authentication";
  if (/could not resolve|timed out|unable to access|connection|network|offline/.test(message))
    return "network";
  if (
    /remote branch|remote ref|couldn't find remote|invalid branch|git branch does not exist/.test(
      message,
    )
  )
    return "branch";
  if (/conflict markers/.test(message)) return "markers";
  if (/file and its child/.test(message)) return "tree";
  if (/skill|schema|validation|too_small|too_big|invalid|utf-8|size limit/.test(message))
    return "validation";
  if (/changed during|revision.*conflict/.test(message)) return "stale";
  if (/conflict|resolve every/.test(message)) return "conflict";
  if (/git address|already.*(?:bound|associated)|association/.test(message)) return "configuration";
  return "unknown";
}
