import { expect, type Page } from "@playwright/test";

/**
 * Shared driving code for the three golden-scenario specs (TASK-604,
 * TESTING.md §2 "Keep E2E focused on the three core demo scenarios"). Each
 * scenario spec calls these in the same order DESIGN.md §10's demo story
 * does; only the sentence and the scenario-specific assertions differ
 * between specs.
 */

export const gotoWorkspace = async (page: Page, productionId: string): Promise<void> => {
  await page.goto(`/productions/${productionId}`);
  await expect(page.getByRole("heading", { name: "Change Workspace" })).toBeVisible();
};

/** Clicks the matching DESIGN.md §3 example sentence, then submits it as a job. */
export const submitExample = async (page: Page, sentence: string): Promise<void> => {
  await page.getByRole("button", { name: sentence, exact: true }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
};

/** Waits for the job to reach `awaiting_approval`: the impact/proposal panels are populated and the decision is live. */
export const waitForProposal = async (page: Page): Promise<void> => {
  await expect(page.getByRole("button", { name: "Approve & Apply" }).first()).toBeEnabled({
    timeout: 20_000,
  });
};

/** Opens the DESIGN.md §5 confirmation and confirms it. */
export const approveAndApply = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Approve & Apply" }).first().click();
  const dialog = page.getByRole("alertdialog", { name: "Confirm approval" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Approve & Apply" }).click();
  await expect(dialog).toBeHidden();
};

/**
 * Waits until every DESIGN.md §6 timeline row is `done` — the job reached
 * `completed` through the full applying/verifying path, not merely past
 * the approval decision. `waitForProposal`'s button alone cannot tell the
 * two apart, since the button disables the moment the job leaves
 * `awaiting_approval`. Asserted as "8 done", not "0 pending": the latter
 * would pass just as well while the timeline is transiently empty (no
 * `li` at all) between Angular re-renders, which proves nothing.
 */
export const waitForCompletion = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-panel="progress"] li[data-status="done"]')).toHaveCount(8, {
    timeout: 20_000,
  });
};

/**
 * Reads the DESIGN.md §7 audit story, waiting for all seven lines first —
 * `allTextContents()` is a one-shot read, not an auto-retrying assertion,
 * so calling it right after navigating here can read the list before its
 * fetch resolves.
 */
export const readAuditLines = async (page: Page): Promise<string[]> => {
  await expect(page.locator(".events li")).toHaveCount(7, { timeout: 10_000 });
  return page.locator(".events li .what").allTextContents();
};
