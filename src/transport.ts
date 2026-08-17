export interface LinkFrame {
  readonly version: 1;
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface LinkTransport {
  readonly name: string;
  connect(signal?: AbortSignal): Promise<void>;
  send(frame: LinkFrame, signal?: AbortSignal): Promise<void>;
  receive(signal?: AbortSignal): AsyncIterable<LinkFrame>;
  close(): Promise<void>;
}
