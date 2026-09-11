import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

import type {
  Approval,
  ApprovalDecision,
  AuditEvent,
  ChangeRequest,
  ImpactExplanation,
  JobRun,
  McpToolOutput,
  Proposal,
  RecoverySnapshot,
  ToolError,
  TypedChange,
} from "@pca/contracts";

import { environment } from "../environment";

/**
 * The REST client (TASK-110 routes). Thin on purpose: every method is one
 * route, typed by the shared contracts, and errors arrive as the same
 * `ToolError` the server sends, so a component can show the code and the
 * next step without translating anything.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: ToolError,
  ) {
    super(error.message);
    this.name = "ApiError";
  }
}

const isErrorBody = (body: unknown): body is { error: ToolError } =>
  typeof body === "object" && body !== null && "error" in body;

/** Whatever a request threw, as the `ToolError` a page shows: the server's own, or a synthetic one. */
export const toToolError = (error: unknown): ToolError =>
  error instanceof ApiError
    ? error.error
    : {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };

@Injectable({ providedIn: "root" })
export class ProductionApi {
  private readonly http = inject(HttpClient);

  private url(productionId: string, path = ""): string {
    return `${environment.apiBase}/productions/${encodeURIComponent(productionId)}${path}`;
  }

  private async request<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    try {
      return await firstValueFrom(
        this.http.request<T>(method, url, {
          ...(body === undefined ? {} : { body }),
          headers: new HttpHeaders({ "content-type": "application/json" }),
        }),
      );
    } catch (error) {
      const failure = error as { status?: number; error?: unknown };
      if (typeof failure.status === "number" && isErrorBody(failure.error)) {
        throw new ApiError(failure.status, failure.error.error);
      }
      throw error;
    }
  }

  getProduction(productionId: string): Promise<McpToolOutput<"get_production">> {
    return this.request("GET", this.url(productionId));
  }

  getRecovery(productionId: string): Promise<RecoverySnapshot> {
    return this.request("GET", this.url(productionId, "/recovery"));
  }

  listJobs(productionId: string): Promise<{ jobs: JobRun[] }> {
    return this.request("GET", this.url(productionId, "/jobs"));
  }

  getJob(productionId: string, jobId: string): Promise<JobRun> {
    return this.request("GET", this.url(productionId, `/jobs/${encodeURIComponent(jobId)}`));
  }

  submitChange(
    productionId: string,
    input: { text: string; change?: TypedChange; jobId?: string },
  ): Promise<{ job: JobRun }> {
    return this.request("POST", this.url(productionId, "/changes"), input);
  }

  getChangeRequest(productionId: string, changeRequestId: string): Promise<ChangeRequest> {
    return this.request(
      "GET",
      this.url(productionId, `/change-requests/${encodeURIComponent(changeRequestId)}`),
    );
  }

  getImpactExplanation(productionId: string, change: TypedChange): Promise<ImpactExplanation> {
    return this.request("POST", this.url(productionId, "/analysis/explanation"), { change });
  }

  listAudit(productionId: string, limit = 50): Promise<{ events: AuditEvent[] }> {
    return this.request("GET", this.url(productionId, `/audit?limit=${limit}`));
  }

  /** With `includeScenes`, the response also carries every scheduled scene, resolved in one read (TASK-913). */
  getSchedule(
    productionId: string,
    options: { includeScenes?: boolean } = {},
  ): Promise<McpToolOutput<"get_schedule">> {
    return this.request(
      "GET",
      this.url(
        productionId,
        options.includeScenes === true ? "/schedule?includeScenes=true" : "/schedule",
      ),
    );
  }

  getScene(productionId: string, sceneId: string): Promise<McpToolOutput<"get_scene">> {
    return this.request("GET", this.url(productionId, `/scenes/${encodeURIComponent(sceneId)}`));
  }

  /** `jobId`, when the decision came from a tracked job, completes it on rejection (TASK-505). */
  decideProposal(
    productionId: string,
    proposalId: string,
    decision: ApprovalDecision,
    jobId?: string,
  ): Promise<{ approval: Approval; proposal: Proposal; alreadyDecided: boolean }> {
    return this.request(
      "POST",
      this.url(productionId, `/proposals/${encodeURIComponent(proposalId)}/decision`),
      { decision, ...(jobId === undefined ? {} : { jobId }) },
    );
  }

  /** Applies as a job continuing `jobId`'s timeline; the response echoes the run, still `awaiting_approval`. */
  applyProposalAsJob(
    productionId: string,
    proposalId: string,
    input: {
      approvalId: string;
      expectedProductionVersion: number;
      idempotencyKey: string;
      jobId: string;
    },
  ): Promise<{ job: JobRun }> {
    return this.request(
      "POST",
      this.url(productionId, `/proposals/${encodeURIComponent(proposalId)}/apply`),
      input,
    );
  }
}
