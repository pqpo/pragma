#!/usr/bin/env node
import process from "node:process";

const nodeVersion = process.versions.node;
const nodeMajor = Number.parseInt(nodeVersion.split(".", 1)[0] ?? "", 10);

if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(
    `Pragma CLI requires Node.js 22 or later; detected Node.js ${nodeVersion}.\n` +
      "Install a supported Node.js release from https://nodejs.org/ and try again.\n",
  );
  process.exitCode = 2;
} else {
  try {
    const mainBundle = "./cli.js";
    const cli = (await import(mainBundle)) as {
      readonly runCli: (
        argv: readonly string[],
        io: {
          readonly writeStdout: (value: string) => void;
          readonly writeStderr: (value: string) => void;
        },
      ) => Promise<number>;
    };
    process.exitCode = await cli.runCli(process.argv.slice(2), {
      writeStdout: (value) => process.stdout.write(value),
      writeStderr: (value) => process.stderr.write(value),
    });
  } catch {
    process.stderr.write("INTERNAL_ERROR: The command could not complete.\n");
    process.exitCode = 10;
  }
}
