import { expect, test } from "@playwright/test";

import {
  approveAndApply,
  gotoWorkspace,
  submitExample,
  readAuditLines,
  waitForCompletion,
  waitForProposal,
} from "./support/workspace";

/**
 * GOLDEN-2 (TESTING.md §4). Runs against `PROD-E2E-2`, its own copy of the
 * Demo Movie fixture — see golden-1-sarah-unavailable.spec.ts for why each
 * golden scenario gets its own production.
 */
test("The warehouse is unavailable Friday: Scene 07/12 move off Friday", async ({ page }) => {
  await gotoWorkspace(page, "PROD-E2E-2");

  await submitExample(page, "The warehouse is unavailable Friday.");
  await waitForProposal(page);

  await expect(page.locator('[data-panel="impact"]')).toContainText("availability");
  await expect(page.locator('[data-panel="plan"]')).toContainText("Move Scene 07 and Scene 12");

  await approveAndApply(page);
  await waitForCompletion(page);

  await page.getByRole("link", { name: "Schedule" }).click();
  const friday = page.locator(".day").filter({ hasText: "Fri, Sep 18, 2026" });
  await expect(friday).toContainText("No scenes scheduled.");

  await page.getByRole("link", { name: "Audit" }).click();
  const lines = await readAuditLines(page);
  expect(lines).toHaveLength(7);
  expect(lines[0]).toBe('e2e reported: "The warehouse is unavailable Friday."');
  expect(lines.at(-1)).toBe("System verified the change.");
  expect(lines.some((line) => /^System applied \d+ operations?\.$/u.test(line))).toBe(true);
});
