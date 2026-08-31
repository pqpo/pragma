import {
  buildBundleRegistry,
  checkBundleRegistry,
  initializeBundleRegistry,
  initializeBundleRegistryPackage,
  prepareBundleRegistryPublishCommit,
  publishBundleRegistryVersion,
} from "@pragma/local-host";
import type { JsonValue } from "@pragma/shared";

import type { ParsedCommand } from "../parser/argv.ts";
import { asJsonValue } from "./utils.ts";

export type RegistryCommand = Extract<ParsedCommand, { readonly kind: `registry-${string}` }>;

export async function executeRegistryCommand(command: RegistryCommand): Promise<JsonValue> {
  switch (command.kind) {
    case "registry-init":
      return asJsonValue(await initializeBundleRegistry(command));
    case "registry-package-init":
      return asJsonValue(await initializeBundleRegistryPackage(command));
    case "registry-build":
      return asJsonValue(await buildBundleRegistry(command.directory));
    case "registry-check":
      return asJsonValue(await checkBundleRegistry(command.directory));
    case "registry-publish": {
      const published = await publishBundleRegistryVersion({
        directory: command.directory,
        packageId: command.packageId,
        version: command.version,
        bundlePath: command.bundlePath,
        channel: command.channel,
      });
      const prepared = command.preparePr
        ? await prepareBundleRegistryPublishCommit({
            directory: command.directory,
            packageId: command.packageId,
            version: command.version,
          })
        : undefined;
      return { ...published, ...(prepared === undefined ? {} : { pullRequest: prepared }) };
    }
  }
}
