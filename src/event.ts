import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const AuditEventSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    type: z.string().min(1),
    actor: z.string().min(1),
    run: z.string().optional(),
    task: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export function createAuditEvent(
  input: Omit<AuditEvent, "version" | "id" | "created_at"> & {
    readonly now?: Date;
  },
): AuditEvent {
  const { now, ...event } = input;
  return AuditEventSchema.parse({
    version: 1,
    id: `event-${randomUUID()}`,
    created_at: (now ?? new Date()).toISOString(),
    ...event,
  });
}

export async function appendAuditEvent(
  runDirectory: string,
  event: AuditEvent,
): Promise<void> {
  const parsed = AuditEventSchema.parse(event);
  await mkdir(runDirectory, { recursive: true });
  const handle = await open(
    path.join(runDirectory, "events.jsonl"),
    "a",
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
