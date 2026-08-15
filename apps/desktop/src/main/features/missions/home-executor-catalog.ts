import { basename } from "node:path";

import {
  canonicalPragmaResourceRef,
  type PragmaExpertTeamResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import {
  HomeExecutorPreferenceSchema,
  HomeMissionExecutorOptionSchema,
  type HomeExecutorPreference,
  type HomeMissionExecutorOption,
  type UpdateHomeExecutorPreference,
} from "../../../shared/contracts/index.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { ValidateWorkspaceResult } from "../../../shared/contracts/index.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";
import type {
  HomeExecutorPreferenceEntry,
  HomeExecutorPreferenceStore,
} from "./home-executor-preference-store.ts";

export interface HomeExecutorCatalog {
  list(): Promise<readonly HomeMissionExecutorOption[]>;
  update(input: UpdateHomeExecutorPreference): Promise<HomeExecutorPreference>;
  recordUsage(ref: string, workspace: string): Promise<void>;
}

export function createHomeExecutorCatalog(options: {
  readonly project: PragmaProjectStore;
  readonly executors: MissionExecutorCatalog;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly preferences: HomeExecutorPreferenceStore;
  readonly defaultExecutorRef: string;
  readonly validateWorkspace: (
    path: string,
  ) => ValidateWorkspaceResult | Promise<ValidateWorkspaceResult>;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): HomeExecutorCatalog {
  const preferenceView = (
    entry: HomeExecutorPreferenceEntry | undefined,
    alwaysVisible: boolean,
  ): HomeExecutorPreference =>
    HomeExecutorPreferenceSchema.parse({
      favoriteScope: alwaysVisible ? "global" : (entry?.favoriteScope ?? "none"),
      hidden: alwaysVisible ? false : (entry?.hidden ?? false),
      ...(entry?.favoriteWorkspace === undefined
        ? {}
        : {
            favoriteWorkspace: {
              path: entry.favoriteWorkspace,
              basename: basename(entry.favoriteWorkspace),
          },
        }),
      ...(entry?.favoriteRank === undefined ? {} : { favoriteRank: entry.favoriteRank }),
      ...(entry?.lastWorkspace === undefined
        ? {}
        : {
            lastWorkspace: {
              path: entry.lastWorkspace,
              basename: basename(entry.lastWorkspace),
            },
          }),
      ...(entry?.lastUsedAt === undefined ? {} : { lastUsedAt: entry.lastUsedAt }),
    });

  return {
    async list() {
      const [project, executors, preferenceEntries] = await Promise.all([
        options.project.get(),
        options.executors.list(),
        options.preferences.list(),
      ]);
      const resourcesByRef = new Map(
        project.resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
      );
      const preferencesByRef = new Map(
        preferenceEntries.map((preference) => [preference.ref, preference]),
      );
      const memberships = deriveTeamMemberships(project.resources);

      return executors.map((executor) => {
        const alwaysVisible = executor.ref === options.defaultExecutorRef;
        const resource =
          resourcesByRef.get(executor.ref) ?? options.systemExperts.getResource(executor.ref);
        return HomeMissionExecutorOptionSchema.parse({
          ...executor,
          tags: resource?.metadata.tags ?? [],
          teamMemberships: memberships.get(executor.ref) ?? [],
          preference: preferenceView(preferencesByRef.get(executor.ref), alwaysVisible),
          alwaysVisible,
        });
      });
    },
    async update(input) {
      const available = await options.executors.list();
      if (!available.some((executor) => executor.ref === input.ref)) {
        throw new Error(`Mission executor not found: ${input.ref}.`);
      }
      await options.preferences.prune(new Set(available.map((executor) => executor.ref)));
      const isDefaultExecutor = input.ref === options.defaultExecutorRef;
      if (!isDefaultExecutor && input.favoriteWorkspace !== undefined) {
        const validation = await options.validateWorkspace(input.favoriteWorkspace);
        if (!validation.ok) {
          throw new Error("The selected workspace must be an accessible, writable directory.");
        }
      }
      if (isDefaultExecutor && input.hidden === true) {
        throw new Error("The built-in Pragma executor must remain visible.");
      }
      const updated = await options.preferences.update(
        isDefaultExecutor
          ? {
              ref: input.ref,
              favoriteScope: "global",
              hidden: false,
              ...(input.favoriteRank === undefined
                ? {}
                : { favoriteRank: input.favoriteRank }),
              ...(input.clearLastWorkspace === true ? { clearLastWorkspace: true } : {}),
            }
          : input,
      );
      return preferenceView(updated, isDefaultExecutor);
    },
    async recordUsage(ref, workspace) {
      try {
        await options.preferences.recordUsage({ ref, workspace });
      } catch (error) {
        options.warn?.("Home executor usage could not be recorded.", error);
      }
    },
  };
}

function deriveTeamMemberships(
  resources: readonly PragmaResource[],
): ReadonlyMap<string, readonly { readonly ref: string; readonly name: string }[]> {
  const memberships = new Map<string, { ref: string; name: string }[]>();
  const teams = resources.filter(
    (resource): resource is PragmaExpertTeamResource => resource.kind === "ExpertTeam",
  );
  for (const team of teams) {
    const teamRef = canonicalPragmaResourceRef(team);
    const expertRefs = new Set([
      team.spec.coordinator.ref,
      ...team.spec.members.map((member) => member.ref),
    ]);
    for (const expertRef of expertRefs) {
      const current = memberships.get(expertRef) ?? [];
      current.push({ ref: teamRef, name: team.metadata.name });
      memberships.set(expertRef, current);
    }
  }
  return memberships;
}
