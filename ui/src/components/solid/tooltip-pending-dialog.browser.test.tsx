import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../modal-dialog.ts";
import "../tooltip.ts";

const viewLoad = vi.hoisted(() => {
  let release!: () => void;
  return {
    started: false,
    promise: new Promise<void>((resolve) => (release = resolve)),
    release: () => release(),
  };
});
vi.mock("./tooltip.tsx", async (importOriginal) => {
  viewLoad.started = true;
  await viewLoad.promise;
  return importOriginal();
});

let modal: HTMLElementTagNameMap["openclaw-modal-dialog"];
let tooltip: HTMLElementTagNameMap["openclaw-tooltip"];
afterEach(async () => {
  viewLoad.release();
  await tooltip?.updateComplete;
  modal?.remove();
});

it("cancels an invisible tooltip load without stealing the dialog's Escape", async () => {
  modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Read details";
  tooltip = document.createElement("openclaw-tooltip");
  tooltip.content = "Detailed help";
  const button = document.createElement("button");
  button.textContent = "Help";
  tooltip.append(button);
  modal.append(tooltip);
  document.body.append(modal);
  await modal.updateComplete;
  const dialog = modal.querySelector<HTMLDialogElement>("dialog")!;
  await expect.poll(() => dialog.dataset.phase).toBe("open");
  button.focus();
  await expect.poll(() => viewLoad.started).toBe(true);
  const surface = tooltip.shadowRoot!.querySelector<HTMLElement>(".tooltip-surface")!;
  expect(surface.matches(":popover-open")).toBe(false);
  const cancel = vi.fn();
  modal.addEventListener("modal-cancel", cancel);
  await userEvent.keyboard("{Escape}");
  expect(modal.open).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  viewLoad.release();
  await tooltip.updateComplete;
  expect(tooltip.hasAttribute("open")).toBe(false);
  expect(surface.matches(":popover-open")).toBe(false);
});
