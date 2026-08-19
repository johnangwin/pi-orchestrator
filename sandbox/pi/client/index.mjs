import { readClientConfig, startLinkServer } from "./link.mjs";
import { contextPressureEvent, crossedHandoffThreshold } from "./context.mjs";
import { runtimeIdentity } from "./environment.mjs";
import { registerModelRoute } from "./model.mjs";
import { turnEvent } from "./turn.mjs";

const configPath = "/workspace/input/session.json";
let activeServer;
let activeContext;
let lastAssistant;
const deliveredMessageIds = [];
let lastPressureLevel = "normal";

function currentPressure(context, config) {
  if (!context) return null;
  return contextPressureEvent(context.getContextUsage(), config.context);
}

function publishContextPressure(context, config) {
  if (!activeServer) return;
  const pressure = currentPressure(context, config);
  if (!pressure) return;
  activeServer.emit("context-pressure", pressure);
  if (crossedHandoffThreshold(lastPressureLevel, pressure.level)) {
    activeServer.emit("handoff-requested", {
      source: "context-pressure",
      reason: "Context usage reached the configured Handoff threshold.",
      pressure,
    });
  }
  lastPressureLevel = pressure.level;
}

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
    lastPressureLevel = "normal";
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

  pi.on("turn_end", async (event, context) => {
    if (event.message?.role === "assistant") lastAssistant = event.message;
    publishContextPressure(context, config);
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
    lastPressureLevel = "normal";
    const server = activeServer;
    activeServer = undefined;
    if (server) await server.close();
  });

  pi.registerCommand("orchestrate", {
    description: "Inspect or request an Orchestrator action",
    handler: async (args, context) => {
      const [action, ...rest] = args.trim().split(/\s+/);
      if (action === "handoff") {
        if (!activeServer) {
          context.ui.notify("The Orchestrator Link is unavailable", "error");
          return;
        }
        const pressure = currentPressure(context, config);
        activeServer.emit("handoff-requested", {
          source: "manual",
          reason:
            rest.join(" ").trim() || "The current Session requested Handoff.",
          ...(pressure ? { pressure } : {}),
        });
        context.ui.notify("Handoff requested", "info");
        return;
      }
      if (action !== "status") {
        context.ui.notify(
          "Usage: /orchestrate status | /orchestrate handoff [reason]",
          "warning",
        );
        return;
      }
      const config = await readClientConfig(configPath);
      const pressure = currentPressure(context, config);
      context.ui.notify(
        `${config.identity.run}/${config.identity.seat}/${config.identity.session} epoch ${config.identity.epoch}${pressure ? ` · ${pressure.percent.toFixed(1)}% context` : ""}`,
        "info",
      );
    },
  });
}
