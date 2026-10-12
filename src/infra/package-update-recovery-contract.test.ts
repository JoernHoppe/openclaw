import path from "node:path";
import { expect, it } from "vitest";
import { PackageTransactionDescriptorSchema } from "./package-update-recovery-contract.js";

it("reads signed exact identities from persisted package recovery descriptors", () => {
  const parent = path.resolve("package-recovery-fixture");
  const candidate = {
    digest: "a".repeat(64),
    identity: "-1:-9223372036854775807",
    version: "2026.10.12",
  };
  const descriptor = {
    version: 1,
    transactionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    packageName: "openclaw",
    liveRoot: path.join(parent, "openclaw"),
    stageRoot: path.join(parent, "stage"),
    backupRoot: path.join(parent, ".openclaw.package-backup-fixture"),
    binDir: path.join(parent, "bin"),
    shimBackupRoot: null,
    shimBackupIdentity: null,
    previous: null,
    candidate,
    launchers: [],
    interruptedLaunchers: [],
    retention: null,
  };
  expect(PackageTransactionDescriptorSchema.parse(JSON.parse(JSON.stringify(descriptor)))).toEqual(
    descriptor,
  );
});
