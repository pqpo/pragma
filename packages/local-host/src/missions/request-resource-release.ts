/** Reserve admission while releasing only the resources captured by this request. */
export function createMissionRequestResourceRelease(options: {
  readonly enabled: boolean;
  readonly admit: (operation: () => Promise<void>) => Promise<void>;
  readonly isCurrent: () => boolean | Promise<boolean>;
  readonly waitForDurableTerminal?: (() => Promise<void>) | undefined;
  readonly releaseSession: () => Promise<void>;
  readonly detach: () => void;
  readonly releaseOwner: () => Promise<void>;
}): () => Promise<void> {
  let release: Promise<void> | undefined;
  return async () => {
    if (!options.enabled) return;
    release ??= options.admit(async () => {
      if (!(await options.isCurrent())) return;
      await options.waitForDurableTerminal?.();
      await options.releaseSession();
      // The admission reservation excludes successors during the await.
      options.detach();
      await options.releaseOwner();
    });
    await release;
  };
}
