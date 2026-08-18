const providerName = "orchestrator";

function baseUrl(api) {
  return api === "anthropic-messages"
    ? "https://inference.local"
    : "https://inference.local/v1";
}

export function registerModelRoute(pi, config) {
  if (!config.model || !config.brief) return;
  const model = config.model;
  pi.registerProvider(providerName, {
    name: `OpenShell ${model.alias}`,
    baseUrl: baseUrl(model.api),
    apiKey: "unused",
    api: model.api,
    models: [
      {
        id: model.pi_model,
        name: `${model.alias} (${model.pi_model})`,
        reasoning: model.reasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.context_window,
        maxTokens: model.max_tokens,
      },
    ],
  });
}

export function modelArguments(config) {
  if (!config.model || !config.brief) return [];
  return [
    "--provider",
    providerName,
    "--model",
    config.model.pi_model,
    "--append-system-prompt",
    config.brief.path,
  ];
}
