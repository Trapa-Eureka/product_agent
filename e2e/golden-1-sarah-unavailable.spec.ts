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
 * GOLDEN-1 (TESTING.md §4), driven through the real browser: Angular → API
 * → the rule-based model → the application/domain engine → the memory
 * store → back to the UI (TESTING.md §2 "E2E"). Runs against `PROD-E2E-1`,
 * its own copy of the Demo Movie fixture, so nothing another golden
 * scenario's spec does can affect it.
 */
test("Sarah cannot shoot Friday: Scene 07/12 move off Friday", async ({ page }) => {
  await gotoWorkspace(page, "PROD-E2E-1");

  await submitExample(page, "Sarah cannot shoot Friday.");
  await waitForProposal(page);

  // What is affected? (DESIGN.md §1 question 2, §3 impact panel)
  await expect(page.locator('[data-panel="impact"]')).toContainText("Sarah's availability");

  // What do you recommend? (§4 proposal card). Monday and Tuesday are both
  // genuinely free; the rule model ranks by fewest new warnings, which
  // — unlike the fixed model the GOLDEN-1 unit test uses — is free to
  // pick either, so this only pins the move itself, not the target day.
  await expect(page.locator('[data-panel="plan"]')).toContainText("Move Scene 07 and Scene 12");

  // What will happen if I approve? (§5 confirmation) → approve.
  await approveAndApply(page);
  await waitForCompletion(page);

  // Show updated schedule (§10 demo story step 8): "after approved move,
  // S07/S12 are not on Friday" (TESTING.md §4) — wherever they landed.
  await page.getByRole("link", { name: "Schedule" }).click();
  const friday = page.locator(".day").filter({ hasText: "Fri, Sep 18, 2026" });
  await expect(friday).toContainText("No scenes scheduled.");
  await expect(page.locator(".day").filter({ hasText: "Scene 07" })).not.toContainText(
    "Fri, Sep 18, 2026",
  );

  // Show verification and audit event (§10 demo story step 9): DESIGN.md
  // §7's story, in order, submitted through verified.
  await page.getByRole("link", { name: "Audit" }).click();
  const lines = await readAuditLines(page);
  expect(lines).toHaveLength(7);
  expect(lines[0]).toBe('demo-coordinator reported: "Sarah cannot shoot Friday."');
  expect(lines[1]).toBe("Agent requested impact analysis.");
  expect(lines[2]).toMatch(/^System found \d+ conflicts?, affecting \d+ entit(y|ies)\.$/u);
  expect(lines[3]).toMatch(/^Agent proposed .+ \(\d+ operations?\)\.$/u);
  expect(lines[4]).toMatch(/^demo-coordinator approved .+\.$/u);
  expect(lines[5]).toMatch(/^System applied \d+ operations?\.$/u);
  expect(lines[6]).toBe("System verified the change.");
});
