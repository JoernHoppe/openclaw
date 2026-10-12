import { beforeAll, describe, expect, it } from "vitest";
import "../../styles.css";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";

describe("chat appearance preferences", () => {
  beforeAll(async () => {
    await warmJson5();
  });

  it("validates and changes the browser-local chat width", () => {
    const { container, props } = renderAppearance({});
    const input = container.querySelector<HTMLInputElement>("[data-settings-chat-message-width]");
    expect(input).not.toBeNull();

    input!.value = " min(1280px,  82%) ";
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onAppearanceChange).toHaveBeenCalledWith({
      chatMessageMaxWidth: "min(1280px, 82%)",
    });

    input!.value = "960px; color: red";
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input!.validationMessage).not.toBe("");
    expect(props.onAppearanceChange).toHaveBeenCalledTimes(1);
  });

  it("retains an uncommitted width while other appearance settings refresh", () => {
    const { container, props } = renderAppearance({});
    const input = container.querySelector<HTMLInputElement>("[data-settings-chat-message-width]")!;
    input.focus();
    input.value = "max-content";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    renderConfigInto({ ...props, chatShowTaskProgress: false }, container);
    expect(container.querySelector("[data-settings-chat-message-width]")).toBe(input);
    expect(input.value).toBe("max-content");
    expect(props.onAppearanceChange).not.toHaveBeenCalled();

    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onAppearanceChange).toHaveBeenCalledWith({ chatMessageMaxWidth: "max-content" });

    renderConfigInto({ ...props, chatMessageMaxWidth: "48rem" }, container);
    expect(input.value).toBe("48rem");
  });

  it("marks browser follow-up overrides and resets them to the server", () => {
    const { container, props } = renderAppearance({
      chatFollowUpMode: "queue",
      chatFollowUpModeOverridden: true,
      serverQueueMode: "steer",
    });

    expect(container.textContent).toContain("Overriding server default (steer)");
    const reset = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Reset to server default",
    );
    expect(reset).toBeDefined();
    reset?.click();
    expect(props.resetChatFollowUpMode).toHaveBeenCalledOnce();
    expect(props.onAppearanceChange).not.toHaveBeenCalled();
  });
});
