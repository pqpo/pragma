#!/usr/bin/env node

import { resolve } from "node:path";

import { migrateBundleRegistryV1 } from "../packages/local-host/dist/index.js";

const directory = resolve(process.argv[2] ?? ".");
const result = await migrateBundleRegistryV1(directory);
process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
