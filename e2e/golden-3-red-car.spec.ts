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
 * GOLDEN-3 (TESTING.md §4): the one golden scenario with no scheduling
 * move — a requirement and a preparation task, nothing else. Runs against
 * `PROD-E2E-3`, its own copy of the Demo Movie fixture.
 */
test("Scene 18 now needs a red car: a requirement and a task are proposed", async ({ page }) => {
  await gotoWorkspace(page, "PROD-E2E-3");

  await submitExample(page, "Scene 18 now needs a red car.");
  await waitForProposal(page);

  // What do you recommend? No candidate comparison exists for this change —
  // it never moves a scene (DESIGN.md §4).
  const plan = page.locator('[data-panel="plan"]');
  await expect(plan).toContainText('Add prop "red car" to Scene 18');
  await expect(plan).toContainText('add prop "red car" to Scene 18');
  await expect(plan).toContainText('create task "Source a red car for Scene 18"');
  await expect(plan.locator("pca-candidate-comparison")).toHaveCount(0);

  await approveAndApply(page);
  await waitForCompletion(page);

  await page.getByRole("link", { name: "Audit" }).click();
  const lines = await readAuditLines(page);
  expect(lines).toHaveLength(7);
  expect(lines[0]).toBe('demo-coordinator reported: "Scene 18 now needs a red car."');
  expect(lines.at(-1)).toBe("System verified the change.");
  expect(lines.some((line) => /^System applied \d+ operations?\.$/u.test(line))).toBe(true);
});
