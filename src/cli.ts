#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { approvalFreshness, createApproval } from "./approval.js";
import { runCanary } from "./canary.js";
import {
  commitTask,
  inspectTaskCommit,
  readGitIdentity,
  type CommitProposal,
} from "./commit.js";
import { IdentifierSchema } from "./config.js";
import type { Digest } from "./digest.js";
import { catalogFromConfig, loadPlan } from "./plan.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { initializeProject } from "./init.js";
import {
  loadLocalConfig,
  resolveMachinePath,
  type LocalConfig,
} from "./local.js";
import { OpenShellClient } from "./openshell.js";
import { SandboxProfileSchema, type SandboxProfile } from "./policy.js";
import { gitHead, loadProject, resolvePlanDirectory } from "./project.js";
import { startRun } from "./run.js";
import { defaultOrchestratorHome, ProjectStore } from "./state.js";

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
  .option("--json", "emit JSON")
  .action(async (options: CanaryCliOptions) => {
    const { client, requiredVersion } = await configuredOpenShell(options);
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
    const result = await runCanary({
      client,
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
  .command("init")
  .argument("[directory]", "consumer Project directory", ".")
  .option("--project-id <id>", "stable Project identifier")
  .action(async (directory: string, options: { projectId?: string }) => {
    const result = await initializeProject(directory, options.projectId);
    console.log(`Initialized ${result.root}`);
    for (const file of result.created) console.log(`  created ${file}`);
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
  .command("status")
  .description("show durable Project approvals and Runs")
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
        approvals,
        runs: Object.values(record.runs),
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Project: ${record.id}`);
        console.log(`Root: ${record.root}`);
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
