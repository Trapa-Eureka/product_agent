import type { Routes } from "@angular/router";

import { environment } from "./environment";
import { AuditPage } from "./pages/audit-page";
import { OverviewPage } from "./pages/overview-page";
import { SchedulePage } from "./pages/schedule-page";
import { SectionPage } from "./pages/section-page";
import { ChangeWorkspace } from "./workspace/change-workspace";

/**
 * One production at a time. The nav entries mirror DESIGN.md §2. Schedule
 * (TASK-507) and Audit (TASK-508) are the two nav destinations the backlog
 * ever scoped real views for; the rest of the production nav (Scenes, Cast,
 * Locations, Call Sheets, Tasks) is outside this MVP and says so rather
 * than pretend.
 */
export const routes: Routes = [
  { path: "", redirectTo: `productions/${environment.defaultProductionId}`, pathMatch: "full" },
  {
    path: "productions/:productionId",
    children: [
      { path: "", component: ChangeWorkspace, title: "Change workspace" },
      { path: "overview", component: OverviewPage, title: "Overview" },
      {
        path: "scenes",
        component: SectionPage,
        data: { section: "Scenes", lands: "a future phase" },
      },
      { path: "cast", component: SectionPage, data: { section: "Cast", lands: "a future phase" } },
      {
        path: "locations",
        component: SectionPage,
        data: { section: "Locations", lands: "a future phase" },
      },
      { path: "schedule", component: SchedulePage, title: "Schedule" },
      {
        path: "call-sheets",
        component: SectionPage,
        data: { section: "Call Sheets", lands: "a future phase" },
      },
      {
        path: "tasks",
        component: SectionPage,
        data: { section: "Tasks", lands: "a future phase" },
      },
      { path: "audit", component: AuditPage, title: "Audit" },
    ],
  },
  { path: "**", redirectTo: "" },
];
