import { exec as execCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  CreateWorkflowSandboxRequest,
  LoopCodeWorkspace,
  LoopWorkspaceExecOptions,
  LoopWorkspaceExecResult,
  ResolveTaskSandboxRequest,
  SandboxLease,
  SandboxManager,
} from "./types.ts";
import { createId } from "./utils.ts";

const exec = promisify(execCallback);

export interface LocalSandboxManagerOptions {
  readonly workspaceRoot?: string | undefined;
}

export function createLocalSandboxManager(
  options: LocalSandboxManagerOptions = {},
): SandboxManager {
  const defaultWorkspaceRoot = options.workspaceRoot ?? process.cwd();
  const workflowSandboxes = new Map<string, SandboxLease>();
  const stepSandboxes = new Map<string, SandboxLease>();

  const createLease = (id: string, kind: string, workspaceRoot: string): SandboxLease => ({
    ref: {
      id,
      kind,
      workspaceRoot,
    },
    workspace: createLocalWorkspace(workspaceRoot),
  });

  return {
    async createWorkflowSandbox(request: CreateWorkflowSandboxRequest): Promise<SandboxLease> {
      const sandboxRequest = request.request;
      const strategy = sandboxRequest?.strategy ?? {
        mode: "ephemeral" as const,
      };
      const workspaceRoot = path.resolve(sandboxRequest?.workspace?.root ?? defaultWorkspaceRoot);

      if (strategy.mode === "attach") {
        if (strategy.sandboxId === undefined) {
          throw new Error("Workflow sandbox attach strategy requires sandboxId.");
        }

        const lease = createLease(strategy.sandboxId, "local-workspace", workspaceRoot);
        workflowSandboxes.set(request.workflowRunId, lease);
        return lease;
      }

      if (strategy.mode !== "ephemeral") {
        throw new Error(`Unsupported workflow sandbox strategy mode: ${strategy.mode}`);
      }

      const sandboxId = strategy.sandboxId ?? createId("sandbox");
      const lease = createLease(sandboxId, "local-workspace", workspaceRoot);
      workflowSandboxes.set(request.workflowRunId, lease);
      return lease;
    },

    async resolveTaskSandbox(request: ResolveTaskSandboxRequest): Promise<SandboxLease> {
      const strategy = request.request.strategy ?? {
        mode: "reuse-workflow" as const,
      };
      const workspaceRoot = path.resolve(
        request.request.workspace?.root ??
          request.workflow.defaultSandbox.workspaceRoot ??
          defaultWorkspaceRoot,
      );

      if (strategy.mode === "reuse-workflow") {
        const existing = workflowSandboxes.get(request.workflow.id);

        if (existing !== undefined) {
          return existing;
        }

        const lease = createLease(
          request.workflow.defaultSandbox.id,
          request.workflow.defaultSandbox.kind,
          workspaceRoot,
        );
        workflowSandboxes.set(request.workflow.id, lease);
        return lease;
      }

      if (strategy.mode === "reuse-step") {
        const key = `${request.workflow.id}:${request.task.stepId}:${strategy.key ?? "default"}`;
        const existing = stepSandboxes.get(key);

        if (existing !== undefined) {
          return existing;
        }

        const lease = createLease(
          strategy.sandboxId ?? createId("sandbox"),
          "local-workspace",
          workspaceRoot,
        );
        stepSandboxes.set(key, lease);
        return lease;
      }

      if (strategy.mode === "attach") {
        if (strategy.sandboxId === undefined) {
          throw new Error("Sandbox attach strategy requires sandboxId.");
        }

        return createLease(strategy.sandboxId, "local-workspace", workspaceRoot);
      }

      if (strategy.mode === "ephemeral") {
        return createLease(
          strategy.sandboxId ?? createId("sandbox"),
          "local-workspace",
          workspaceRoot,
        );
      }

      throw new Error(`Unsupported sandbox strategy mode: ${strategy.mode}`);
    },

    async releaseTaskSandbox(): Promise<void> {
      return;
    },

    async cleanupWorkflowSandboxes(workflowRunId: string): Promise<void> {
      workflowSandboxes.delete(workflowRunId);

      for (const key of stepSandboxes.keys()) {
        if (key.startsWith(`${workflowRunId}:`)) {
          stepSandboxes.delete(key);
        }
      }
    },
  };
}

function createLocalWorkspace(root: string): LoopCodeWorkspace {
  return {
    root,
    async exec(
      command: string,
      options: LoopWorkspaceExecOptions = {},
    ): Promise<LoopWorkspaceExecResult> {
      try {
        const result = await exec(command, {
          cwd: options.cwd === undefined ? root : path.resolve(root, options.cwd),
          env: options.env,
          timeout: options.timeoutMs,
        });

        return {
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (error) {
        if (isExecError(error)) {
          return {
            exitCode: typeof error.code === "number" ? error.code : 1,
            stdout: String(error.stdout ?? ""),
            stderr: String(error.stderr ?? ""),
          };
        }

        throw error;
      }
    },
  };
}

function isExecError(error: unknown): error is {
  readonly code?: number | string | undefined;
  readonly stdout?: string | Buffer | undefined;
  readonly stderr?: string | Buffer | undefined;
} {
  return typeof error === "object" && error !== null && ("stdout" in error || "stderr" in error);
}
