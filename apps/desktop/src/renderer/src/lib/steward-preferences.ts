const STEWARD_TASK_WORKSPACE_KEY = "pragma.steward.task-workspace";

export function readStewardTaskWorkspace(storage: Storage | undefined): string {
  return storage?.getItem(STEWARD_TASK_WORKSPACE_KEY) ?? "";
}

export function writeStewardTaskWorkspace(storage: Storage | undefined, workspace: string): void {
  if (storage === undefined) return;
  if (workspace === "") {
    storage.removeItem(STEWARD_TASK_WORKSPACE_KEY);
    return;
  }
  storage.setItem(STEWARD_TASK_WORKSPACE_KEY, workspace);
}
