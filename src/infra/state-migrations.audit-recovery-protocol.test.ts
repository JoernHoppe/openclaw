import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { legacyAuditFileIdentitiesMatch } from "./state-migrations.audit-checkpoints.js";
import {
  parseAuditRecoveryRestoreJournal,
  serializeAuditRecoveryRestoreJournal,
} from "./state-migrations.audit-recovery-protocol.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

const sourceRaw = Buffer.from("legacy audit row\n");
const scrubPattern = Buffer.from(" \t".repeat(16));

describe("legacy audit recovery identity persistence", () => {
  const fixture = createFixtureLifetime();
  afterEach(() => fixture.cleanup());

  it("recovers released numeric restore journals and refuses replacement files", async ({
    signal,
  }) =>
    fixture.run(async () => {
      const cases: {
        directory: string;
        file: string;
        restorePath: string;
        progressPath: string;
        journal: string;
        scrubbed: Buffer;
        replaced: boolean;
      }[] = [];
      for (const replaced of [false, true]) {
        const directory = fixture.createTempDir("legacy-audit-restore-");
        const file = path.join(directory, "config-audit.jsonl.migrated.raw");
        const restorePath = `${file}.doctor-scrub-restore`;
        const progressPath = `${file}.doctor-scrub-progress`;
        await fs.writeFile(file, sourceRaw, { mode: 0o600 });
        const identity = await fs.stat(file);
        expect(Number.isSafeInteger(identity.dev)).toBe(true);
        expect(Number.isSafeInteger(identity.ino)).toBe(true);
        // This is the v2026.10.2 writer's schema, independent of today's serializer.
        const journal = `${JSON.stringify({
          schemaVersion: 6,
          rawBase64: sourceRaw.toString("base64"),
          scrubPatternBase64: scrubPattern.toString("base64"),
          target: { dev: identity.dev, ino: identity.ino, size: sourceRaw.length },
        })}\n`;
        await fs.writeFile(restorePath, journal, { mode: 0o600 });
        await fs.writeFile(
          progressPath,
          JSON.stringify({
            schemaVersion: 1,
            journalHash: createHash("sha256").update(journal).digest("hex"),
            direction: "scrubbing",
            committedBytes: sourceRaw.length,
            pendingEnd: sourceRaw.length,
            extentBytes: sourceRaw.length,
          }),
          { mode: 0o600 },
        );
        const scrubbed = Buffer.alloc(sourceRaw.length, scrubPattern);
        await fs.writeFile(file, scrubbed);
        if (replaced) {
          await fs.rename(file, `${file}.original`);
          await fs.writeFile(file, scrubbed, { mode: 0o600 });
        }
        cases.push({ directory, file, restorePath, progressPath, journal, scrubbed, replaced });
      }
      // Bun on Windows releases retained SQLite resources when the owning process exits.
      const result = await fixture.track(
        runNodeScript(
          (workerArgv) => [
            ...workerArgv(resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.auditRecovery)),
            JSON.stringify(cases.map(({ directory }) => directory)),
          ],
          process.env,
          undefined,
          { signal, executable: process.execPath, maxBuffer: 64 * 1024 },
        ),
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { restored: true, warnings: [] },
        {
          restored: false,
          warnings: [expect.stringContaining("no longer matches its restore journal target")],
        },
      ]);
      for (const { file, restorePath, progressPath, journal, scrubbed, replaced } of cases) {
        if (replaced) {
          expect(await fs.readFile(file)).toEqual(scrubbed);
          expect(await fs.readFile(restorePath, "utf8")).toBe(journal);
        } else {
          expect(await fs.readFile(file)).toEqual(sourceRaw);
          await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.access(progressPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    }));

  it("round-trips adjacent Windows file IDs above the numeric precision limit", () => {
    const target = { dev: "4", ino: "9007199254740993", size: sourceRaw.length };
    const raw = serializeAuditRecoveryRestoreJournal({ rawBytes: sourceRaw, scrubPattern, target });
    const journal = parseAuditRecoveryRestoreJournal(raw);
    expect(journal.target).toEqual(target);
    expect(legacyAuditFileIdentitiesMatch(journal.target, target)).toBe(true);
    expect(
      legacyAuditFileIdentitiesMatch(journal.target, { ...target, ino: "9007199254740992" }),
    ).toBe(false);
    expect(
      legacyAuditFileIdentitiesMatch(journal.target, { ...target, ino: 9_007_199_254_740_992 }),
    ).toBe(false);
  });

  it("refuses an already-rounded numeric restore identity", () => {
    expect(() =>
      parseAuditRecoveryRestoreJournal(
        JSON.stringify({
          schemaVersion: 6,
          rawBase64: sourceRaw.toString("base64"),
          scrubPatternBase64: scrubPattern.toString("base64"),
          target: { dev: 4, ino: 9_007_199_254_740_992, size: sourceRaw.length },
        }),
      ),
    ).toThrow("invalid legacy audit recovery restore journal");
  });
});
