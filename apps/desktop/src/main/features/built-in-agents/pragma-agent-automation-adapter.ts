import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  PragmaAgentAutomationSummarySchema,
  type PragmaAgentAutomationPort,
  type PragmaAgentAutomationSummary,
} from "@pragma/built-in-agents";
import { parsePragmaYaml } from "@pragma/interpreter";
import { PragmaAutomationResourceSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

import type { AutomationSummary } from "../../../shared/contracts/index.ts";
import type { AutomationService } from "../automations/automation-service.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { paginateManagementItems } from "./management-pagination.ts";

const DeleteResultSchema = z.object({
  deleted: z.literal(true),
  ref: z.string().min(1),
});

export function createDesktopPragmaAgentAutomationPort(options: {
  readonly service: AutomationService;
  readonly project: PragmaProjectStore;
  readonly stateRoot: string;
}): PragmaAgentAutomationPort {
  const operationPath = (operationId: string) =>
    join(
      options.stateRoot,
      "automation-operations",
      `${encodePragmaPathSegment(operationId)}.json`,
    );

  return {
    async list(input) {
      const [project, automations] = await Promise.all([
        options.project.get(),
        options.service.list(),
      ]);
      const query = input.query?.trim().toLocaleLowerCase();
      const statuses = input.statuses === undefined ? undefined : new Set(input.statuses);
      const items = automations
        .map(toPragmaAgentSummary)
        .filter(
          (automation) =>
            (statuses === undefined || statuses.has(automation.status)) &&
            (input.enabled === undefined || automation.enabled === input.enabled) &&
            (input.executorRef === undefined || automation.executorRef === input.executorRef) &&
            (query === undefined ||
              [automation.ref, automation.name, automation.executorRef].some((value) =>
                value.toLocaleLowerCase().includes(query),
              )),
        )
        .toSorted(
          (left, right) => left.name.localeCompare(right.name) || left.ref.localeCompare(right.ref),
        );
      return {
        projectRevision: project.revision,
        ...paginateManagementItems({
          items,
          scope: "list_automations",
          fingerprintValue: [project.revision, items],
          filters: {
            statuses: input.statuses,
            enabled: input.enabled,
            executorRef: input.executorRef,
            query,
          },
          cursor: input.cursor,
          limit: input.limit,
        }),
      };
    },
    async save(input) {
      return await idempotentOperation(
        operationPath(input.operationId),
        PragmaAgentAutomationSummarySchema,
        async () => {
          const resource = PragmaAutomationResourceSchema.parse(parsePragmaYaml(input.source));
          return toPragmaAgentSummary(
            await options.service.save({
              expectedProjectRevision: input.expectedProjectRevision,
              resource,
              binding: {
                workspace: input.workspaceId,
                toolPermissionMode: input.toolPermissionMode,
                contextMounts: [],
              },
            }),
          );
        },
      );
    },
    async delete(input) {
      return await idempotentOperation(
        operationPath(input.operationId),
        DeleteResultSchema,
        async () => {
          await options.service.delete({
            expectedProjectRevision: input.expectedProjectRevision,
            ref: input.ref,
          });
          return { deleted: true as const, ref: input.ref };
        },
      );
    },
    async resetSession(input) {
      return await idempotentOperation(
        operationPath(input.operationId),
        PragmaAgentAutomationSummarySchema,
        async () => toPragmaAgentSummary(await options.service.resetSession(input.ref)),
      );
    },
  };
}

function toPragmaAgentSummary(summary: AutomationSummary): PragmaAgentAutomationSummary {
  return PragmaAgentAutomationSummarySchema.parse({
    ref: summary.ref,
    name: summary.resource.metadata.name,
    enabled: summary.resource.spec.enabled,
    status: summary.status,
    executorRef: summary.resource.spec.route.executor.ref,
    interaction: summary.resource.spec.interaction.mode,
    ...(summary.binding === undefined ? {} : { workspaceId: summary.binding.workspace.path }),
    ...(summary.nextRunAt === undefined ? {} : { nextRunAt: summary.nextRunAt }),
    ...(summary.missionId === undefined ? {} : { missionId: summary.missionId }),
    queueDepth: summary.queueDepth,
    ...(summary.diagnostic === undefined ? {} : { diagnostic: summary.diagnostic }),
  });
}

async function idempotentOperation<T>(
  path: string,
  schema: z.ZodType<T>,
  execute: () => Promise<T>,
): Promise<T> {
  return await withFileLock(`${path}.lock`, async () => {
    const existing = await readOptional(path, schema);
    if (existing !== undefined) return existing;
    const result = schema.parse(await execute());
    await writeJsonAtomic(path, result);
    return result;
  });
}

async function readOptional<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
