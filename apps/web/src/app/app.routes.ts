import type { Routes } from "@angular/router";

import { environment } from "./environment";
import { AuditPage } from "./pages/audit-page";
import { OverviewPage } from "./pages/overview-page";
import { SectionPage } from "./pages/section-page";
import { ChangeWorkspace } from "./workspace/change-workspace";

/**
 * One production at a time. The nav entries mirror DESIGN.md §2; the pages
 * that need real data land with TASK-507 (schedule) and TASK-508 (audit),
 * so the others state what they will show rather than pretend.
 */
export const routes: Routes = [
  { path: "", redirectTo: `productions/${environment.defaultProductionId}`, pathMatch: "full" },
  {
    path: "productions/:productionId",
    children: [
      { path: "", component: ChangeWorkspace, title: "Change workspace" },
      { path: "overview", component: OverviewPage, title: "Overview" },
      { path: "scenes", component: SectionPage, data: { section: "Scenes", lands: "TASK-507" } },
      { path: "cast", component: SectionPage, data: { section: "Cast", lands: "TASK-507" } },
      {
        path: "locations",
        component: SectionPage,
        data: { section: "Locations", lands: "TASK-507" },
      },
      {
        path: "schedule",
        component: SectionPage,
        data: { section: "Schedule", lands: "TASK-507" },
      },
      {
        path: "call-sheets",
        component: SectionPage,
        data: { section: "Call Sheets", lands: "TASK-507" },
      },
      { path: "tasks", component: SectionPage, data: { section: "Tasks", lands: "TASK-507" } },
      { path: "audit", component: AuditPage, title: "Audit" },
    ],
  },
  { path: "**", redirectTo: "" },
];
