import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceExtensions = new Set([".ts", ".mts", ".mjs", ".sh"]);
const retiredIdentity =
  /\b(?:seat|seats|epoch|epochs)\b|SeatRegistry|SessionEpoch|stale_session_epoch|identity\.seat|identity\.epoch|\.seats\b/i;

async function activeSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await activeSourceFiles(entryPath)));
    } else if (
      sourceExtensions.has(path.extname(entry.name)) ||
      entry.name === "Dockerfile"
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("v0.3 Agent terminology", () => {
  it("keeps retired Seat and epoch vocabulary out of active source", async () => {
    const files = (
      await Promise.all(
        ["src", path.join("sandbox", "pi")].map((directory) =>
          activeSourceFiles(path.join(process.cwd(), directory)),
        ),
      )
    ).flat();
    const offenders: string[] = [];
    for (const file of files) {
      if (retiredIdentity.test(await readFile(file, "utf8"))) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
    expect(files.map((file) => path.basename(file))).toContain("agent.ts");
    expect(files.map((file) => path.basename(file))).not.toContain("seat.ts");
  });
});
