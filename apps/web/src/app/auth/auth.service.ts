import { HttpClient } from "@angular/common/http";
import { Injectable, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";

import type { Principal } from "@pca/contracts";

import { environment } from "../environment";

/**
 * The console's session (TASK-914, DESIGN.md §2).
 *
 * Every request and the notification socket carry an access token. Where it
 * comes from is the server's decision, not the console's: a demo server
 * hands one out at `/auth/demo-session`, a deployment does not, and then the
 * coordinator pastes the token their operator gave them. The token lives in
 * `sessionStorage` (this tab, this session) so a reload does not ask twice;
 * a 401 clears it and asks again.
 */
export type SessionState = "unknown" | "ready" | "needs-token";

export const DEMO_SESSION_PATH = `${environment.apiBase}/auth/demo-session`;

const STORAGE_KEY = "pca.accessToken";

const readStored = (): string | null => {
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
};

const writeStored = (token: string | null): void => {
  try {
    if (token === null) globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    else globalThis.sessionStorage?.setItem(STORAGE_KEY, token);
  } catch {
    // Storage may be unavailable (private mode, disabled); the session still works for this load.
  }
};

@Injectable({ providedIn: "root" })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly state = signal<SessionState>("unknown");
  readonly token = signal<string | null>(null);
  /** Known when the server issued the session; a pasted token reveals its subject only through use. */
  readonly principal = signal<Principal | null>(null);

  /** Runs before the shell renders: a stored token, else the server's demo session, else ask. */
  async ensureSession(): Promise<void> {
    const stored = readStored();
    if (stored !== null) {
      this.token.set(stored);
      this.state.set("ready");
      return;
    }
    try {
      const session = await firstValueFrom(
        this.http.get<{ token: string; principal: Principal }>(DEMO_SESSION_PATH),
      );
      this.token.set(session.token);
      this.principal.set(session.principal);
      writeStored(session.token);
      this.state.set("ready");
    } catch {
      this.state.set("needs-token");
    }
  }

  /** The coordinator pasted a token an operator issued. */
  useToken(token: string): void {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;
    this.token.set(trimmed);
    this.principal.set(null);
    writeStored(trimmed);
    this.state.set("ready");
  }

  /** The server refused the token (401): forget it and ask for another. */
  clear(): void {
    this.token.set(null);
    this.principal.set(null);
    writeStored(null);
    this.state.set("needs-token");
  }
}
