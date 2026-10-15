import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { invokeMissionOwner } from "../../src/mission-owner-process.ts";

const mode = process.env["PRAGMA_TEST_OWNER_MODE"];
const argv =
  mode === "mutation"
    ? [
        "mission",
        "send",
        "11111111-1111-4111-8111-111111111111",
        "--prompt",
        "Complete after SIGINT",
        "--wait-timeout",
        "60",
      ]
    : [
        "expert",
        "run",
        "expert:aaaaaaaaaaaaaaaa",
        "--workspace",
        process.env["PRAGMA_TEST_OWNER_HOME"]!,
        "--prompt",
        "Complete after the caller exits",
        "--wait-timeout",
        "1",
        "--interactive",
        "never",
      ];
try {
  const result = await invokeMissionOwner({
    argv,
    requestId: "11111111-1111-4111-8111-111111111119",
    waitTimeoutSeconds: mode === undefined ? 1 : 60,
    ...(mode === undefined
      ? {}
      : { onStarted: (receipt: unknown) => process.stdout.write(JSON.stringify(receipt) + "\n") }),
    ...(mode !== "executor"
      ? {}
      : {
          onInterrupt: (cancel: () => void) => {
            process.on("SIGINT", cancel);
            return () => process.removeListener("SIGINT", cancel);
          },
        }),
    detach: false,
    workerPath: fileURLToPath(new URL("./mission-owner.ts", import.meta.url)),
    execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify(error) + "\n");
  process.exitCode = 1;
}
