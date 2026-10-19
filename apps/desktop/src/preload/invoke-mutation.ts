import { ipcRenderer } from "electron";

import { DesktopMutationResultSchema } from "@pragma/local-host/deployment-contracts";

export async function invokeMutation(
  channel: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  const result = DesktopMutationResultSchema.parse(await ipcRenderer.invoke(channel, ...args));
  if (!result.ok) throw result.error;
  return result.value;
}
