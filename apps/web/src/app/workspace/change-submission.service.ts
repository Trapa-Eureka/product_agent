import { Injectable, effect, inject, signal, untracked } from "@angular/core";

import type {
  ChangeRequest,
  ImpactExplanation,
  JobRun,
  ToolError,
  TypedChange,
} from "@pca/contracts";

import { ApiError, ProductionApi } from "../api/production-api";
import { RealtimeService } from "../realtime/realtime.service";

/**
 * Owns the one job the change workspace's input panel just submitted
 * (TASK-502/503, ARCHITECTURE.md §11).
 *
 * Follows the ARCHITECTURE.md §11 rule literally: the notification channel
 * is a hint, never the truth. A live event for the tracked job's ID is read
 * only to decide *whether* to re-read the job over REST, not *what* it now
 * says — `job`, `changeRequest`, and `impactExplanation` are always what the
 * last REST read returned. This is also what makes ambiguity resolution
 * work: the run's `options` field only ever reaches this service through a
 * REST read (`AgentJobEvent` does not carry it), so every path here — the
 * initial submit, resuming a resolved job, and the live-update refresh —
 * reads the canonical record rather than trusting a socket message to be
 * complete.
 *
 * Component-scoped (provided by `ChangeWorkspace`), one instance per
 * workspace. `reset()` is the caller's job whenever the production changes,
 * since the Angular router may reuse the workspace component instance
 * across productions.
 */
export type SubmissionState = "idle" | "submitting" | "error";

@Injectable()
export class ChangeSubmissionService {
  private readonly api = inject(ProductionApi);
  private readonly realtime = inject(RealtimeService);

  readonly job = signal<JobRun | null>(null);
  readonly changeRequest = signal<ChangeRequest | null>(null);
  readonly impactExplanation = signal<ImpactExplanation | null>(null);
  readonly originalText = signal("");
  readonly state = signal<SubmissionState>("idle");
  readonly error = signal<ToolError | null>(null);

  constructor() {
    effect(() => {
      const current = this.job();
      const liveJobs = this.realtime.view()?.jobs;
      if (current === null || liveJobs === undefined) return;
      const live = liveJobs.find((entry) => entry.id === current.id);
      // No change since our last read, or the socket has not caught up yet: nothing to do.
      if (live === undefined || live.updatedAt === current.updatedAt) return;
      untracked(() => void this.refresh(current.productionId, current.id));
    });
  }

  reset(): void {
    this.job.set(null);
    this.changeRequest.set(null);
    this.impactExplanation.set(null);
    this.originalText.set("");
    this.state.set("idle");
    this.error.set(null);
  }

  /** Submits a fresh sentence as a new job, replacing anything this service was tracking. */
  async submit(productionId: string, text: string): Promise<void> {
    this.reset();
    this.originalText.set(text);
    this.state.set("submitting");
    try {
      const { job } = await this.api.submitChange(productionId, { text });
      this.job.set(job);
      this.state.set("idle");
      await this.loadChangeRequestIfKnown(productionId, job);
    } catch (error) {
      this.state.set("error");
      this.error.set(this.asToolError(error));
    }
  }

  /** Resumes the tracked job at `resolving` with the interpretation the user picked. */
  async resolve(productionId: string, change: TypedChange): Promise<void> {
    const current = this.job();
    if (current === null) return;
    this.state.set("submitting");
    this.error.set(null);
    try {
      const { job } = await this.api.submitChange(productionId, {
        text: this.originalText(),
        change,
        jobId: current.id,
      });
      this.job.set(job);
      this.state.set("idle");
      await this.loadChangeRequestIfKnown(productionId, job);
    } catch (error) {
      this.state.set("error");
      this.error.set(this.asToolError(error));
    }
  }

  /**
   * DESIGN.md §5: rejects the tracked job's proposal. A rejection is not the
   * consequential write approval leads to, so it needs no confirmation step
   * — the backend still enforces validity either way. `jobId` completes the
   * job server-side; the read afterward reflects that immediately rather
   * than waiting on the socket round trip.
   */
  async reject(productionId: string): Promise<void> {
    const current = this.job();
    if (current?.proposalId === undefined) return;
    this.state.set("submitting");
    this.error.set(null);
    try {
      await this.api.decideProposal(productionId, current.proposalId, "REJECT", current.id);
      await this.refresh(productionId, current.id);
      this.state.set("idle");
    } catch (error) {
      this.state.set("error");
      this.error.set(this.asToolError(error));
    }
  }

  /**
   * DESIGN.md §5: the consequential write, after the UI's own confirmation
   * step. Approves, then applies as a job continuing this run's timeline;
   * `expectedProductionVersion` comes from the decision's own response, the
   * version the proposal was actually built against, not a guess at the
   * production's current one.
   */
  async approveAndApply(productionId: string): Promise<void> {
    const current = this.job();
    if (current?.proposalId === undefined) return;
    const proposalId = current.proposalId;
    this.state.set("submitting");
    this.error.set(null);
    try {
      const decided = await this.api.decideProposal(productionId, proposalId, "APPROVE");
      const { job } = await this.api.applyProposalAsJob(productionId, proposalId, {
        approvalId: decided.approval.id,
        expectedProductionVersion: decided.proposal.baseProductionVersion,
        idempotencyKey: crypto.randomUUID(),
        jobId: current.id,
      });
      this.job.set(job);
      this.state.set("idle");
    } catch (error) {
      this.state.set("error");
      this.error.set(this.asToolError(error));
    }
  }

  private async refresh(productionId: string, jobId: string): Promise<void> {
    try {
      const job = await this.api.getJob(productionId, jobId);
      // A newer submission may have replaced what we're tracking while this read was in flight.
      if (this.job()?.id !== jobId) return;
      this.job.set(job);
      await this.loadChangeRequestIfKnown(productionId, job);
    } catch {
      // A transient read failure here is not fatal: the next live event retries it.
    }
  }

  private async loadChangeRequestIfKnown(productionId: string, job: JobRun): Promise<void> {
    if (job.changeRequestId === undefined) return;
    if (this.changeRequest()?.id === job.changeRequestId) return;
    try {
      const changeRequest = await this.api.getChangeRequest(productionId, job.changeRequestId);
      if (this.job()?.id !== job.id) return;
      this.changeRequest.set(changeRequest);
      await this.loadImpactExplanation(productionId, job.id, changeRequest);
    } catch {
      // Non-fatal: the detected-change card stays empty until the next successful read.
    }
  }

  /** DESIGN.md §3 impact panel (TASK-503), fetched once the change request that names the change is known. */
  private async loadImpactExplanation(
    productionId: string,
    jobId: string,
    changeRequest: ChangeRequest,
  ): Promise<void> {
    try {
      const explanation = await this.api.getImpactExplanation(productionId, changeRequest.payload);
      if (this.job()?.id !== jobId) return;
      this.impactExplanation.set(explanation);
    } catch {
      // Non-fatal: the impact panel stays empty until the next successful read.
    }
  }

  private asToolError(error: unknown): ToolError {
    if (error instanceof ApiError) return error.error;
    return {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
