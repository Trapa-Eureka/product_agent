import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";

import { ChangeSubmissionService } from "./change-submission.service";

/** DESIGN.md §3 "Input": the golden-scenario sentences, offered as helper text. */
export const EXAMPLE_SENTENCES = [
  "Sarah cannot shoot Friday.",
  "The warehouse is unavailable Friday.",
  "Scene 18 now needs a red car.",
] as const;

/**
 * DESIGN.md §3 "Input": a sentence, submitted as a job. Clicking an example
 * fills the box; it does not submit on its own, so a coordinator can still
 * edit it first.
 */
@Component({
  selector: "pca-change-input",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form (submit)="onSubmit($event)">
      <label for="pca-change-text">Describe the change</label>
      <textarea
        id="pca-change-text"
        rows="3"
        [value]="text()"
        (input)="onInput($event)"
        [disabled]="submission.state() === 'submitting'"
        placeholder="e.g. Sarah cannot shoot Friday."
      ></textarea>
      <div class="examples">
        <span class="examples-label">Examples:</span>
        @for (example of examples; track example) {
          <button type="button" class="example" (click)="useExample(example)">{{ example }}</button>
        }
      </div>
      <div class="row">
        <button type="submit" class="primary" [disabled]="submitDisabled()">
          {{ submission.state() === "submitting" ? "Submitting…" : "Submit" }}
        </button>
      </div>
      @if (submission.error(); as error) {
        <p class="error" role="alert">
          <strong>{{ error.code }}</strong> {{ error.message }}
        </p>
      }
    </form>
  `,
  styles: `
    form {
      display: grid;
      gap: 8px;
    }
    label {
      font-size: 12px;
      color: var(--muted);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font: inherit;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      resize: vertical;
    }
    .examples {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .examples-label {
      color: var(--muted);
      font-size: 12px;
    }
    .example {
      font-size: 12px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--ink);
      cursor: pointer;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    button.primary {
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid var(--accent);
      background: var(--panel);
      color: var(--ink);
      cursor: pointer;
    }
    button.primary:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .error {
      color: var(--danger);
      margin: 0;
    }
  `,
})
export class ChangeInput {
  readonly productionId = input.required<string>();
  readonly examples = EXAMPLE_SENTENCES;

  readonly submission = inject(ChangeSubmissionService);
  readonly text = signal("");

  readonly submitDisabled = () =>
    this.text().trim().length === 0 || this.submission.state() === "submitting";

  onInput(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
  }

  useExample(example: string): void {
    this.text.set(example);
  }

  onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const text = this.text().trim();
    if (text.length === 0) return;
    void this.submission.submit(this.productionId(), text).then(() => {
      if (this.submission.state() !== "error") this.text.set("");
    });
  }
}
