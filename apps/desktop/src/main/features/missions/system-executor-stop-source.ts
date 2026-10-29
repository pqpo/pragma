import { unattendedMemoryRevisionResource } from "@pragma/built-in-agents";
import type { Mission } from "@pragma/shared";
import {
  isMemoryDirectRevision,
  isUnattendedMemoryRevision,
} from "../memory/memory-revision-executor.ts";
import {
  isMemoryRevisionPlanningRun,
  memoryRevisionPlanningResource,
} from "../memory/memory-revision-planning-resource.ts";
import type {
  LocalHostSystemExecutorSnapshot,
  LocalHostSystemExecutorSource,
} from "@pragma/local-host";

/** Rebuild control definitions from the admitted execution, without reopening live tools. */
export function systemExecutorStopSource(
  source: LocalHostSystemExecutorSource,
  pinned: LocalHostSystemExecutorSnapshot | undefined,
  mission?: Mission,
): LocalHostSystemExecutorSource {
  if (pinned === undefined) {
    const resource = source.expertResource;
    if (mission === undefined || resource?.kind !== "Expert") return source;
    // Historical executions may predate source snapshots. Rebuild their unattended
    // brief without reopening retired jobs, tools, credentials or draft owners.
    return {
      ...source,
      expertResource: isMemoryRevisionPlanningRun(mission.origin, mission.executor.ref)
        ? memoryRevisionPlanningResource(resource)
        : isUnattendedMemoryRevision(mission)
          ? unattendedMemoryRevisionResource(resource, {
              learningTools: isMemoryDirectRevision(mission),
            })
          : resource,
    };
  }
  if (pinned.expertResource !== undefined && pinned.expertResource.kind !== "Expert")
    throw new Error(`Invalid pinned Expert: ${source.ref}`);
  return {
    ...source,
    ...pinned,
    expertResource: pinned.expertResource,
  };
}
