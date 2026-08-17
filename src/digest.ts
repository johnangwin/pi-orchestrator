import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

export function sha256(value: string | Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestParts(
  domain: string,
  parts: ReadonlyArray<readonly [name: string, content: string | Uint8Array]>,
): Digest {
  const hash = createHash("sha256");
  const domainBytes = Buffer.from(domain, "utf8");
  hash.update(lengthPrefix(domainBytes.length));
  hash.update(domainBytes);

  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, "utf8");
    const contentBytes =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    hash.update(lengthPrefix(nameBytes.length));
    hash.update(nameBytes);
    hash.update(lengthPrefix(contentBytes.length));
    hash.update(contentBytes);
  }

  return `sha256:${hash.digest("hex")}`;
}

export function digestPlan(
  planMarkdown: Uint8Array,
  tasksYaml: Uint8Array,
): Digest {
  return digestParts("pi-orchestrator/plan/v1", [
    ["plan.md", planMarkdown],
    ["tasks.yaml", tasksYaml],
  ]);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
