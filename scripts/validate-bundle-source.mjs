#!/usr/bin/env node

import { resolve } from "node:path";

import { validateBundleSourceDirectory } from "../packages/local-host/dist/index.js";

const directory = resolve(process.argv[2] ?? ".");
const result = await validateBundleSourceDirectory(directory);
process.stdout.write(
  `Validated Bundle Source ${result.sourceId}: ${result.itemCount} items, ${result.versionCount} versions.\n`,
);
