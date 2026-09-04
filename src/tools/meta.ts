import { z } from "zod";

/** All tools read a local checkout or R2 snapshot and never write the repo. */
export const READ_ONLY_SNAPSHOT = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const reportOutput = {
  markdown: z
    .string()
    .describe(
      "Human-readable markdown report. Always present, including empty-result cases. Does not write files."
    ),
};

export type ReportOut = { markdown: string };

export function ok(markdown: string): {
  content: [{ type: "text"; text: string }];
  structuredContent: ReportOut;
} {
  return {
    content: [{ type: "text" as const, text: markdown }],
    structuredContent: { markdown },
  };
}

export function fail(markdown: string): {
  content: [{ type: "text"; text: string }];
  structuredContent: ReportOut;
  isError: true;
} {
  return {
    content: [{ type: "text" as const, text: markdown }],
    structuredContent: { markdown },
    isError: true,
  };
}
