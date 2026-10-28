import type {
  LocalHostSystemExecutorSnapshot,
  LocalHostSystemExecutorSource,
} from "@pragma/local-host";

/** Rebuild control definitions from the admitted execution, without reopening live tools. */
export function systemExecutorStopSource(
  source: LocalHostSystemExecutorSource,
  pinned: LocalHostSystemExecutorSnapshot | undefined,
): LocalHostSystemExecutorSource {
  if (pinned === undefined) return source;
  if (pinned.expertResource !== undefined && pinned.expertResource.kind !== "Expert")
    throw new Error(`Invalid pinned Expert: ${source.ref}`);
  return {
    ...source,
    ...pinned,
    expertResource: pinned.expertResource,
  };
}
