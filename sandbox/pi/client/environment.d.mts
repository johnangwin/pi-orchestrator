export function sessionEnvironment(
  identity: {
    readonly ORCHESTRATOR_CLIENT_VERSION: string;
    readonly ORCHESTRATOR_PI_VERSION: string;
    readonly HTTP_PROXY?: string;
    readonly HTTPS_PROXY?: string;
    readonly NODE_EXTRA_CA_CERTS?: string;
    readonly NODE_USE_ENV_PROXY?: string;
  },
  inference?: boolean,
): Record<string, string>;

export function runtimeIdentity(value: unknown): {
  readonly ORCHESTRATOR_CLIENT_VERSION: string;
  readonly ORCHESTRATOR_PI_VERSION: string;
};

export function readRuntimeIdentity(filePath: string): Promise<{
  readonly ORCHESTRATOR_CLIENT_VERSION: string;
  readonly ORCHESTRATOR_PI_VERSION: string;
}>;
