export const MAX_PATCH_BYTES: number;

export interface ExportPatchOptions {
  readonly artifactId: string;
  readonly task: string;
  readonly workspaceRoot: string;
  readonly sessionConfigPath: string;
  readonly outputRoot: string;
  readonly maxPatchBytes?: number;
}

export interface ExportedPatch {
  readonly artifactPath: string;
  readonly bundle: Record<string, unknown>;
  readonly descriptor: {
    readonly version: 1;
    readonly id: string;
    readonly kind: "patch";
    readonly run: string;
    readonly seat: string;
    readonly session: string;
    readonly epoch: number;
    readonly task: string;
    readonly sandbox_path: string;
    readonly media_type: "application/json";
    readonly schema: "patch/v1";
    readonly byte_count: number;
    readonly content_digest: string;
    readonly created_at: string;
  };
}

export function exportPatch(
  options: ExportPatchOptions,
): Promise<ExportedPatch>;
