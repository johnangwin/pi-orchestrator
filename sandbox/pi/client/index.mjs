import { readClientConfig, startLinkServer } from "./link.mjs";
import { runtimeIdentity } from "./environment.mjs";
import { registerModelRoute } from "./model.mjs";
import { turnEvent } from "./turn.mjs";

const configPath = "/workspace/input/session.json";
let activeServer;
let activeContext;
let lastAssistant;
const deliveredMessageIds = [];

function messageText(message) {
  const references =
    message.references.length === 0
      ? ""
      : `\n\nReferences:\n${message.references.map((item) => `- ${item}`).join("\n")}`;
  return `[Orchestrator ${message.id}]\n\n${JSON.stringify(message.body, null, 2)}${references}`;
}

export default async function orchestratorClient(pi) {
  const config = await readClientConfig(configPath);
  registerModelRoute(pi, config);

  pi.on("session_start", async (_event, context) => {
    if (activeServer) await activeServer.close();
    activeContext = context;
    const runtime = runtimeIdentity({
      client_version: process.env.ORCHESTRATOR_CLIENT_VERSION,
      pi_version: process.env.ORCHESTRATOR_PI_VERSION,
    });
    if (
      config.client_version !== runtime.ORCHESTRATOR_CLIENT_VERSION ||
      config.pi_version !== runtime.ORCHESTRATOR_PI_VERSION
    ) {
      throw new Error(
        "Pi runtime identity does not match Session configuration",
      );
    }
    activeServer = await startLinkServer({
      config,
      async deliver(message) {
        if (!activeContext) throw new Error("Pi Session is not active");
        deliveredMessageIds.push(message.id);
        const content = messageText(message);
        if (activeContext.isIdle()) {
          pi.sendUserMessage(content);
        } else {
          pi.sendUserMessage(content, {
            deliverAs: message.priority === "urgent" ? "steer" : "followUp",
          });
        }
      },
    });
    activeServer.emit("session-started", {
      model_alias: config.model?.alias ?? null,
      pi_model: config.model?.pi_model ?? null,
    });
    context.ui.setStatus(
      "orchestrator",
      `${config.identity.seat} · epoch ${config.identity.epoch}`,
    );
  });

  pi.on("turn_end", async (event) => {
    if (event.message?.role === "assistant") lastAssistant = event.message;
  });

  pi.on("agent_settled", async () => {
    if (!activeServer || !config.model || deliveredMessageIds.length === 0)
      return;
    const messageIds = deliveredMessageIds.splice(0);
    const result = turnEvent(messageIds, config.model, lastAssistant);
    lastAssistant = undefined;
    activeServer.emit(result.event, result.data);
  });

  pi.on("session_shutdown", async (_event, context) => {
    context.ui.setStatus("orchestrator", undefined);
    activeContext = undefined;
    lastAssistant = undefined;
    deliveredMessageIds.splice(0);
    const server = activeServer;
    activeServer = undefined;
    if (server) await server.close();
  });

  pi.registerCommand("orchestrate", {
    description: "Show the active Orchestrator Link identity",
    handler: async (args, context) => {
      if (args.trim() !== "status") {
        context.ui.notify("Usage: /orchestrate status", "warning");
        return;
      }
      const config = await readClientConfig(configPath);
      context.ui.notify(
        `${config.identity.run}/${config.identity.seat}/${config.identity.session} epoch ${config.identity.epoch}`,
        "info",
      );
    },
  });
}
