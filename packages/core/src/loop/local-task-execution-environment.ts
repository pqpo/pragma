import { exec as execCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  LoopCodeWorkspace,
  LoopWorkspaceExecOptions,
  LoopWorkspaceExecResult,
  ResolveTaskEnvironmentRequest,
  TaskEnvironmentLease,
  TaskExecutionEnvironment,
} from "./types.ts";
import { createId } from "./utils.ts";

const exec = promisify(execCallback);

export interface LocalTaskExecutionEnvironmentOptions {
  readonly workspaceRoot?: string | undefined;
}

export function createLocalTaskExecutionEnvironment(
  options: LocalTaskExecutionEnvironmentOptions = {},
): TaskExecutionEnvironment {
  const defaultWorkspaceRoot = options.workspaceRoot ?? process.cwd();

  return {
    async resolve(request: ResolveTaskEnvironmentRequest): Promise<TaskEnvironmentLease> {
      const workspaceRoot = path.resolve(
        request.request.workspace?.root ?? defaultWorkspaceRoot,
      );
      const workspace = createLocalWorkspace(workspaceRoot);

      return {
        ref: {
          id: request.request.strategy?.environmentId ?? createId("env"),
          kind: request.request.strategy?.mode ?? "local-workspace",
          workspaceRoot,
        },
        workspace,
      };
    },

    async release(): Promise<void> {
      return;
    },
  };
}

function createLocalWorkspace(root: string): LoopCodeWorkspace {
  return {
    root,
    async exec(command: string, options: LoopWorkspaceExecOptions = {}): Promise<LoopWorkspaceExecResult> {
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
