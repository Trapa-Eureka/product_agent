import { provideHttpClient, withFetch, withInterceptors } from "@angular/common/http";
import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from "@angular/core";
import { provideRouter, withComponentInputBinding } from "@angular/router";

import { routes } from "./app.routes";
import { authInterceptor } from "./auth/auth.interceptor";
import { AuthService } from "./auth/auth.service";

/** Zoneless and signal-based: state changes are explicit, which suits a console that shows job stages. */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    // The session is settled before anything renders (TASK-914): a stored
    // token, the server's demo session, or a prompt for one.
    provideAppInitializer(() => inject(AuthService).ensureSession()),
  ],
};
