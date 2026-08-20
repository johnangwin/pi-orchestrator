import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import {
  DEFAULT_CONTEXT_THRESHOLDS,
  validContextThresholds,
} from "./context.mjs";

export const MAX_LINK_FRAME_BYTES = 64 * 1024;
const LINK_PROTOCOL_VERSION = 2;
const CLIENT_CONFIG_VERSION = 2;
const MESSAGE_PROTOCOL_VERSION = 2;
const frameIdPattern = /^[a-z][a-z0-9-]{0,127}$/;
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const modelAliases = new Set(["plan", "code", "quant", "review", "fast"]);
const modelApis = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
]);
const piTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "write",
  "edit",
]);
const orchestratorActions = new Set([
  "ask",
  "message",
  "consult",
  "report",
  "handoff",
  "block",
  "finish",
  "propose_plan",
  "propose_decision",
  "coordinate",
]);
const clientEvents = new Set([
  "session-started",
  "session-blocked",
  "handoff-requested",
  "context-pressure",
  "report-submitted",
  "turn-completed",
  "turn-failed",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function validIdentity(value) {
  return (
    exactKeys(value, ["run", "agent", "session", "generation"]) &&
    identifierPattern.test(value.run) &&
    identifierPattern.test(value.agent) &&
    identifierPattern.test(value.session) &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0
  );
}

function sameIdentity(left, right) {
  return (
    left.run === right.run &&
    left.agent === right.agent &&
    left.session === right.session &&
    left.generation === right.generation
  );
}

function validMessage(message, identity) {
  if (
    !exactKeys(message, [
      "version",
      "id",
      "run",
      "from",
      "to",
      "type",
      "priority",
      "reply_to",
      "body",
      "references",
      "created_at",
    ]) ||
    message.version !== MESSAGE_PROTOCOL_VERSION ||
    !identifierPattern.test(message.id) ||
    message.run !== identity.run ||
    !exactKeys(message.from, [], ["agent", "host"]) ||
    (!identifierPattern.test(message.from.agent ?? "") &&
      message.from.host !== true) ||
    (message.from.host !== undefined && message.from.host !== true) ||
    !exactKeys(message.to, ["agent"], ["session", "generation"]) ||
    message.to.agent !== identity.agent ||
    (message.to.session !== undefined &&
      message.to.session !== identity.session) ||
    (message.to.session !== undefined &&
      !identifierPattern.test(message.to.session)) ||
    (message.to.generation !== undefined &&
      message.to.generation !== identity.generation) ||
    (message.to.generation !== undefined &&
      (!Number.isSafeInteger(message.to.generation) ||
        message.to.generation < 0)) ||
    !identifierPattern.test(message.type) ||
    !["normal", "urgent"].includes(message.priority) ||
    (message.reply_to !== null && !identifierPattern.test(message.reply_to)) ||
    !plainObject(message.body) ||
    !Array.isArray(message.references) ||
    !message.references.every((item) => typeof item === "string") ||
    Number.isNaN(Date.parse(message.created_at))
  ) {
    return false;
  }
  return true;
}

function validFrame(frame) {
  return (
    exactKeys(frame, ["version", "id", "identity", "type", "payload"]) &&
    frame.version === LINK_PROTOCOL_VERSION &&
    frameIdPattern.test(frame.id) &&
    validIdentity(frame.identity) &&
    ["hello", "ping", "deliver"].includes(frame.type) &&
    plainObject(frame.payload)
  );
}

function validModel(value) {
  return (
    exactKeys(value, [
      "alias",
      "pi_model",
      "api",
      "context_window",
      "max_tokens",
      "reasoning",
    ]) &&
    modelAliases.has(value.alias) &&
    typeof value.pi_model === "string" &&
    value.pi_model.length > 0 &&
    value.pi_model.length <= 256 &&
    modelApis.has(value.api) &&
    Number.isSafeInteger(value.context_window) &&
    value.context_window > 0 &&
    Number.isSafeInteger(value.max_tokens) &&
    value.max_tokens > 0 &&
    value.max_tokens <= value.context_window &&
    typeof value.reasoning === "boolean"
  );
}

function validBrief(value) {
  return (
    exactKeys(value, ["path", "digest"]) &&
    value.path === "/workspace/input/brief.md" &&
    digestPattern.test(value.digest)
  );
}

function validContext(value) {
  return value === undefined || validContextThresholds(value);
}

function validInputs(value) {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (input) =>
        exactKeys(input, ["path", "byte_count", "digest"]) &&
        /^\/workspace\/input\/[a-z0-9][a-z0-9._-]*$/.test(input.path) &&
        Number.isSafeInteger(input.byte_count) &&
        input.byte_count >= 0 &&
        input.byte_count <= 32 * 1024 * 1024 &&
        digestPattern.test(input.digest),
    ) &&
    new Set(value.map((input) => input.path)).size === value.length &&
    value.reduce((total, input) => total + input.byte_count, 0) <=
      64 * 1024 * 1024
  );
}

function validPermissionAssignment(value) {
  if (
    !exactKeys(value, ["kind"], ["task", "lens"]) ||
    !["run", "design", "task", "review", "query"].includes(value.kind)
  ) {
    return false;
  }
  if (value.task !== undefined && !identifierPattern.test(value.task)) {
    return false;
  }
  if (
    value.lens !== undefined &&
    !["spec", "architecture", "quality", "quant"].includes(value.lens)
  ) {
    return false;
  }
  if (["task", "review"].includes(value.kind) && value.task === undefined) {
    return false;
  }
  if (!["task", "review"].includes(value.kind) && value.task !== undefined) {
    return false;
  }
  if (value.kind === "review") return value.lens !== undefined;
  return value.lens === undefined;
}

function validPermissionCeiling(value) {
  const required = [
    "version",
    "role",
    "assignment",
    "source",
    "write_lease",
    "pi_tools",
    "actions",
    "host_policy_digest",
    "local_policy_digest",
    "role_permissions_digest",
    "assignment_digest",
    "permission_ceiling_digest",
  ];
  const validShape =
    exactKeys(value, required) &&
    value.version === 2 &&
    identifierPattern.test(value.role) &&
    validPermissionAssignment(value.assignment) &&
    ["none", "read"].includes(value.source) &&
    ["never", "task"].includes(value.write_lease) &&
    Array.isArray(value.pi_tools) &&
    value.pi_tools.every((tool) => piTools.has(tool)) &&
    new Set(value.pi_tools).size === value.pi_tools.length &&
    Array.isArray(value.actions) &&
    value.actions.every((action) => orchestratorActions.has(action)) &&
    new Set(value.actions).size === value.actions.length &&
    required.slice(7).every((name) => digestPattern.test(value[name]));
  if (!validShape) return false;
  const mutatingTools = value.pi_tools.some((tool) =>
    ["write", "edit"].includes(tool),
  );
  return (
    (value.source === "read" || value.pi_tools.length === 0) &&
    (value.write_lease !== "task" ||
      (value.source === "read" && value.assignment.kind === "task")) &&
    (!mutatingTools || value.write_lease === "task") &&
    (!value.actions.includes("finish") || value.write_lease === "task")
  );
}

function parseConfig(value) {
  if (
    !exactKeys(
      value,
      [
        "version",
        "identity",
        "token",
        "listen",
        "client_version",
        "pi_version",
        "permission_ceiling",
      ],
      [
        "source_digest",
        "policy_digest",
        "profile",
        "context",
        "model",
        "brief",
        "inputs",
      ],
    ) ||
    value.version !== CLIENT_CONFIG_VERSION ||
    !validIdentity(value.identity) ||
    !tokenPattern.test(value.token) ||
    !exactKeys(value.listen, ["host", "port"]) ||
    value.listen.host !== "127.0.0.1" ||
    !Number.isSafeInteger(value.listen.port) ||
    value.listen.port < 1 ||
    value.listen.port > 65535 ||
    typeof value.client_version !== "string" ||
    value.client_version.length === 0 ||
    typeof value.pi_version !== "string" ||
    value.pi_version.length === 0 ||
    !validPermissionCeiling(value.permission_ceiling) ||
    (value.profile !== undefined &&
      !["read", "write"].includes(value.profile)) ||
    (value.profile === "write" &&
      (value.permission_ceiling.write_lease !== "task" ||
        value.permission_ceiling.assignment.kind !== "task")) ||
    !validContext(value.context) ||
    (value.source_digest !== undefined &&
      !digestPattern.test(value.source_digest)) ||
    (value.policy_digest !== undefined &&
      !digestPattern.test(value.policy_digest)) ||
    (value.model === undefined) !== (value.brief === undefined) ||
    (value.model !== undefined && !validModel(value.model)) ||
    (value.brief !== undefined && !validBrief(value.brief)) ||
    (value.inputs !== undefined && !validInputs(value.inputs))
  ) {
    throw new Error("Invalid Orchestrator client configuration");
  }
  return {
    ...value,
    context: value.context ?? DEFAULT_CONTEXT_THRESHOLDS,
  };
}

export async function readClientConfig(filePath) {
  return parseConfig(JSON.parse(await readFile(filePath, "utf8")));
}

function tokenMatches(actual, expected) {
  if (!tokenPattern.test(actual)) return false;
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function response(config, id, type, payload) {
  return {
    version: LINK_PROTOCOL_VERSION,
    id,
    identity: config.identity,
    type,
    payload,
  };
}

function writeFrame(socket, frame) {
  const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (encoded.length - 1 > MAX_LINK_FRAME_BYTES) {
    throw new Error("Response exceeds the Link frame limit");
  }
  socket.write(encoded);
}

function boundedRemember(map, key, value) {
  map.set(key, value);
  if (map.size <= 1024) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

export async function startLinkServer({ config: rawConfig, deliver }) {
  const config = parseConfig(rawConfig);
  if (typeof deliver !== "function")
    throw new Error("deliver callback is required");

  const seenFrames = new Map();
  const seenMessages = new Map();
  const sockets = new Set();
  const pendingEvents = [];
  let activeSocket;
  let operations = Promise.resolve();

  const eventFrame = (event, data) => {
    if (!clientEvents.has(event) || !plainObject(data)) {
      throw new Error("Invalid Orchestrator client event");
    }
    return response(config, `event-${randomUUID()}`, "event", {
      event,
      data,
    });
  };

  const emit = (event, data) => {
    const frame = eventFrame(event, data);
    if (activeSocket && !activeSocket.destroyed) {
      writeFrame(activeSocket, frame);
      return;
    }
    pendingEvents.push(frame);
    if (pendingEvents.length > 1_024) pendingEvents.shift();
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    let failed = false;

    const fail = (request, code, message) => {
      if (failed || socket.destroyed) return;
      failed = true;
      const replyTo =
        request && frameIdPattern.test(request.id) ? request.id : undefined;
      writeFrame(
        socket,
        response(config, `error-${randomUUID()}`, "error", {
          ...(replyTo ? { reply_to: replyTo } : {}),
          code,
          message,
        }),
      );
      socket.end();
    };

    const handle = async (frame, raw) => {
      if (!validFrame(frame)) {
        fail(frame, "invalid-frame", "Frame violates the Link protocol");
        return;
      }
      if (!sameIdentity(frame.identity, config.identity)) {
        fail(
          frame,
          "stale-generation",
          "Frame targets another Session identity or generation",
        );
        return;
      }

      if (!authenticated) {
        if (
          frame.type !== "hello" ||
          !exactKeys(frame.payload, ["token"]) ||
          !tokenMatches(frame.payload.token, config.token)
        ) {
          fail(frame, "unauthorized", "Link authentication failed");
          return;
        }
        authenticated = true;
        const previous = activeSocket;
        activeSocket = socket;
        if (previous && previous !== socket) previous.destroy();
        writeFrame(
          socket,
          response(config, `ready-${frame.id.slice(0, 100)}`, "ready", {
            reply_to: frame.id,
            client_version: config.client_version,
            pi_version: config.pi_version,
            capabilities: ["deliver", "events", "ping"],
          }),
        );
        for (const event of pendingEvents.splice(0)) writeFrame(socket, event);
        return;
      }

      const priorFrame = seenFrames.get(frame.id);
      if (priorFrame !== undefined && priorFrame !== raw) {
        fail(
          frame,
          "duplicate-frame",
          "Frame ID was reused with other content",
        );
        return;
      }
      boundedRemember(seenFrames, frame.id, raw);

      if (frame.type === "ping" && exactKeys(frame.payload, ["nonce"])) {
        if (
          typeof frame.payload.nonce !== "string" ||
          frame.payload.nonce.length > 128
        ) {
          fail(frame, "invalid-frame", "Ping nonce is invalid");
          return;
        }
        writeFrame(
          socket,
          response(config, `pong-${frame.id.slice(0, 101)}`, "pong", {
            reply_to: frame.id,
            nonce: frame.payload.nonce,
          }),
        );
        return;
      }

      if (frame.type === "deliver" && exactKeys(frame.payload, ["message"])) {
        const message = frame.payload.message;
        if (!validMessage(message, config.identity)) {
          fail(
            frame,
            "invalid-message",
            "Message does not target the active Session",
          );
          return;
        }
        const canonical = JSON.stringify(message);
        const priorMessage = seenMessages.get(message.id);
        if (priorMessage !== undefined && priorMessage !== canonical) {
          fail(
            frame,
            "duplicate-message",
            "Message ID was reused with other content",
          );
          return;
        }
        if (priorMessage === undefined) {
          await deliver(message);
          boundedRemember(seenMessages, message.id, canonical);
        }
        writeFrame(
          socket,
          response(config, `ack-${frame.id.slice(0, 102)}`, "ack", {
            reply_to: frame.id,
            message_id: message.id,
            status: priorMessage === undefined ? "queued" : "duplicate",
          }),
        );
        return;
      }

      fail(frame, "invalid-frame", `Unsupported '${frame.type}' frame`);
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const delimiter = buffer.indexOf(0x0a);
        if (delimiter < 0) {
          if (buffer.length > MAX_LINK_FRAME_BYTES) {
            fail(
              undefined,
              "frame-too-large",
              "Link frame exceeds 65536 bytes",
            );
          }
          return;
        }
        if (
          delimiter === 0 ||
          delimiter > MAX_LINK_FRAME_BYTES ||
          buffer[delimiter - 1] === 0x0d
        ) {
          fail(undefined, "invalid-frame", "Link framing is invalid");
          return;
        }
        let record;
        try {
          record = new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, delimiter),
          );
        } catch {
          fail(undefined, "invalid-utf8", "Link record is not valid UTF-8");
          return;
        }
        buffer = buffer.subarray(delimiter + 1);
        let frame;
        try {
          frame = JSON.parse(record);
        } catch {
          fail(undefined, "invalid-json", "Link record is not valid JSON");
          return;
        }
        operations = operations
          .then(() => handle(frame, record))
          .catch((error) => {
            fail(
              frame,
              "delivery-failed",
              error instanceof Error ? error.message : String(error),
            );
          });
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (activeSocket === socket) activeSocket = undefined;
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    host: config.listen.host,
    port: config.listen.port,
    emit,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
