import assert from "node:assert/strict";
import { root } from "@openclaw/fs-safe/root";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { restoreInterruptedAuditRecoveryArchive } from "./state-migrations.audit-recovery.js";

const directories: unknown = JSON.parse(process.argv[2] ?? "null");
assert.ok(Array.isArray(directories) && directories.every((value) => typeof value === "string"));
const results = [];
try {
  for (const directory of directories) {
    const warnings: string[] = [];
    const restored = await restoreInterruptedAuditRecoveryArchive({
      root: await root(directory),
      relativePath: "config-audit.jsonl.migrated.raw",
      label: "config audit log",
      warnings,
    });
    results.push({ restored, warnings });
  }
} finally {
  await closeOpenClawStateDatabaseAsync();
}
process.stdout.write(JSON.stringify(results));
