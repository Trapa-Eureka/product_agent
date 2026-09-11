import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";

import { AuthService } from "./auth.service";

/**
 * Asked for once, when the server issues no demo session (TASK-914,
 * DESIGN.md §2): the coordinator pastes the access token their operator
 * minted. Nothing else renders until a token is in place, because nothing
 * else can load without one.
 */
@Component({
  selector: "pca-token-prompt",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="prompt" role="dialog" aria-labelledby="token-title">
      <h2 id="token-title">Access token required</h2>
      <p>
        This server does not issue demo sessions. Paste the access token your operator gave you; it
        names you in every approval and audit entry you make.
      </p>
      <label>
        <span>Access token</span>
        <input
          type="password"
          autocomplete="off"
          spellcheck="false"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          (keydown.enter)="submit()"
        />
      </label>
      <button type="button" (click)="submit()" [disabled]="draft().trim().length === 0">
        Use token
      </button>
    </section>
  `,
  styles: `
    .prompt {
      max-width: 520px;
      border: 1px solid var(--border, #ccc);
      border-radius: 8px;
      padding: 16px 20px;
      background: var(--panel);
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 12px 0;
    }
    input {
      font: inherit;
      padding: 6px 8px;
    }
  `,
})
export class TokenPrompt {
  private readonly auth = inject(AuthService);
  readonly draft = signal("");

  submit(): void {
    this.auth.useToken(this.draft());
    this.draft.set("");
  }
}
