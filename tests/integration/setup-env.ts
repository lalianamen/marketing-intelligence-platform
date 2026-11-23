import { existsSync, readFileSync } from "node:fs";

// Loads .env.local (written by `npm run env:local`) for integration tests.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
// Integration tests always use the local simulated warehouse and a test prefix.
process.env.WAREHOUSE_MODE = "local";
process.env.DATASET_PREFIX = "mip_test";
