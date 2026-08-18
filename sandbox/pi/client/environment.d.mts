export function sessionEnvironment(identity: {
  readonly ORCHESTRATOR_CLIENT_VERSION: string;
  readonly ORCHESTRATOR_PI_VERSION: string;
}): Record<string, string>;

export function runtimeIdentity(value: unknown): {
  readonly ORCHESTRATOR_CLIENT_VERSION: string;
  readonly ORCHESTRATOR_PI_VERSION: string;
};

export function readRuntimeIdentity(filePath: string): Promise<{
  readonly ORCHESTRATOR_CLIENT_VERSION: string;
  readonly ORCHESTRATOR_PI_VERSION: string;
}>;
