export interface ClientIdentity {
  readonly run: string;
  readonly agent: string;
  readonly session: string;
  readonly generation: number;
}

export interface ClientConfig {
  readonly version: 2;
  readonly identity: ClientIdentity;
  readonly token: string;
  readonly listen: {
    readonly host: "127.0.0.1";
    readonly port: number;
  };
  readonly client_version: string;
  readonly pi_version: string;
  readonly permission_ceiling: {
    readonly version: 2;
    readonly role: string;
    readonly assignment: {
      readonly kind: "run" | "design" | "task" | "review" | "query";
      readonly task?: string | undefined;
      readonly lens?: "spec" | "architecture" | "quality" | "quant" | undefined;
    };
    readonly source: "none" | "read";
    readonly write_lease: "never" | "task";
    readonly pi_tools: readonly (
      "read" | "grep" | "find" | "ls" | "bash" | "write" | "edit"
    )[];
    readonly actions: readonly string[];
    readonly host_policy_digest: string;
    readonly local_policy_digest: string;
    readonly role_permissions_digest: string;
    readonly assignment_digest: string;
    readonly permission_ceiling_digest: string;
  };
  readonly profile?: "read" | "write" | undefined;
  readonly context?:
    | {
        readonly initial_fraction: number;
        readonly warn_fraction: number;
        readonly handoff_fraction: number;
        readonly stop_fraction: number;
      }
    | undefined;
  readonly source_digest?: string | undefined;
  readonly policy_digest?: string | undefined;
  readonly model?:
    | {
        readonly profile: string;
        readonly gateway_alias: string;
        readonly gateway: string;
        readonly pi_model: string;
        readonly api:
          "anthropic-messages" | "openai-completions" | "openai-responses";
        readonly context_window: number;
        readonly max_tokens: number;
        readonly reasoning: boolean;
        readonly locality: "local" | "remote";
        readonly route_digest: string;
        readonly pricing?:
          | {
              readonly currency: "USD";
              readonly input_per_million: number;
              readonly output_per_million: number;
              readonly cache_read_per_million: number;
              readonly cache_write_per_million: number;
            }
          | undefined;
      }
    | undefined;
  readonly brief?:
    | {
        readonly path: "/workspace/input/brief.md";
        readonly digest: string;
        readonly content_digest: string;
      }
    | undefined;
  readonly inputs?:
    | readonly {
        readonly path: string;
        readonly byte_count: number;
        readonly digest: string;
      }[]
    | undefined;
  readonly workspace_projection?:
    | ({
        readonly source_digest: string;
        readonly workspace_generation: number;
        readonly manifest_digest: string;
        readonly volume_name: string;
        readonly volume_digest: string;
        readonly mount_set_digest: string;
        readonly mount_table_digest: string;
        readonly image_digest: string;
        readonly projection_digest: string;
      } & (
        | {
            readonly lease_id: string;
            readonly lease_digest: string;
            readonly write_roots_digest: string;
            readonly gateway_digest: string;
          }
        | {
            readonly lease_id?: never;
            readonly lease_digest?: never;
            readonly write_roots_digest?: never;
            readonly gateway_digest?: never;
          }
      ))
    | undefined;
}

export interface ClientMessage {
  readonly version: 2;
  readonly id: string;
  readonly run: string;
  readonly from: { readonly agent?: string; readonly host?: true };
  readonly to: {
    readonly agent: string;
    readonly session?: string;
    readonly generation?: number;
  };
  readonly type: string;
  readonly priority: "normal" | "urgent";
  readonly reply_to: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly references: readonly string[];
  readonly created_at: string;
}

export const MAX_LINK_FRAME_BYTES: number;

export function readClientConfig(filePath: string): Promise<ClientConfig>;

export function startLinkServer(options: {
  readonly config: ClientConfig;
  readonly deliver: (message: ClientMessage) => void | Promise<void>;
}): Promise<{
  readonly host: string;
  readonly port: number;
  emit(
    event:
      | "session-started"
      | "session-blocked"
      | "handoff-requested"
      | "context-pressure"
      | "report-submitted"
      | "turn-completed"
      | "turn-failed",
    data: Readonly<Record<string, unknown>>,
  ): void;
  close(): Promise<void>;
}>;
