import { ipcRenderer } from "electron";

import { DesktopMutationError, DesktopMutationResultSchema } from "../shared/contracts/mutation.ts";

export async function invokeMutation(
  channel: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  const result = DesktopMutationResultSchema.parse(await ipcRenderer.invoke(channel, ...args));
  if (!result.ok) throw new DesktopMutationError(result.error);
  return result.value;
}
