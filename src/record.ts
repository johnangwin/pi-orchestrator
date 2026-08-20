import {
  open,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "./config.js";
import { canonicalJson } from "./digest.js";
import { OrchestratorError } from "./error.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export interface ImmutableRecord {
  readonly id: string;
  readonly digest: string;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ImmutableRecordStore<T extends ImmutableRecord> {
  readonly directory: string;

  constructor(
    directory: string,
    private readonly kind: string,
    private readonly validate: (value: unknown) => T,
  ) {
    this.directory = path.resolve(directory);
  }

  private recordDirectory(id: string, digest: string): string {
    const parsedId = IdentifierSchema.parse(id);
    const parsedDigest = DigestSchema.parse(digest);
    return path.join(
      this.directory,
      parsedId,
      parsedDigest.slice("sha256:".length),
    );
  }

  private async readPath(filePath: string): Promise<T> {
    try {
      return this.validate(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new OrchestratorError(
        "immutable_store_corrupt",
        `Invalid ${this.kind} record at ${filePath}`,
        { cause: error },
      );
    }
  }

  async get(id: string, digest: string): Promise<T> {
    const record = await this.readPath(
      path.join(this.recordDirectory(id, digest), "record.json"),
    );
    if (record.id !== id || record.digest !== digest) {
      throw new OrchestratorError(
        "immutable_store_corrupt",
        `${this.kind} record path does not match its identity`,
      );
    }
    return record;
  }

  async list(id: string): Promise<T[]> {
    const parsedId = IdentifierSchema.parse(id);
    const parent = path.join(this.directory, parsedId);
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: T[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new OrchestratorError(
          "immutable_store_corrupt",
          `Unexpected ${this.kind} store entry '${path.join(parent, entry.name)}'`,
        );
      }
      records.push(await this.get(parsedId, `sha256:${entry.name}`));
    }
    return records;
  }

  async put(value: T): Promise<T> {
    const record = this.validate(value);
    const destination = this.recordDirectory(record.id, record.digest);
    try {
      const existing = await this.get(record.id, record.digest);
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new OrchestratorError(
          "immutable_record_conflict",
          `${this.kind} '${record.id}' digest names different content`,
        );
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(parent, ".record-"));
    try {
      const filePath = path.join(staging, "record.json");
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(staging, destination);
        await syncDirectory(parent);
        return record;
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          throw error;
        }
        const raced = await this.get(record.id, record.digest);
        if (canonicalJson(raced) !== canonicalJson(record)) {
          throw new OrchestratorError(
            "immutable_record_conflict",
            `${this.kind} '${record.id}' raced with different content`,
          );
        }
        return raced;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
