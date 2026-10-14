// Electron consumed this switch; native Runtime children must not inherit it.
delete process.env["ELECTRON_RUN_AS_NODE"];
process.once("message", (value) => {
  const modulePath = import.meta.url.endsWith(".ts") ? "./index.ts" : "./cli.js";
  void import(modulePath)
    .then(async (cli: { runMissionOwnerProcessMessage(value: unknown): Promise<void> }) => {
      await cli.runMissionOwnerProcessMessage(value);
    })
    .finally(() => {
      if (process.connected) process.disconnect?.();
    });
});
