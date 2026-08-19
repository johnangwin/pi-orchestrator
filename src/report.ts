import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson, sha256, type Digest } from "./digest.js";
import { OrchestratorError } from "./error.js";
import { writeJsonAtomic } from "./state.js";

export const ReportSchema = z
  .object({
    version: z.literal(1),
    id: IdentifierSchema,
    kind: z.enum(["implementation", "consultation", "review", "handoff"]),
    run: IdentifierSchema,
    seat: IdentifierSchema,
    session: IdentifierSchema,
    epoch: z.number().int().nonnegative(),
    task: IdentifierSchema.optional(),
    source_digest: z.string().optional(),
    patch_digest: z.string().optional(),
    content: z.string().min(1),
    content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Report = z.infer<typeof ReportSchema>;

const implementationSections = [
  "Summary",
  "Files changed",
  "Contracts changed",
  "Behavior changed",
  "Checks attempted",
  "Deviations",
  "Risks",
  "Questions",
  "Downstream",
] as const;

const handoffSections = [
  "Completed",
  "Current State",
  "Blockers",
  "Next Action",
  "Source Anchors",
] as const;

function validateSections(content: string, sections: readonly string[]): void {
  for (const section of sections) {
    if (!new RegExp(`^#{1,6}\\s+${section}\\s*$`, "m").test(content)) {
      throw new OrchestratorError(
        "invalid_report",
        `Report is missing the '${section}' section`,
      );
    }
  }
}

export function createReport(
  input: Omit<Report, "version" | "content_digest">,
): Report {
  if (input.kind === "implementation")
    validateSections(input.content, implementationSections);
  if (input.kind === "handoff")
    validateSections(input.content, handoffSections);
  return ReportSchema.parse({
    version: 1,
    ...input,
    content_digest: sha256(input.content),
  });
}

export class ReportStore {
  readonly directory: string;

  constructor(runDirectory: string) {
    this.directory = path.join(runDirectory, "reports");
  }

  async put(report: Report): Promise<Report> {
    const parsed = ReportSchema.parse(report);
    if (sha256(parsed.content) !== (parsed.content_digest as Digest)) {
      throw new OrchestratorError(
        "invalid_report",
        `Report '${parsed.id}' content digest is invalid`,
      );
    }
    const filePath = path.join(this.directory, `${parsed.id}.json`);
    try {
      const existing = ReportSchema.parse(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (canonicalJson(existing) !== canonicalJson(parsed)) {
        throw new OrchestratorError(
          "duplicate_report",
          `Report '${parsed.id}' already exists with other content`,
        );
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeJsonAtomic(filePath, parsed);
    return parsed;
  }

  async get(id: string): Promise<Report> {
    IdentifierSchema.parse(id);
    return ReportSchema.parse(
      JSON.parse(
        await readFile(path.join(this.directory, `${id}.json`), "utf8"),
      ) as unknown,
    );
  }
}
