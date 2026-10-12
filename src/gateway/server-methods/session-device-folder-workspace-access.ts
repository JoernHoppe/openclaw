import { isDeepStrictEqual } from "node:util";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  parseWorkspaceInspectionResult,
  WORKSPACE_INSPECTION_COMMAND,
  type WorkspaceInspectionInput,
  type WorkspaceInspectionResult,
} from "../../worker/workspace-inspection-protocol.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

type LoadedSession = ReturnType<typeof loadGatewaySessionEntryReadOnly>;
type Operation = WorkspaceInspectionInput["operation"];

export class DeviceFolderFilesUnavailableError extends Error {}

/** Device-folder access is valid only through its exact live paired-device placement. */
export async function resolveDeviceFolderWorkspaceAccess(
  loaded: LoadedSession,
  context?: GatewayRequestContext,
) {
  const entry = loaded.entry;
  const folder = entry?.deviceFolder;
  if (!folder) {
    return undefined;
  }
  if (!entry.sessionId || !loaded.agentId || !loaded.storePath) {
    throw new DeviceFolderFilesUnavailableError(
      "Start this session on its paired device to browse or edit its files.",
    );
  }
  const sessionId = entry.sessionId;
  const metadata = captureSessionEntryMetadataRead({
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    storePath: loaded.storePath,
  });
  const readEntry = () =>
    metadata
      ? metadata.readCurrent()
      : loadGatewaySessionEntryReadOnly(loaded.canonicalKey, { agentId: loaded.agentId }).entry;
  const assertSession = () => {
    const current = readEntry();
    if (
      current?.sessionId !== sessionId ||
      current.lifecycleRevision !== entry.lifecycleRevision ||
      current.archivedAt !== entry.archivedAt ||
      !isDeepStrictEqual(current.deviceFolder, folder)
    ) {
      throw new Error("The device-folder session changed; refresh this session.");
    }
  };
  const placements = context?.workerSessionPlacementService;
  const environments = context?.workerEnvironmentService;
  const placement = await readSessionWorkerPlacementAsync({ context: context ?? {}, sessionId });
  assertSession();
  if (placement?.state !== "active" || !placements || !environments) {
    throw new DeviceFolderFilesUnavailableError(
      "Start this session on its paired device to browse or edit its files.",
    );
  }
  const assertCurrent = () => {
    assertSession();
    const current = placements.getMany([sessionId]).get(sessionId);
    const environment = environments.get(placement.environmentId);
    if (
      current?.state !== "active" ||
      current.sessionId !== sessionId ||
      current.agentId !== loaded.agentId ||
      current.sessionKey !== loaded.canonicalKey ||
      current.generation !== placement.generation ||
      current.environmentId !== placement.environmentId ||
      current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
      current.remoteWorkspaceDir !== folder.path ||
      environment?.state !== "attached" ||
      environment.ownerEpoch !== placement.activeOwnerEpoch ||
      environment.nodeDeviceId !== folder.deviceId ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== sessionId
    ) {
      throw new Error("The device-folder placement changed; refresh this session.");
    }
  };
  return {
    kind: "active" as const,
    async inspect<T extends Operation>(
      operation: T,
      request: Omit<
        Extract<WorkspaceInspectionInput, { operation: T }>,
        "operation" | "sessionKey"
      >,
      authorize?: () => void,
    ): Promise<WorkspaceInspectionResult<T>> {
      const assertAuthorized = () => {
        assertCurrent();
        authorize?.();
      };
      const run = async () => {
        assertAuthorized();
        const tunnel = await environments.startTunnel({
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        assertAuthorized();
        if (
          tunnel.environmentId !== placement.environmentId ||
          tunnel.ownerEpoch !== placement.activeOwnerEpoch
        ) {
          throw new Error("The device-folder tunnel owner changed.");
        }
        const result = await tunnel.runWorkspaceCommand({
          argv: [WORKSPACE_INSPECTION_COMMAND],
          input: JSON.stringify({ ...request, operation, sessionKey: loaded.canonicalKey }),
          transportRetry: operation === "set" ? "never" : "idempotent",
          assertCurrent: assertAuthorized,
          timeoutMs: 30_000,
        });
        assertAuthorized();
        if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
          throw new Error(
            "Device-folder inspection failed; reconnect the paired device and retry.",
          );
        }
        return parseWorkspaceInspectionResult(operation, result.stdout);
      };
      if (operation !== "set") {
        return await run();
      }
      // Device folders have no Gateway checkpoint to reconcile. The session lifecycle lock is the
      // authoritative save fence: it serializes editor writes with stop, archive, and *** rewrites.
      return await runExclusiveSessionLifecycleMutation("workspace-edit", {
        scope: loaded.storePath,
        identities: [loaded.canonicalKey, ...loaded.storeKeys, sessionId],
        run,
      });
    },
  };
}
