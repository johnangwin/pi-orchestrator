#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { approvalFreshness, createApproval } from "./approval.js";
import { catalogFromConfig, loadPlan } from "./plan.js";
import { formatUnknownError, OrchestratorError } from "./error.js";
import { initializeProject } from "./init.js";
import { loadLocalConfig, type LocalConfig } from "./local.js";
import { OpenShellClient } from "./openshell.js";
import { gitHead, loadProject, resolvePlanDirectory } from "./project.js";
import { defaultOrchestratorHome, ProjectStore } from "./state.js";

interface CommonOptions {
  readonly project?: string;
  readonly json?: boolean;
}

interface ApproveOptions extends CommonOptions {
  readonly yes?: boolean;
  readonly home?: string;
}

interface DoctorOptions {
  readonly config?: string;
  readonly gateway?: string;
  readonly json?: boolean;
  readonly openshell?: string;
  readonly requireVersion?: string;
  readonly workspace?: string;
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
