export interface ClientIdentity {
  readonly run: string;
  readonly seat: string;
  readonly session: string;
  readonly epoch: number;
}

export interface ClientConfig {
  readonly version: 1;
  readonly identity: ClientIdentity;
  readonly token: string;
  readonly listen: {
    readonly host: "127.0.0.1";
    readonly port: number;
  };
  readonly client_version: string;
  readonly pi_version: string;
  readonly model?:
    | {
        readonly alias: "plan" | "code" | "quant" | "review" | "fast";
        readonly pi_model: string;
        readonly api:
          "anthropic-messages" | "openai-completions" | "openai-responses";
        readonly context_window: number;
        readonly max_tokens: number;
        readonly reasoning: boolean;
      }
    | undefined;
  readonly brief?:
    | {
        readonly path: "/workspace/input/brief.md";
        readonly digest: string;
      }
    | undefined;
}

export interface ClientMessage {
  readonly version: 1;
  readonly id: string;
  readonly run: string;
  readonly from: { readonly seat?: string; readonly host?: true };
  readonly to: {
    readonly seat: string;
    readonly session?: string;
    readonly epoch?: number;
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
