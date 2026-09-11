import { HttpErrorResponse, type HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { catchError, throwError } from "rxjs";

import { environment } from "../environment";
import { AuthService, DEMO_SESSION_PATH } from "./auth.service";

/**
 * Bearer token on every API request (TASK-914); a 401 means the token is no
 * longer good, so the session is cleared and the shell asks for another.
 * The demo-session route is the one API call made without a token.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const token = auth.token();
  const isApi = request.url.startsWith(environment.apiBase);
  const outgoing =
    isApi && token !== null && request.url !== DEMO_SESSION_PATH
      ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : request;
  return next(outgoing).pipe(
    catchError((error: unknown) => {
      if (isApi && error instanceof HttpErrorResponse && error.status === 401 && token !== null) {
        auth.clear();
      }
      return throwError(() => error);
    }),
  );
};
