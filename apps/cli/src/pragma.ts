#!/usr/bin/env node
import process from "node:process";

import { runCli } from "./index.ts";
import { readProcessStdin } from "./input.ts";

try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    {
      writeStdout: (value) => process.stdout.write(value),
      writeStderr: (value) => process.stderr.write(value),
    },
    { readStdin: readProcessStdin },
  );
} catch {
  process.stderr.write("INTERNAL_ERROR: The command could not complete.\n");
  process.exitCode = 10;
}
