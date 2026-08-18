import { readClientConfig, startLinkServer } from "./link.mjs";
import { runtimeIdentity } from "./environment.mjs";

const configPath = "/workspace/input/session.json";
let activeServer;
let activeContext;

function messageText(message) {
  const references =
    message.references.length === 0
      ? ""
      : `\n\nReferences:\n${message.references.map((item) => `- ${item}`).join("\n")}`;
  return `[Orchestrator ${message.id}]\n\n${JSON.stringify(message.body, null, 2)}${references}`;
}

export default function orchestratorClient(pi) {
  pi.on("session_start", async (_event, context) => {
    if (activeServer) await activeServer.close();
    activeContext = context;
    const config = await readClientConfig(configPath);
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
    context.ui.setStatus(
      "orchestrator",
      `${config.identity.seat} · epoch ${config.identity.epoch}`,
    );
  });

  pi.on("session_shutdown", async (_event, context) => {
    context.ui.setStatus("orchestrator", undefined);
    activeContext = undefined;
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
