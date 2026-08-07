import pino from "pino";

// Redact anything that could carry credentials or PII we don't want in
// long-term log storage. Paths use pino's dotted-path syntax with wildcards.
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admin-token"]',
  'req.headers["idempotency-key"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-admin-token"]',
  '*.password',
  '*.passwordHash',
  'password',
  'passwordHash',
  'token',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: redactPaths,
    censor: "[REDACTED]",
  },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino/file",
          options: { destination: 1 },
        },
});
