import {
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createGatewayToolCallerWrapper } from "./tools/gateway-caller-context.js";

export function wrapOpenClawToolHooks(
  tools: AnyAgentTool[],
  sessionAgentId: string,
  gatewayCallerAccountId: string | undefined,
  options: OpenClawToolsOptions | undefined,
): AnyAgentTool[] {
  const resolvedConfig = options?.config;
  const hookAgentId = options?.requesterAgentIdOverride ?? sessionAgentId;
  const wrapGatewayCallerIdentity = createGatewayToolCallerWrapper(
    hookAgentId,
    options ? { ...options, agentAccountId: gatewayCallerAccountId } : options,
  );

  if (options?.wrapBeforeToolCallHook === false) {
    return tools.map(wrapGatewayCallerIdentity);
  }
  const defaultHookContext: HookContext = {
    ...(hookAgentId ? { agentId: hookAgentId } : {}),
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.currentChannelId ? { channelId: options.currentChannelId } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: resolvedConfig, agentId: hookAgentId }),
  };
  const hookContext = { ...defaultHookContext, ...options?.beforeToolCallHookContext };
  options?.recordToolPrepStage?.("openclaw-tools:tool-hooks");
  return tools
    .map((tool) =>
      isToolWrappedWithBeforeToolCallHook(tool)
        ? tool
        : wrapToolWithBeforeToolCallHook(tool, hookContext),
    )
    .map(wrapGatewayCallerIdentity);
}
