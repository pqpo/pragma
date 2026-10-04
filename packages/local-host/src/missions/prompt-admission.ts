export type LocalHostMissionPromptAdmissionHook = (
  missionId: string,
  requestId: string,
) => Promise<void | (() => Promise<void>)>;

/** Optional Memory admission must neither reject Core work nor mask its failure. */
export async function beginLocalHostMissionPromptAdmission(
  hook: LocalHostMissionPromptAdmissionHook | undefined,
  missionId: string,
  requestId: string,
  onError?: ((error: unknown) => void) | undefined,
): Promise<(() => Promise<void>) | undefined> {
  const report = (error: unknown): void => {
    try {
      onError?.(error);
    } catch {
      /* Diagnostic failures do not change prompt admission. */
    }
  };
  try {
    const rollback = await hook?.(missionId, requestId);
    if (rollback === undefined) return undefined;
    return async () => {
      try {
        await rollback();
      } catch (error) {
        report(error);
      }
    };
  } catch (error) {
    report(error);
    return undefined;
  }
}
