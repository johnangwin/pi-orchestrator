export interface ClientActionConfig {
  readonly permission_ceiling: {
    readonly assignment: { readonly kind: string };
    readonly actions: readonly string[];
  };
  readonly profile?: "read" | "write";
}

export function actionAllowed(
  config: ClientActionConfig,
  action: string,
): boolean;

export default function orchestratorClient(pi: unknown): Promise<void>;
