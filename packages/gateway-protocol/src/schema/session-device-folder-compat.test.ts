import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { EnvironmentSummarySchema } from "./environments.js";
import { SessionPlacementSchema } from "./session-placement.js";
import { SessionsCreateParamsSchema } from "./sessions-create.js";
import { SessionRowSchema } from "./sessions-row.js";

describe("pre-device-folder protocol compatibility", () => {
  it("accepts existing local and managed session shapes without a device folder", () => {
    const local = {
      key: "agent:main:existing-local",
      kind: "direct",
      sessionId: "local-session",
      sessionRoot: "/workspace/existing",
    };
    const managedPlacement = {
      state: "active",
      generation: 4,
      createdAtMs: 100,
      updatedAtMs: 200,
      stateChangedAtMs: 150,
      environmentId: "environment-existing",
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "sha256:previous-workspace",
      remoteWorkspaceDir: "/workspace/managed",
      activeOwnerEpoch: 7,
    };
    expect(Value.Check(SessionsCreateParamsSchema, { key: local.key })).toBe(true);
    expect(Value.Check(SessionsCreateParamsSchema, { key: local.key, worktree: true })).toBe(true);
    expect(Value.Parse(SessionRowSchema, local)).toEqual(local);
    expect(Value.Parse(SessionPlacementSchema, managedPlacement)).toEqual(managedPlacement);
    const managed = { ...local, placement: managedPlacement };
    expect(Value.Parse(SessionRowSchema, managed)).toEqual(managed);
  });

  it("accepts an older node advertisement without inventing folder support", () => {
    const previousNode = {
      id: "node:previous-host",
      type: "node",
      status: "available",
      workerSlots: { total: 2, available: 1 },
    };
    const decoded = Value.Parse(EnvironmentSummarySchema, previousNode);
    expect(decoded).toEqual(previousNode);
    expect(decoded.workerHost).toBeUndefined();
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...previousNode,
        workerHost: { deviceFolders: true },
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...previousNode,
        workerHost: { deviceFolders: "true" },
      }),
    ).toBe(false);
  });
});
