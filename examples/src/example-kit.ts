import { createPragma, createRuntimeRegistry, defineExpert, type Expert } from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

export async function createExampleExpert(id: string, instructions: string): Promise<Expert> {
  return await defineExpert({
    id,
    name: id,
    description: `${id} example Expert`,
    instructions,
    tags: ["example"],
    version: "1.0.0",
    scope: "example",
    workspace: process.cwd(),
  });
}

export function createExampleApp(pragmaHome?: string) {
  const runtime = createPiRuntime();
  return createPragma({
    ...(pragmaHome === undefined ? {} : { pragmaHome }),
    runtimes: createRuntimeRegistry({
      runtimes: [runtime],
      defaultRuntime: runtime.descriptor.id,
    }),
  });
}
