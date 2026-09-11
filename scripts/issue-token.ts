#!/usr/bin/env -S node --import tsx
/**
 * TASK-914: mints an access token for a person, signed with PCA_AUTH_SECRET.
 *
 *   PCA_AUTH_SECRET=… pnpm run token -- --subject jane@example.test \
 *     --role approver --production PROD-DEMO [--production PROD-2] [--ttl 86400]
 *
 * The token is printed to stdout and nothing else is; hand it to the person
 * over a channel you trust. `--production '*'` grants every production and
 * is meant for a local operator only. `--role` is viewer, requester, or
 * approver (each includes the ones before it).
 */
import { parseArgs } from "node:util";

import { systemClock } from "@pca/application";
import { principalSchema } from "@pca/contracts";
import { issueToken } from "@pca/local-auth";

const main = (): void => {
  const { values } = parseArgs({
    options: {
      subject: { type: "string" },
      role: { type: "string", default: "requester" },
      production: { type: "string", multiple: true, default: [] },
      ttl: { type: "string" },
      issuer: { type: "string", default: "pca-local" },
    },
  });
  const secret = process.env["PCA_AUTH_SECRET"];
  if (secret === undefined || secret.trim() === "") {
    throw new Error(
      "PCA_AUTH_SECRET is not set; the token must be signed with the server's secret.",
    );
  }
  if (values.subject === undefined) {
    throw new Error("--subject is required: the identity approvals and audit events will record.");
  }
  const productions = values.production.includes("*") ? "*" : values.production;
  if (productions !== "*" && productions.length === 0) {
    throw new Error(
      "At least one --production is required (or --production '*' for a local operator).",
    );
  }
  const principal = principalSchema.parse({
    subject: values.subject,
    issuer: values.issuer,
    type: "USER",
    roles: [values.role],
    productions,
  });
  const ttlSeconds = values.ttl === undefined ? undefined : Number.parseInt(values.ttl, 10);
  if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
    throw new Error("--ttl must be a positive number of seconds.");
  }
  process.stdout.write(
    `${issueToken({ secret, principal, clock: systemClock, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) })}\n`,
  );
};

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
