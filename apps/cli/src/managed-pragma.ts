#!/usr/bin/env node
import { runManagementCli } from "./management-client.ts";
process.exitCode = await runManagementCli(process.argv.slice(2), {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
});
