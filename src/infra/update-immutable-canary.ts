import { createConfigIO } from "../config/io.factory.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import type { ImmutableInstallRecord } from "./update-immutable-install-schema.js";
import type { ImmutableServiceObservation } from "./update-immutable-service.js";

/** Same-schema activation never migrates or rewinds live databases. Doctor rehearses private copies. */
export async function rehearseImmutableGeneration(
  record: ImmutableInstallRecord,
  root: string,
  service: ImmutableServiceObservation,
  options: { timeoutMs?: number; onReceipt?: (line: string) => void },
  assertCurrent: () => void,
) {
  const env = service.state.env;
  const { sourceConfig: config } = await createConfigIO({
    env,
    configPath: record.descriptor.service.configPath,
    observe: false,
    pluginValidation: "skip",
  }).readBestEffortConfigSnapshot();
  assertCurrent();
  const result = await validateUpdateCandidateCanary({
    root,
    sourceBundledPlugins: {
      packageRoot: record.descriptor.current.path,
      directory: resolveBundledPluginsDir(env),
    },
    config,
    stateDir: record.descriptor.service.stateDir,
    env,
    nodeRunner: record.descriptor.runtime.path,
    timeoutMs: options.timeoutMs,
    migrationPolicy: "startup-only",
    assertCurrent,
    onStep: () => options.onReceipt?.("immutable:canary-step"),
  });
  assertCurrent();
  if (
    result.status !== "ok" ||
    result.phase !== "readiness" ||
    result.steps.find((step) => step.name === "candidate-gateway-startup")?.exitCode !== 0
  ) {
    throw new Error(
      "Immutable candidate canary did not verify Doctor, plugins, startup and readiness; current is unchanged.",
    );
  }
}
