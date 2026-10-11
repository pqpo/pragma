#!/usr/bin/env node
import { runManagementCli } from "./management-client.ts";
delete process.env["ELECTRON_RUN_AS_NODE"];
process.exitCode = await runManagementCli(process.argv.slice(2), {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
});
