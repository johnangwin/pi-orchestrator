#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { approvalFreshness, createApproval } from "./approval.js";
import { runCanary } from "./canary.js";
import { runRequiredChecks } from "./check.js";
import {
  commitTask,
  inspectTaskCommit,
  readGitIdentity,
  type CommitProposal,
} from "./commit.js";
import { runPlanningConsultations } from "./consultation.js";
import { IdentifierSchema, type ReviewLens } from "./config.js";
import type { Digest } from "./digest.js";
import { catalogFromConfig, loadPlan } from "./plan.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { createExampleProject } from "./example.js";
import { initializeProject } from "./init.js";
import { runImplementation } from "./implementation.js";
import {
  loadLocalConfig,
  resolveMachinePath,
  type LocalConfig,
} from "./local.js";
import { OpenShellClient } from "./openshell.js";
import {
  answerPlanningQuestionnaire,
  PlanningStore,
  runPlanningQuestionnaire,
  type PlanningQuestion,
  type PlanningQuestionnaire,
} from "./planning.js";
import { SandboxProfileSchema, type SandboxProfile } from "./policy.js";
import { runWorkspaceVolumeCanary } from "./proof.js";
import { gitHead, loadProject, resolvePlanDirectory } from "./project.js";
import { resolveReviewModelRoute, resolveRoleModelRoute } from "./model.js";
import { runRequiredReviews } from "./review.js";
import { startRun } from "./run.js";
import { defaultOrchestratorHome, ProjectStore } from "./state.js";
import {
  collectRunMetrics,
  formatRunMetrics,
  RunReportStore,
} from "./summary.js";
import { runPlanSynthesis } from "./synthesis.js";

interface CommonOptions {
  readonly project?: string;
  readonly json?: boolean;
}

interface ApproveOptions extends CommonOptions {
  readonly yes?: boolean;
  readonly home?: string;
}

interface OpenShellOptions {
  readonly config?: string;
  readonly gateway?: string;
  readonly openshell?: string;
  readonly requireVersion?: string;
  readonly workspace?: string;
}

interface DoctorOptions extends OpenShellOptions {
  readonly json?: boolean;
}

interface CanaryCliOptions extends OpenShellOptions {
  readonly workspaceVolume?: boolean;
  readonly image?: string;
  readonly json?: boolean;
  readonly policies?: string;
  readonly profile?: string[];
}

interface StartOptions extends CommonOptions {
  readonly config?: string;
  readonly home?: string;
  readonly run?: string;
  readonly worktreeRoot?: string;
}

interface CommitOptions extends CommonOptions {
  readonly config?: string;
  readonly home?: string;
  readonly run?: string;
  readonly subject?: string;
  readonly yes?: boolean;
}

interface ReviewOptions extends CommonOptions {
  readonly config?: string;
  readonly home?: string;
  readonly run?: string;
}

interface TaskExecutionOptions extends CommonOptions {
  readonly config?: string;
  readonly home?: string;
  readonly run?: string;
}

interface PlanOptions extends CommonOptions {
  readonly config?: string;
  readonly home?: string;
  readonly id?: string;
}

interface AnswerOptions extends CommonOptions {
  readonly answers?: string;
  readonly home?: string;
}

interface ConsultOptions extends CommonOptions {
  readonly config?: string;
  readonly home?: string;
}

interface DraftOptions extends CommonOptions {
  readonly config?: string;
  readonly home?: string;
}

interface RunOutputOptions extends CommonOptions {
  readonly home?: string;
}

interface ExampleOptions {
  readonly config?: string;
  readonly json?: boolean;
}

async function optionalLocalConfig(
  filePath: string,
  required: boolean,
): Promise<LocalConfig | undefined> {
  try {
    return await loadLocalConfig(filePath);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function configuredOpenShell(options: OpenShellOptions): Promise<{
  readonly client: OpenShellClient;
  readonly configPath: string;
  readonly local: LocalConfig | undefined;
  readonly requiredVersion: string | undefined;
}> {
  const configPath = path.resolve(
    options.config ?? ".pi/orchestrator.local.yaml",
  );
  const local = await optionalLocalConfig(
    configPath,
    options.config !== undefined,
  );
  const command = options.openshell ?? local?.openshell.command;
  const workspace = options.workspace ?? local?.openshell.workspace;
  const requiredVersion =
    options.requireVersion ?? local?.openshell.required_version;
  const client = new OpenShellClient({
    ...(command ? { command } : {}),
    ...(options.gateway ? { gateway: options.gateway } : {}),
    ...(workspace ? { workspace } : {}),
    ...(requiredVersion ? { requiredVersion } : {}),
  });
  return { client, configPath, local, requiredVersion };
}

async function confirmation(
  question: string,
  yes: boolean | undefined,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new OrchestratorError(
      "confirmation_required",
      "Human confirmation requires a TTY or explicit --yes",
    );
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await input.question(`${question} [y/N] `);
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      throw new OrchestratorError("cancelled", "Approval cancelled");
    }
  } finally {
    input.close();
  }
}

async function validatedPlan(value: string, options: CommonOptions) {
  const project = await loadProject(options.project ?? process.cwd());
  const plan = await loadPlan(
    resolvePlanDirectory(project.root, value),
    catalogFromConfig(project.config),
  );
  return { project, plan };
}

async function resolveTaskRun(
  store: ProjectStore,
  taskId: string,
  requestedRun?: string,
) {
  if (requestedRun) {
    const run = await store.readRun(IdentifierSchema.parse(requestedRun));
    if (!run.tasks[taskId]) {
      throw new OrchestratorError(
        "task_not_found",
        `Run '${run.id}' does not contain Task '${taskId}'`,
      );
    }
    return run;
  }

  const project = await store.read();
  const matches = [];
  for (const runId of Object.keys(project.runs).sort()) {
    const run = await store.readRun(runId);
    if (run.tasks[taskId]) matches.push(run);
  }
  if (matches.length === 0) {
    throw new OrchestratorError(
      "run_not_found",
      `No durable Run contains Task '${taskId}'`,
    );
  }
  if (matches.length > 1) {
    throw new OrchestratorError(
      "run_ambiguous",
      `Task '${taskId}' exists in multiple Runs; select one with --run`,
    );
  }
  return matches[0]!;
}

function formatCommitProposal(proposal: CommitProposal): string {
  return [
    `Task: ${proposal.task} (${proposal.title})`,
    `Plan: ${proposal.plan.id} r${proposal.plan.revision} (${proposal.plan.digest})`,
    `Branch: ${proposal.branch}`,
    `Input commit: ${proposal.input_commit}`,
    `Source digest: ${proposal.task_source_digest}`,
    `Diff digest: ${proposal.diff_digest}`,
    `Changes: ${proposal.changes.map((change) => `${change.status} ${change.path}`).join(", ")}`,
    `Checks: ${proposal.checks.map((check) => `${check.check}=PASS`).join(", ")}`,
    `Reviews: ${proposal.reviews.map((review) => `${review.lens}=PASS`).join(", ")}`,
    `Subject: ${proposal.subject}`,
    `Author: ${proposal.author.name} <${proposal.author.email}>`,
  ].join("\n");
}

function printQuestionnaire(
  planningId: string,
  status: string,
  questionnaire: PlanningQuestionnaire,
): void {
  console.log(`Planning: ${planningId}`);
  console.log(`Status: ${status}`);
  console.log(`Repository: ${questionnaire.repository.summary}`);
  if (questionnaire.questions.length === 0) {
    console.log("Questions: none");
    return;
  }
  console.log(`Questions: ${questionnaire.questions.length}`);
  questionnaire.questions.forEach((question, index) => {
    console.log(`\n${index + 1}. ${question.question}`);
    console.log(`   Why: ${question.why}`);
    for (const option of question.options) {
      const recommended =
        option.id === question.recommendation ? " (recommended)" : "";
      console.log(
        `   ${option.id}: ${option.label}${recommended} - ${option.tradeoff}`,
      );
    }
    console.log("   Free-form input is accepted.");
  });
}

async function answerFile(filePath: string): Promise<Record<string, string>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new OrchestratorError(
      "invalid_planning_answers",
      `Cannot parse planning answers from ${path.resolve(filePath)}`,
      { cause: error },
    );
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new OrchestratorError(
      "invalid_planning_answers",
      "Planning answers must be a JSON object keyed by question ID",
    );
  }
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(value)) {
    IdentifierSchema.parse(question);
    if (typeof answer !== "string") {
      throw new OrchestratorError(
        "invalid_planning_answers",
        `Answer '${question}' must be a string`,
      );
    }
    answers[question] = answer;
  }
  return answers;
}

function printQuestion(question: PlanningQuestion, index: number): void {
  console.log(`\n${index + 1}. ${question.question}`);
  console.log(`Why: ${question.why}`);
  question.options.forEach((option, optionIndex) => {
    const recommended =
      option.id === question.recommendation ? " (recommended)" : "";
    console.log(
      `  ${optionIndex + 1}. ${option.label}${recommended}\n     ${option.tradeoff}`,
    );
  });
}

async function interactiveAnswers(
  questionnaire: PlanningQuestionnaire,
): Promise<Record<string, string>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new OrchestratorError(
      "answers_required",
      "Human answers require a TTY or an explicit --answers JSON file",
    );
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answers: Record<string, string> = {};
  try {
    for (const [index, question] of questionnaire.questions.entries()) {
      printQuestion(question, index);
      const raw = await input.question(
        `Answer [${question.recommendation}; option number/ID or free-form]: `,
      );
      const selected = raw.trim() || question.recommendation;
      const numeric = /^\d+$/.test(selected) ? Number(selected) : undefined;
      const option =
        numeric !== undefined
          ? question.options[numeric - 1]
          : question.options.find((candidate) => candidate.id === selected);
      answers[question.id] = option?.id ?? selected;
    }
  } finally {
    input.close();
  }
  return answers;
}

const program = new Command()
  .name("orchestrator")
  .description("Host control plane for isolated Pi development runs")
  .version("0.2.0");

program
  .command("doctor")
  .description("verify the pinned OpenShell CLI and local gateway")
  .option("--config <path>", "machine-local configuration path")
  .option("--openshell <path>", "OpenShell executable")
  .option("--gateway <name>", "OpenShell gateway")
  .option("--workspace <name>", "OpenShell workspace")
  .option("--require-version <version>", "required OpenShell version")
  .option("--json", "emit JSON")
  .action(async (options: DoctorOptions) => {
    const { client, configPath, local, requiredVersion } =
      await configuredOpenShell(options);
    const result = await client.preflight();
    const output = {
      ...result,
      config: local ? configPath : null,
      pinned: requiredVersion !== undefined,
    };
    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`OpenShell CLI: ${result.installedVersion}`);
    console.log(
      `Version pin: ${requiredVersion ?? "missing; set openshell.required_version in .pi/orchestrator.local.yaml"}`,
    );
    console.log(`Gateway: ${result.status.gateway} (${result.status.server})`);
    console.log(
      `Gateway status: ${result.status.status}, ${result.status.authentication.status}`,
    );
  });

program
  .command("canary")
  .description("verify OpenShell Sandbox isolation with disposable profiles")
  .option("--config <path>", "machine-local configuration path")
  .option("--openshell <path>", "OpenShell executable")
  .option("--gateway <name>", "OpenShell gateway")
  .option("--workspace <name>", "OpenShell workspace")
  .option("--require-version <version>", "required OpenShell version")
  .option("--image <source>", "probe image path or registry reference")
  .option("--policies <directory>", "Sandbox policy directory")
  .option("--profile <profile...>", "profiles to verify: read, write, check")
  .option(
    "--workspace-volume",
    "run the shared Workspace volume proof instead of base profiles",
  )
  .option("--json", "emit JSON")
  .action(async (options: CanaryCliOptions) => {
    const configured = await configuredOpenShell(options);
    const { requiredVersion } = configured;
    if (requiredVersion === undefined) {
      throw new OrchestratorError(
        "openshell_version_unpinned",
        "OpenShell canaries require openshell.required_version or --require-version",
      );
    }
    const profiles: SandboxProfile[] | undefined = options.profile?.map(
      (profile) => SandboxProfileSchema.parse(profile),
    );
    const image =
      options.image &&
      (path.isAbsolute(options.image) || options.image.startsWith("."))
        ? path.resolve(options.image)
        : options.image;
    if (options.workspaceVolume) {
      if (options.profile !== undefined) {
        throw new OrchestratorError(
          "invalid_canary_profiles",
          "--profile cannot be combined with --workspace-volume",
        );
      }
      const settings = configured.local?.openshell.shared_workspace;
      if (!settings) {
        throw new OrchestratorError(
          "shared_workspace_disabled",
          "The Workspace-volume canary requires openshell.shared_workspace in machine-local configuration",
        );
      }
      const gateway = options.gateway ?? settings.gateway;
      const client = new OpenShellClient({
        command: options.openshell ?? configured.local?.openshell.command,
        ...(gateway ? { gateway } : {}),
        workspace:
          options.workspace ??
          configured.local?.openshell.workspace ??
          "default",
        requiredVersion,
      });
      const result = await runWorkspaceVolumeCanary({
        client,
        settings,
        ...(image ? { image } : {}),
        ...(options.policies
          ? { policyDirectory: path.resolve(options.policies) }
          : {}),
        projectRoot: process.cwd(),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `OpenShell Workspace-volume canary: ${result.passed ? "PASS" : "FAIL"}`,
        );
        console.log(
          `  ${result.openshell.gateway}: OpenShell ${result.openshell.gatewayVersion}, ${result.openshell.driver} ${result.openshell.driverVersion}`,
        );
        console.log(`  Evidence: ${result.evidenceDigest}`);
        for (const assertion of result.assertions) {
          if (!assertion.passed) {
            console.log(`  ${assertion.id}: ${assertion.detail}`);
          }
        }
      }
      if (!result.passed) process.exitCode = 1;
      return;
    }
    const result = await runCanary({
      client: configured.client,
      ...(image ? { image } : {}),
      ...(options.policies
        ? { policyDirectory: path.resolve(options.policies) }
        : {}),
      ...(profiles ? { profiles } : {}),
      projectRoot: process.cwd(),
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`OpenShell canary: ${result.passed ? "PASS" : "FAIL"}`);
      for (const profile of result.profiles) {
        const passed = profile.assertions.filter(
          (assertion) => assertion.passed,
        ).length;
        console.log(
          `  ${profile.profile}: ${profile.passed ? "PASS" : "FAIL"} (${passed}/${profile.assertions.length})`,
        );
        for (const assertion of profile.assertions) {
          if (!assertion.passed) {
            console.log(`    ${assertion.id}: ${assertion.detail}`);
          }
        }
      }
    }
    if (!result.passed) process.exitCode = 1;
  });

program
  .command("example")
  .description("create a standalone first-run price calculator Project")
  .argument(
    "[directory]",
    "new standalone Project directory",
    "./pi-orchestrator-first-run",
  )
  .option("--config <path>", "copy an existing machine-local configuration")
  .option("--json", "emit JSON")
  .action(async (directory: string, options: ExampleOptions) => {
    const result = await createExampleProject({
      directory,
      ...(options.config ? { localConfig: options.config } : {}),
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Created first-run Project at ${result.root}`);
    console.log(`  Plan: ${result.planId}`);
    console.log(`  Task: ${result.taskId}`);
    if (result.localConfig === "example") {
      console.log(
        "  Configure .pi/orchestrator.local.yaml with your OpenShell gateways and models.",
      );
    }
    console.log(`Next: cd ${result.root}`);
  });

program
  .command("init")
  .argument("[directory]", "consumer Project directory", ".")
  .option("--project-id <id>", "stable Project identifier")
  .action(async (directory: string, options: { projectId?: string }) => {
    const result = await initializeProject(directory, options.projectId);
    console.log(`Initialized ${result.root}`);
    for (const file of result.created) console.log(`  created ${file}`);
  });

program
  .command("plan")
  .description(
    "inspect the exact repository in an isolated Session and draft a questionnaire",
  )
  .argument("<goal>", "change goal")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--id <id>", "stable planning identifier")
  .option("--json", "emit JSON")
  .action(async (goal: string, options: PlanOptions) => {
    const project = await loadProject(options.project ?? process.cwd());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await loadLocalConfig(configPath);
    const role = project.roles.get("lead");
    if (!role) {
      throw new OrchestratorError(
        "planning_role_not_found",
        "Repository-aware planning requires the 'lead' Role",
      );
    }
    const model = resolveRoleModelRoute(
      project.config,
      local,
      role.definition.name,
      role.definition.inference,
    );
    const client = new OpenShellClient({
      command: local.openshell.command,
      gateway: model.gateway,
      workspace: local.openshell.workspace,
      ...(local.openshell.required_version
        ? { requiredVersion: local.openshell.required_version }
        : {}),
    });
    const store = await ProjectStore.open({
      home: path.resolve(options.home ?? defaultOrchestratorHome()),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const result = await runPlanningQuestionnaire({
        store,
        project,
        local,
        client,
        goal,
        ...(options.id ? { planningId: options.id } : {}),
      });
      const output = {
        id: result.state.id,
        status: result.state.status,
        goal: result.state.goal,
        base_commit: result.state.base_commit,
        source_digest: result.state.source_digest,
        source_entries: result.state.source_entries,
        attempt: result.request.attempt,
        request_digest: result.request.request_digest,
        questionnaire_digest: result.record.record_digest,
        questionnaire: result.record.questionnaire,
        reused: result.reused,
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        printQuestionnaire(
          result.state.id,
          result.state.status,
          result.record.questionnaire,
        );
        if (result.state.status === "awaiting-answers") {
          console.log(
            `\nRecord answers with: orchestrator answer ${result.state.id}`,
          );
        }
      }
    } finally {
      await store.close();
    }
  });

program
  .command("answer")
  .description("record human answers to a durable planning questionnaire")
  .argument("<planning>", "planning identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--answers <path>", "JSON object keyed by question ID")
  .option("--json", "emit JSON")
  .action(async (planningId: string, options: AnswerOptions) => {
    const project = await loadProject(options.project ?? process.cwd());
    const store = await ProjectStore.open({
      home: path.resolve(options.home ?? defaultOrchestratorHome()),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const planning = new PlanningStore(store);
      const state = await planning.get(planningId);
      const questionnaire = (await planning.currentQuestionnaire(state.id))
        .record;
      if (options.json && !options.answers) {
        throw new OrchestratorError(
          "answers_required",
          "JSON answer output requires an explicit --answers JSON file",
        );
      }
      const answers = options.answers
        ? await answerFile(options.answers)
        : await interactiveAnswers(questionnaire.questionnaire);
      const result = await answerPlanningQuestionnaire({
        store,
        project,
        planningId: state.id,
        answers,
        acceptedBy: os.userInfo().username,
      });
      const output = {
        id: result.state.id,
        status: result.state.status,
        questionnaire_digest: result.state.questionnaire_digest,
        decisions: result.decisions.map((record) => ({
          ...record.decision,
          question: record.answer.question,
          answer: record.answer,
          record_digest: record.record_digest,
        })),
        reused: result.reused,
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(
          `${result.reused ? "Reused" : "Recorded"} ${result.decisions.length} Decision${result.decisions.length === 1 ? "" : "s"} for ${result.state.id}`,
        );
      }
    } finally {
      await store.close();
    }
  });

program
  .command("consult")
  .description("run independent Architecture and Quant planning consultations")
  .argument("<planning>", "planning identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--json", "emit JSON")
  .action(async (planningId: string, options: ConsultOptions) => {
    const project = await loadProject(options.project ?? process.cwd());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await loadLocalConfig(configPath);
    const clients = Object.fromEntries(
      (["architecture", "quant"] as const).map((consultationRole) => {
        const roleName =
          consultationRole === "architecture" ? "architect" : "quant";
        const role = project.roles.get(roleName);
        if (!role) {
          throw new OrchestratorError(
            "consultation_role_not_found",
            `Planning consultation requires the '${roleName}' Role`,
          );
        }
        const model = resolveRoleModelRoute(
          project.config,
          local,
          role.definition.name,
          role.definition.inference,
        );
        return [
          consultationRole,
          new OpenShellClient({
            command: local.openshell.command,
            gateway: model.gateway,
            workspace: local.openshell.workspace,
            ...(local.openshell.required_version
              ? { requiredVersion: local.openshell.required_version }
              : {}),
          }),
        ];
      }),
    ) as {
      architecture: OpenShellClient;
      quant: OpenShellClient;
    };
    const store = await ProjectStore.open({
      home: path.resolve(options.home ?? defaultOrchestratorHome()),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const result = await runPlanningConsultations({
        store,
        project,
        local,
        clients,
        planningId,
      });
      const output = {
        id: result.state.id,
        status: result.state.status,
        consultations: result.consultations.map((consultation) => ({
          role: consultation.role,
          attempt: consultation.request.attempt,
          request_digest: consultation.request.request_digest,
          record_digest: consultation.record.record_digest,
          report_digest: consultation.record.report.content_digest,
          report: consultation.record.report.content,
          output: consultation.record.output,
          reused: consultation.reused,
        })),
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Planning ${result.state.id}: ${result.state.status}`);
        for (const consultation of result.consultations) {
          console.log(
            `  ${consultation.role}: ${consultation.reused ? "reused" : "recorded"} attempt ${consultation.request.attempt} (${consultation.record.report.content_digest})`,
          );
        }
      }
    } finally {
      await store.close();
    }
  });

program
  .command("draft")
  .description(
    "critique planning evidence and synthesize a validated Plan draft",
  )
  .argument("<planning>", "planning identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--json", "emit JSON")
  .action(async (planningId: string, options: DraftOptions) => {
    const project = await loadProject(options.project ?? process.cwd());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await loadLocalConfig(configPath);
    const clients = Object.fromEntries(
      (
        [
          ["critic", "reviewer"],
          ["lead", "lead"],
        ] as const
      ).map(([stage, roleName]) => {
        const role = project.roles.get(roleName);
        if (!role) {
          throw new OrchestratorError(
            "planning_stage_role_not_found",
            `Plan drafting requires the '${roleName}' Role`,
          );
        }
        const model = resolveRoleModelRoute(
          project.config,
          local,
          role.definition.name,
          role.definition.inference,
        );
        return [
          stage,
          new OpenShellClient({
            command: local.openshell.command,
            gateway: model.gateway,
            workspace: local.openshell.workspace,
            ...(local.openshell.required_version
              ? { requiredVersion: local.openshell.required_version }
              : {}),
          }),
        ];
      }),
    ) as {
      critic: OpenShellClient;
      lead: OpenShellClient;
    };
    const store = await ProjectStore.open({
      home: path.resolve(options.home ?? defaultOrchestratorHome()),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const result = await runPlanSynthesis({
        store,
        project,
        local,
        clients,
        planningId,
      });
      const output = {
        id: result.state.id,
        status: result.state.status,
        critique: {
          attempt: result.critique.request.attempt,
          request_digest: result.critique.request.request_digest,
          record_digest: result.critique.record.record_digest,
          report_digest: result.critique.record.report.content_digest,
          verdict: result.critique.record.output.verdict,
          output: result.critique.record.output,
          reused: result.critique.reused,
        },
        synthesis: {
          attempt: result.synthesis.request.attempt,
          request_digest: result.synthesis.request.request_digest,
          record_digest: result.synthesis.record.record_digest,
          report_digest: result.synthesis.record.report.content_digest,
          plan_digest: result.synthesis.plan.digest,
          directory: result.synthesis.directory,
          plan: {
            id: result.synthesis.plan.id,
            revision: result.synthesis.plan.revision,
            markdown: result.synthesis.plan.markdown,
            tasks_yaml: result.synthesis.plan.tasksYaml,
            tasks: result.synthesis.plan.tasks,
          },
          reused: result.synthesis.reused,
        },
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Planning ${result.state.id}: ${result.state.status}`);
        console.log(
          `  critic: ${result.critique.reused ? "reused" : "recorded"} attempt ${result.critique.request.attempt} (${result.critique.record.output.verdict})`,
        );
        console.log(
          `  plan: ${result.synthesis.reused ? "reused" : "drafted"} ${result.synthesis.plan.id} r${result.synthesis.plan.revision} (${result.synthesis.plan.digest})`,
        );
        console.log(`  directory: ${result.synthesis.directory}`);
      }
    } finally {
      await store.close();
    }
  });

program
  .command("validate")
  .description("validate a Plan without approving it")
  .argument("<plan>", "Plan ID or directory")
  .option("--project <path>", "consumer Project path")
  .option("--json", "emit JSON")
  .action(async (value: string, options: CommonOptions) => {
    const { plan } = await validatedPlan(value, options);
    const result = {
      id: plan.id,
      revision: plan.revision,
      digest: plan.digest,
      tasks: plan.tasks.map((task) => task.id),
    };
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : `Plan ${plan.id} r${plan.revision} is valid (${plan.digest})`,
    );
  });

program
  .command("approve")
  .description("record human approval for an exact Plan and base commit")
  .argument("<plan>", "Plan ID or directory")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--yes", "confirm the displayed approval non-interactively")
  .action(async (value: string, options: ApproveOptions) => {
    const { project, plan } = await validatedPlan(value, options);
    const baseCommit = await gitHead(project.root);
    await confirmation(
      `Approve Plan ${plan.id} revision ${plan.revision} at ${baseCommit}\nDigest ${plan.digest}?`,
      options.yes,
    );

    const approval = createApproval({
      plan,
      baseCommit,
      approvedBy: os.userInfo().username,
    });
    const store = await ProjectStore.open({
      home: options.home ? options.home : defaultOrchestratorHome(),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      await store.recordApproval(approval);
    } finally {
      await store.close();
    }
    console.log(`Approved ${plan.id} r${plan.revision} (${plan.digest})`);
  });

program
  .command("start")
  .description("create an approved Run and isolated host worktree")
  .argument("<plan>", "Plan ID or directory")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--run <id>", "stable Run identifier")
  .option("--worktree-root <path>", "host Run worktree root")
  .option("--json", "emit JSON")
  .action(async (value: string, options: StartOptions) => {
    const { project, plan } = await validatedPlan(value, options);
    const home = path.resolve(options.home ?? defaultOrchestratorHome());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await optionalLocalConfig(
      configPath,
      options.config !== undefined,
    );
    const worktreeRoot = options.worktreeRoot
      ? resolveMachinePath(options.worktreeRoot)
      : local
        ? resolveMachinePath(local.worktrees.root, os.homedir(), project.root)
        : path.join(home, "worktrees");
    const store = await ProjectStore.open({
      home,
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const result = await startRun({
        store,
        project,
        plan,
        worktreeRoot,
        ...(options.run ? { runId: options.run } : {}),
      });
      const output = {
        id: result.run.id,
        plan: result.run.plan_id,
        revision: result.run.plan_revision,
        status: result.run.status,
        base_commit: result.run.base_commit,
        branch: result.run.branch,
        worktree: result.run.worktree,
        created: result.created,
        recovered: result.worktree.recovered,
      };
      console.log(
        options.json
          ? JSON.stringify(output, null, 2)
          : `${result.created ? "Started" : "Recovered"} Run ${result.run.id} at ${result.run.worktree}`,
      );
    } finally {
      await store.close();
    }
  });

program
  .command("implement")
  .description("run one isolated implementation Session and import its Patch")
  .argument("<task>", "Task identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--run <id>", "Run identifier when the Task is ambiguous")
  .option("--json", "emit JSON")
  .action(async (value: string, options: TaskExecutionOptions) => {
    const taskId = IdentifierSchema.parse(value);
    const project = await loadProject(options.project ?? process.cwd());
    const home = path.resolve(options.home ?? defaultOrchestratorHome());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await loadLocalConfig(configPath);
    const store = await ProjectStore.open({
      home,
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const run = await resolveTaskRun(store, taskId, options.run);
      const plan = await loadPlan(
        resolvePlanDirectory(project.root, run.plan_id),
        catalogFromConfig(project.config),
      );
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      if (!task) {
        throw new OrchestratorError(
          "task_not_found",
          `Plan '${plan.id}' has no Task '${taskId}'`,
        );
      }
      const role = project.roles.get(task.role);
      if (!role) {
        throw new OrchestratorError(
          "role_not_found",
          `Task '${taskId}' Role '${task.role}' is unavailable`,
        );
      }
      const model = resolveRoleModelRoute(
        project.config,
        local,
        task.role,
        role.definition.inference,
      );
      const client = new OpenShellClient({
        command: local.openshell.command,
        gateway: model.gateway,
        workspace: local.openshell.workspace,
        ...(local.openshell.required_version
          ? { requiredVersion: local.openshell.required_version }
          : {}),
      });
      const result = await runImplementation({
        store,
        project,
        plan,
        runId: run.id,
        taskId,
        local,
        client,
      });
      const output = {
        run: run.id,
        task: taskId,
        task_status: result.task.status,
        reused: result.reused,
        changed_paths: result.application.changed_paths,
        source_digest: result.application.source_digest,
        diff_digest: result.application.host_diff_digest,
        report: result.report.id,
        session: result.identity.session,
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(
          `Task ${taskId} implementation: ${result.reused ? "reused" : "applied"}`,
        );
        for (const changedPath of result.application.changed_paths) {
          console.log(`  ${changedPath}`);
        }
        console.log(`Next: orchestrator check ${taskId}`);
      }
    } finally {
      await store.close();
    }
  });

program
  .command("check")
  .description("run every required Check in a fresh no-inference Sandbox")
  .argument("<task>", "Task identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--run <id>", "Run identifier when the Task is ambiguous")
  .option("--json", "emit JSON")
  .action(async (value: string, options: TaskExecutionOptions) => {
    const taskId = IdentifierSchema.parse(value);
    const project = await loadProject(options.project ?? process.cwd());
    const home = path.resolve(options.home ?? defaultOrchestratorHome());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await loadLocalConfig(configPath);
    const store = await ProjectStore.open({
      home,
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const run = await resolveTaskRun(store, taskId, options.run);
      const plan = await loadPlan(
        resolvePlanDirectory(project.root, run.plan_id),
        catalogFromConfig(project.config),
      );
      const client = new OpenShellClient({
        command: local.openshell.command,
        workspace: local.openshell.workspace,
        ...(local.openshell.required_version
          ? { requiredVersion: local.openshell.required_version }
          : {}),
      });
      const result = await runRequiredChecks({
        store,
        project,
        plan,
        runId: run.id,
        taskId,
        client,
      });
      const output = {
        run: run.id,
        task: taskId,
        task_status: result.task.status,
        verdict: result.verdict,
        required: result.required,
        checks: result.checks.map((check) => ({
          id: check.record.check,
          verdict: check.record.verdict,
          exit_code: check.record.exit_code,
          record_digest: check.record.record_digest,
          reused: check.reused,
        })),
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Task ${taskId} Checks: ${result.verdict.toUpperCase()}`);
        for (const check of output.checks) {
          console.log(
            `  ${check.id}: ${check.verdict.toUpperCase()} (${check.reused ? "reused" : "recorded"})`,
          );
        }
        if (result.verdict === "pass") {
          console.log(`Next: orchestrator review ${taskId}`);
        }
      }
      if (result.verdict === "fail") process.exitCode = 1;
    } finally {
      await store.close();
    }
  });

program
  .command("review")
  .description("run every required Review Lens for a checked Task")
  .argument("<task>", "Task identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--run <id>", "Run identifier when the Task is ambiguous")
  .option("--json", "emit JSON")
  .action(async (value: string, options: ReviewOptions) => {
    const taskId = IdentifierSchema.parse(value);
    const project = await loadProject(options.project ?? process.cwd());
    const home = path.resolve(options.home ?? defaultOrchestratorHome());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await loadLocalConfig(configPath);
    const role = project.roles.get("reviewer");
    if (!role) {
      throw new OrchestratorError(
        "reviewer_role_not_found",
        "Required Review orchestration needs the 'reviewer' Role",
      );
    }
    const store = await ProjectStore.open({
      home,
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const run = await resolveTaskRun(store, taskId, options.run);
      const plan = await loadPlan(
        resolvePlanDirectory(project.root, run.plan_id),
        catalogFromConfig(project.config),
      );
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      if (!task) {
        throw new OrchestratorError(
          "task_not_found",
          `Plan '${plan.id}' has no Task '${taskId}'`,
        );
      }
      const clients = Object.fromEntries(
        task.reviews.map((lens) => {
          const model = resolveReviewModelRoute(
            project.config,
            local,
            lens,
            role.definition.inference,
          );
          return [
            lens,
            new OpenShellClient({
              command: local.openshell.command,
              gateway: model.gateway,
              workspace: local.openshell.workspace,
              ...(local.openshell.required_version
                ? { requiredVersion: local.openshell.required_version }
                : {}),
            }),
          ];
        }),
      ) as Partial<Record<ReviewLens, OpenShellClient>>;
      const result = await runRequiredReviews({
        store,
        project,
        plan,
        runId: run.id,
        taskId,
        local,
        clients,
      });
      const output = {
        run: run.id,
        task: taskId,
        task_status: result.task.status,
        verdict: result.verdict,
        required: result.required,
        reviews: result.reviews.map((review) => ({
          lens: review.record.lens,
          verdict: review.record.verdict,
          round: review.record.round,
          record_digest: review.record.record_digest,
          report_digest: review.record.report.content_digest,
          session: review.record.identity.session,
          reused: review.reused,
        })),
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Task ${taskId} Reviews: ${result.verdict}`);
        for (const review of output.reviews) {
          console.log(
            `  ${review.lens}: ${review.verdict} (${review.reused ? "reused" : "recorded"}, round ${review.round})`,
          );
        }
        if (result.reviews.length < result.required.length) {
          console.log(
            `  remaining: ${result.required.slice(result.reviews.length).join(", ")}`,
          );
        }
      }
    } finally {
      await store.close();
    }
  });

program
  .command("commit")
  .description("create a human-authorized commit for an exactly verified Task")
  .argument("<task>", "Task identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--config <path>", "machine-local configuration path")
  .option("--run <id>", "Run identifier when the Task is ambiguous")
  .option("--subject <subject>", "one-line commit subject")
  .option("--yes", "confirm the displayed commit non-interactively")
  .option("--json", "emit JSON")
  .action(async (value: string, options: CommitOptions) => {
    const taskId = IdentifierSchema.parse(value);
    const project = await loadProject(options.project ?? process.cwd());
    const home = path.resolve(options.home ?? defaultOrchestratorHome());
    const configPath = path.resolve(
      options.config ??
        path.join(project.root, ".pi", "orchestrator.local.yaml"),
    );
    const local = await loadLocalConfig(configPath);
    const author = await readGitIdentity(project.root);
    const store = await ProjectStore.open({
      home,
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const run = await resolveTaskRun(store, taskId, options.run);
      const plan = await loadPlan(
        resolvePlanDirectory(project.root, run.plan_id),
        catalogFromConfig(project.config),
      );
      const commitOptions = {
        store,
        project,
        plan,
        local,
        runId: run.id,
        taskId,
        author,
        ...(options.subject ? { subject: options.subject } : {}),
      };
      const inspection = await inspectTaskCommit(commitOptions);
      const authorization =
        inspection.state === "ready"
          ? {
              proposalDigest: inspection.proposal.proposal_digest as Digest,
              approvedBy: os.userInfo().username,
            }
          : undefined;
      if (authorization) {
        if (options.json && !options.yes) {
          throw new OrchestratorError(
            "confirmation_required",
            "JSON Commit output requires explicit --yes confirmation",
          );
        }
        if (!options.json)
          console.log(formatCommitProposal(inspection.proposal));
        await confirmation(
          `Commit Task '${taskId}' with this exact evidence?`,
          options.yes,
        );
      }
      const result = await commitTask({
        ...commitOptions,
        ...(authorization ? { authorization } : {}),
      });
      const output = {
        run: result.run.id,
        run_status: result.run.status,
        task: result.task.id,
        task_status: result.task.status,
        commit: result.record.git.commit,
        subject: result.proposal.subject,
        author: result.proposal.author,
        plan: result.proposal.plan,
        branch: result.proposal.branch,
        input_commit: result.proposal.input_commit,
        source_digest: result.proposal.task_source_digest,
        diff_digest: result.proposal.diff_digest,
        changes: result.proposal.changes,
        checks: result.proposal.checks.map((check) => ({
          ...check,
          verdict: "pass" as const,
        })),
        reviews: result.proposal.reviews.map((review) => ({
          ...review,
          verdict: "pass" as const,
        })),
        proposal_digest: result.proposal.proposal_digest,
        record_digest: result.record.record_digest,
        created: result.created,
        recovered: result.recovered,
        reused: result.reused,
      };
      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
      } else if (result.reused) {
        console.log(`Task ${taskId} is already committed as ${output.commit}`);
      } else {
        console.log(
          `${result.recovered ? "Recovered" : "Committed"} Task ${taskId} as ${output.commit}`,
        );
      }
    } finally {
      await store.close();
    }
  });

program
  .command("metrics")
  .description("summarize validated durable metrics for a Run")
  .argument("<run>", "Run identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--json", "emit JSON")
  .action(async (value: string, options: RunOutputOptions) => {
    const runId = IdentifierSchema.parse(value);
    const project = await loadProject(options.project ?? process.cwd());
    const store = await ProjectStore.open({
      home: path.resolve(options.home ?? defaultOrchestratorHome()),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const metrics = await collectRunMetrics({ store, runId });
      console.log(
        options.json
          ? JSON.stringify(metrics, null, 2)
          : formatRunMetrics(metrics),
      );
    } finally {
      await store.close();
    }
  });

program
  .command("report")
  .description("publish immutable JSON and Markdown reports for a Run")
  .argument("<run>", "Run identifier")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--json", "emit JSON")
  .action(async (value: string, options: RunOutputOptions) => {
    const runId = IdentifierSchema.parse(value);
    const project = await loadProject(options.project ?? process.cwd());
    const store = await ProjectStore.open({
      home: path.resolve(options.home ?? defaultOrchestratorHome()),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const metrics = await collectRunMetrics({ store, runId });
      const published = await new RunReportStore(
        store.runDirectory(runId),
        runId,
      ).publish(metrics);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              created: published.created,
              directory: published.directory,
              json_path: published.jsonPath,
              markdown_path: published.markdownPath,
              report: published.record,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `${published.created ? "Published" : "Reused"} Run report ${published.record.id}`,
        );
        console.log(`JSON: ${published.jsonPath}`);
        console.log(`Markdown: ${published.markdownPath}`);
        console.log(`\n${published.markdown}`);
      }
    } finally {
      await store.close();
    }
  });

program
  .command("status")
  .description("show durable Project planning, approvals, and Runs")
  .option("--project <path>", "consumer Project path")
  .option("--home <path>", "runtime state root")
  .option("--json", "emit JSON")
  .action(async (options: CommonOptions & { home?: string }) => {
    const project = await loadProject(options.project ?? process.cwd());
    const baseCommit = await gitHead(project.root);
    const store = await ProjectStore.open({
      home: options.home ? options.home : defaultOrchestratorHome(),
      projectId: project.config.project.id,
      projectRoot: project.root,
    });
    try {
      const record = await store.read();
      const planning = await new PlanningStore(store).list();
      const approvals = await Promise.all(
        Object.values(record.approvals).map(async (approval) => {
          try {
            const plan = await loadPlan(
              resolvePlanDirectory(project.root, approval.plan_id),
              catalogFromConfig(project.config),
            );
            return {
              ...approval,
              ...approvalFreshness(approval, {
                planId: plan.id,
                planRevision: plan.revision,
                planDigest: plan.digest,
                baseCommit,
              }),
            };
          } catch (error) {
            return {
              ...approval,
              fresh: false,
              reasons: [formatUnknownError(error)],
            };
          }
        }),
      );
      const result = {
        project: record.id,
        root: record.root,
        planning: planning.map((item) => ({
          id: item.id,
          goal: item.goal,
          status: item.status,
          base_commit: item.base_commit,
          source_digest: item.source_digest,
          attempts: item.attempts,
          decisions: Object.keys(item.decisions).length,
          consultations: item.consultations,
          critique: item.critique,
          synthesis: item.synthesis,
        })),
        approvals,
        runs: Object.values(record.runs),
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Project: ${record.id}`);
        console.log(`Root: ${record.root}`);
        console.log(`Planning: ${planning.length}`);
        for (const item of planning) {
          console.log(`  ${item.id}: ${item.status} (${item.goal})`);
          for (const role of ["architecture", "quant"] as const) {
            const consultation = item.consultations[role];
            if (consultation.attempts > 0) {
              console.log(
                `    ${role}: ${consultation.report_digest ? "complete" : "pending"} (attempt ${consultation.attempts})`,
              );
            }
          }
          if (item.critique.attempts > 0) {
            console.log(
              `    critic: ${item.critique.report_digest ? "complete" : "pending"} (attempt ${item.critique.attempts})`,
            );
          }
          if (item.synthesis.attempts > 0) {
            console.log(
              `    synthesis: ${item.synthesis.plan_digest ? "complete" : "pending"} (attempt ${item.synthesis.attempts})`,
            );
          }
        }
        console.log(`Approvals: ${approvals.length}`);
        for (const approval of approvals) {
          console.log(
            `  ${approval.plan_id} r${approval.plan_revision}: ${approval.fresh ? "fresh" : `stale (${approval.reasons.join(", ")})`}`,
          );
        }
        console.log(`Runs: ${Object.keys(record.runs).length}`);
      }
    } finally {
      await store.close();
    }
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof OrchestratorError && error.code === "cancelled") {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(formatUnknownError(error));
  process.exitCode = 1;
});
