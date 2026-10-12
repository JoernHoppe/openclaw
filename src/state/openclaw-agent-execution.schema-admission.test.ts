import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  AgentDatabaseSchemaAdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError,
} from "./agent-database-admission-error.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it.each(["current", "revoked"] as const)(
  "readmits a settled schema refusal before caller work only when its source is %s",
  async (authority) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-schema-readmission-")) };
    const options = { agentId: "main", env };
    const database = openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabaseByPath(database.path);
    invalidateOpenClawAgentDatabaseValidation(database.path);
    const execution = captureOpenClawAgentDatabaseExecution(options);
    let revoked = false;
    let sourceCurrent = true;
    const refusal = new Error("Caller revoked after schema publication refusal");
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent() {
        execution.assertCurrent();
        if (!sourceCurrent) {
          throw refusal;
        }
      },
      createAdmission: (binding) => () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          try {
            binding.authorize(request);
          } catch (error) {
            if (
              authority === "revoked" &&
              error instanceof AgentDatabaseSchemaAdmissionChangedError
            ) {
              sourceCurrent = false;
            }
            throw error;
          }
          if (
            !revoked &&
            request.stage === "prepare" &&
            typeof request.facts === "object" &&
            request.facts !== null &&
            "kind" in request.facts &&
            request.facts.kind === "agent-validation-start"
          ) {
            invalidateOpenClawAgentDatabaseValidation(database.path);
            revoked = true;
          }
          if (!grant()) {
            throw new Error("Schema readmission fixture lost admission");
          }
        }, binding.attachment),
      }),
    };
    const operation = vi.fn(async () => "recovered");
    try {
      if (authority === "revoked") {
        await expect(execution.runExisting(source, operation)).rejects.toBe(refusal);
        expect(operation).not.toHaveBeenCalled();
      } else {
        await expect(execution.runExisting(source, operation)).resolves.toBe("recovered");
        expect(operation).toHaveBeenCalledOnce();
        const failure = new AgentDatabaseSchemaAdmissionChangedError();
        const rejected = vi.fn(async () => {
          throw failure;
        });
        await expect(execution.runExisting(source, rejected)).rejects.toBe(failure);
        expect(rejected).toHaveBeenCalledOnce();
      }
      expect(revoked).toBe(true);
    } finally {
      await execution.release();
    }
  },
);

it("rejects malformed native schema receipts without replaying caller work", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-schema-invalid-")) };
  const options = { agentId: "main", env };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  let publications = 0;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: () => execution.assertCurrent(),
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        if (
          request.stage === "prepare" &&
          typeof request.facts === "object" &&
          request.facts !== null &&
          "validation" in request.facts &&
          request.facts.validation !== undefined
        ) {
          publications += 1;
          request.facts = { ...request.facts, validation: {} };
        }
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Malformed schema fixture lost admission");
        }
      }, binding.attachment),
    }),
  };
  const operation = vi.fn(async () => "not admitted");
  try {
    await expect(execution.runExisting(source, operation)).rejects.toBeInstanceOf(
      AgentDatabaseSchemaAdmissionInvalidError,
    );
    expect(publications).toBe(1);
    expect(operation).not.toHaveBeenCalled();
  } finally {
    await execution.release();
  }
});
