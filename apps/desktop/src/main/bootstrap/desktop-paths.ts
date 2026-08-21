import { homedir } from "node:os";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";

export function createDesktopPragmaPaths(input: {
  readonly isPackaged: boolean;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDirectory?: string | undefined;
}): PragmaPaths {
  const env = input.env ?? process.env;
  const configuredRoot = env["PRAGMA_HOME"];
  if (configuredRoot !== undefined && configuredRoot.trim() !== "") {
    return new PragmaPaths({ env });
  }

  const homeDirectory = input.homeDirectory ?? homedir();
  return new PragmaPaths({
    pragmaHome: join(homeDirectory, input.isPackaged ? ".pragma" : ".pragma-development"),
  });
}
