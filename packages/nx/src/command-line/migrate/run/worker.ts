import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import type { FileChange } from '../../../generators/tree';
import { getLatestCommitSha } from '../../../utils/git-utils';
import { readJsonFile } from '../../../utils/fileutils';
import { output } from '../../../utils/output';
import { isInsideAgent } from '../agentic/inception';
import { printDroppedAgentContextForOuterAgent } from '../agentic/print-dropped-agent-context';
import {
  ChangedDepInstaller,
  logSkippedPostMigrationInstall,
  readMigrationCollection,
  runNxOrAngularMigration,
} from '../execute-migration';
import {
  commitCheckpointBeforeMigrations,
  commitMigrationIfRequested,
} from '../migrate-commits';
import { reportMigrateSingleMigrationRun } from '../migrate-analytics';
import { isHybridMigration, isPromptOnlyMigration } from '../migration-shape';
import {
  findActiveRun,
  NewerRunStateFormatError,
  readRunState,
  runDir,
  type MigrateCommitLedgerEntry,
  type MigrateRunState,
  type MigrateStep,
  type MigrateStepOutcome,
} from './run-state';
import { updateRunState } from './state-lock';
import { RUN_ID_SAFE } from './run-id';
import {
  applyStepEvent,
  commitResultToLedgerEntry,
  latestRound,
  stepsToPendingMigrations,
  uncoveredFailedStepIds,
  type StepEvent,
} from './state-machine';
import {
  escapeXmlAttr,
  nowIso,
  pmExecPrefix,
  summarizeError,
  warnCommitFailed,
} from './util';

// The `ng update <pkg> --migrate-only` analog: run exactly one migration from
// the migrations file, either standalone (stateless) or recorded into an
// existing orchestrated run via `--run-id`.

/** A migration entry as written into the plan (migrations.json / plan snapshot). */
interface PlannedMigration {
  package: string;
  name: string;
  version: string;
  description?: string;
  implementation?: string;
  factory?: string;
  prompt?: string;
  documentation?: string;
}

export interface RunSingleMigrationWorkerInput {
  root: string;
  options: { runMigration: string; runId?: string };
  createCommits: boolean | undefined;
  commitPrefix: string;
  skipInstall: boolean;
  isVerbose: boolean;
}

export async function runSingleMigrationWorker(
  input: RunSingleMigrationWorkerInput
): Promise<void> {
  const { root, options, createCommits, commitPrefix, skipInstall, isVerbose } =
    input;

  // The worker is a second CLI entry point: the run id reaches runDir() (where
  // join resolves '..'), so validate it up front exactly as the orchestrator
  // does before it trusts a run id.
  if (options.runId !== undefined && !RUN_ID_SAFE.test(options.runId)) {
    throw new Error(`Invalid run id '${options.runId}'.`);
  }

  const { migrations, source } = readMigrationsSource(root, options.runId);
  const migration = resolveMigration(migrations, options.runMigration, source);

  reportMigrateSingleMigrationRun({
    migrationType: isPromptOnlyMigration(migration)
      ? 'prompt'
      : isHybridMigration(migration)
        ? 'hybrid'
        : 'generator',
    orchestrated: !!options.runId,
  });

  if (options.runId) {
    await runRecorded(root, options.runId, migration, skipInstall, isVerbose);
  } else {
    await runStandalone(
      root,
      migration,
      createCommits,
      commitPrefix,
      skipInstall,
      isVerbose
    );
  }
}

function readMigrationsSource(
  root: string,
  runId: string | undefined
): { migrations: PlannedMigration[]; source: string } {
  if (runId) {
    const dir = runDir(root, runId);
    // A missing run dir would surface a raw ENOENT from readRunState's
    // readFileSync; report it the way the orchestrator does instead.
    if (!existsSync(dir)) {
      throw new Error(
        `No migrate run '${runId}' was found under .nx/migrate-runs. Start one with \`${pmExecPrefix(
          root
        )} nx migrate --run-migrations\` before recording into it.`
      );
    }
    // Version refusal (NewerRunStateFormatError) propagates.
    const state = readRunState(dir);
    const round = latestRound(state);
    if (!round) {
      throw new Error(
        `The migrate run '${runId}' has no recorded plan, so there is no migration to run.`
      );
    }
    const planPath = join(dir, round.planSnapshot);
    if (!existsSync(planPath)) {
      throw new Error(
        `The plan snapshot '${round.planSnapshot}' for migrate run '${runId}' doesn't exist, can't run the migration.`
      );
    }
    return {
      migrations: readPlanMigrations(planPath),
      source: round.planSnapshot,
    };
  }

  const migrationsPath = join(root, 'migrations.json');
  if (!existsSync(migrationsPath)) {
    throw new Error(
      `File 'migrations.json' doesn't exist, can't run the migration. Run \`${pmExecPrefix(
        root
      )} nx migrate\` to generate it first.`
    );
  }
  return {
    migrations: readPlanMigrations(migrationsPath),
    source: 'migrations.json',
  };
}

function readPlanMigrations(path: string): PlannedMigration[] {
  return (
    readJsonFile<{ migrations?: PlannedMigration[] }>(path).migrations ?? []
  );
}

function resolveMigration(
  migrations: PlannedMigration[],
  id: string,
  source: string
): PlannedMigration {
  // '<package>:<name>' splits on the first ':', leaving names that themselves
  // contain a ':' intact; a bare id matches on name only.
  const colon = id.indexOf(':');
  const matches =
    colon === -1
      ? migrations.filter((m) => m.name === id)
      : migrations.filter(
          (m) =>
            m.package === id.slice(0, colon) && m.name === id.slice(colon + 1)
        );

  if (matches.length === 0) {
    throw new Error(`No migration matching '${id}' was found in ${source}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      [
        `More than one migration matches '${id}' in ${source}. Re-run with the full '<package>:<name>' id:`,
        ...matches.map((m) => `  - ${m.package}:${m.name}`),
      ].join('\n')
    );
  }
  return matches[0];
}

async function runStandalone(
  root: string,
  migration: PlannedMigration,
  createCommits: boolean | undefined,
  commitPrefix: string,
  skipInstall: boolean,
  isVerbose: boolean
): Promise<void> {
  // Standalone never writes run state. Warn (don't block) when an orchestrated
  // run is active so the user knows this execution won't be recorded into it.
  // A newer-nx run dir must not hard-block this stateless path (the fail-closed
  // refusal in run-state.ts targets run-starting callers); tolerate it and skip
  // the warning.
  let active: ReturnType<typeof findActiveRun>;
  try {
    active = findActiveRun(root);
  } catch (e) {
    if (!(e instanceof NewerRunStateFormatError)) {
      throw e;
    }
    active = null;
  }
  if (active) {
    output.warn({
      title: `This migration won't be recorded into the active migrate run '${active.runId}'.`,
      bodyLines: [
        `Pass --run-id=${active.runId} to record it into that run instead.`,
      ],
    });
  }

  if (isPromptOnlyMigration(migration)) {
    emitOrPrintPrompt(root, migration);
    return;
  }

  // Same guard as the classic loop: checkpoint pre-existing working-tree state
  // so the commit's `git add -A` can't fold it into the migration's commit.
  if (createCommits === true) {
    commitCheckpointBeforeMigrations(root, commitPrefix);
  }

  const installer = new ChangedDepInstaller(root, skipInstall);
  const { changes, nextSteps, agentContext, logs, madeChanges } =
    await runNxOrAngularMigration(
      root,
      migration,
      isVerbose,
      isHybridMigration(migration)
    );

  if (!isHybridMigration(migration)) {
    forwardDroppedAgentContext(migration, agentContext);
  }

  // Commit only with -C and only when the generator changed something: a no-op
  // migration must not build a commit whose `git add -A` absorbs prior pending
  // diffs under its name. When commits run, the install happens inside the
  // commit; otherwise it runs on its own here.
  if (createCommits === true && madeChanges) {
    await commitMigrationIfRequested(root, migration, true, commitPrefix, () =>
      installer.installDepsIfChanged()
    );
  } else {
    await installer.installDepsIfChanged();
  }

  if (installer.skippedInstall) {
    logSkippedPostMigrationInstall(root);
  }

  printNextSteps(migration, nextSteps);

  if (isHybridMigration(migration)) {
    emitOrPrintPrompt(root, migration, { logs, changes, agentContext });
  }
}

async function runRecorded(
  root: string,
  runId: string,
  migration: PlannedMigration,
  skipInstall: boolean,
  isVerbose: boolean
): Promise<void> {
  const dir = runDir(root, runId);
  // Version refusal (NewerRunStateFormatError) propagates.
  let state = readRunState(dir);

  const migrationId = `${migration.package}:${migration.name}`;
  // The plan was read from the latest round's snapshot, so only that round's
  // step may match; a same-id step from an older round must not.
  const latest = latestRound(state);
  const step = state.steps.find(
    (s) =>
      s.kind === 'migration' &&
      s.migrationId === migrationId &&
      s.roundIndex === latest?.index
  );
  if (!step) {
    throw new Error(
      `The migrate run '${runId}' has no step for migration '${migrationId}'.`
    );
  }

  // Validated against the fresh disk state: a second worker racing the same
  // dispensed step reads 'running' here and aborts before the engine runs.
  state = transition(dir, {
    type: 'start',
    stepId: step.id,
    pid: process.pid,
    startedAt: nowIso(),
  });

  // A prior attempt's generator half already ran and committed, so a plain
  // retry must not reapply it against a tree that already holds its changes.
  // Read from the state the start transition returned: a delayed invocation
  // may have claimed a later attempt whose flag its entry snapshot predates.
  const startedStep = state.steps.find((s) => s.id === step.id);
  const generatorAlreadyCompleted =
    isHybridMigration(migration) && startedStep.generatorCompleted === true;

  let outcome: MigrateStepOutcome | undefined;
  try {
    if (isPromptOnlyMigration(migration) || generatorAlreadyCompleted) {
      emitOrPrintPrompt(root, migration);
    } else {
      const installer = new ChangedDepInstaller(root, skipInstall);
      const { changes, nextSteps, agentContext, logs, madeChanges } =
        await runNxOrAngularMigration(
          root,
          migration,
          isVerbose,
          isHybridMigration(migration)
        );

      if (!isHybridMigration(migration)) {
        forwardDroppedAgentContext(migration, agentContext);
      }

      // Commits follow the run config, not CLI flags, and only when the
      // generator changed something: a no-op step must not create a commit (nor
      // a ledger entry) that absorbs prior pending diffs under its name.
      if (state.createCommits && madeChanges) {
        // Computed before the commit so the ledger entry and the commit body
        // name the same absorbed steps.
        const absorbedStepIds = uncoveredFailedStepIds(state).filter(
          (id) => id !== step.id
        );
        let result: Awaited<ReturnType<typeof commitMigrationIfRequested>>;
        try {
          result = await commitMigrationIfRequested(
            root,
            migration,
            true,
            state.commitPrefix,
            () => installer.installDepsIfChanged(),
            stepsToPendingMigrations(state, absorbedStepIds)
          );
        } catch (commitError) {
          // A post-migration install failure leaves the diff uncommitted;
          // record the debt so only a landed entry can cover it.
          state = appendCommit(dir, {
            kind: 'failed',
            stepIds: [step.id],
            issueIds: [],
          });
          throw commitError;
        }
        state = recordCommitInLedger(
          dir,
          state,
          step,
          migration,
          result,
          absorbedStepIds
        );
      } else {
        await installer.installDepsIfChanged();
      }

      if (installer.skippedInstall) {
        logSkippedPostMigrationInstall(root);
      }

      printNextSteps(migration, nextSteps);

      if (isHybridMigration(migration)) {
        emitOrPrintPrompt(root, migration, { logs, changes, agentContext });
      } else {
        outcome = buildOutcome(changes, nextSteps, migration.description, root);
      }
    }
  } catch (e) {
    // The failed-step dispense surfaces this so the agent can decide
    // retry-vs-skip; carry the error's first line, not a full stack.
    transition(dir, {
      type: 'fail',
      stepId: step.id,
      finishedAt: nowIso(),
      outcome: { summary: summarizeError(e) },
    });
    throw e;
  }

  // A prompt half (prompt-only, or the prompt phase of a hybrid) is applied by
  // a separate actor, so the step parks in awaiting-prompt-outcome and this
  // process exits successfully. A hybrid records that its generator half is
  // done so a later retry skips it.
  if (isPromptOnlyMigration(migration) || isHybridMigration(migration)) {
    transition(dir, {
      type: 'awaitPromptOutcome',
      stepId: step.id,
      finishedAt: nowIso(),
      ...(isHybridMigration(migration) ? { generatorCompleted: true } : {}),
    });
    return;
  }

  transition(dir, {
    type: 'succeed',
    stepId: step.id,
    finishedAt: nowIso(),
    ...(outcome ? { outcome } : {}),
  });
}

// Applies a step event to the freshest on-disk state under the lock, writes it,
// and returns it. Reading fresh is what makes a racing worker's 'start' see the
// step already 'running' and abort. An illegal transition (e.g. a step that was
// never dispensed) fails with the state machine's own reason.
function transition(dir: string, event: StepEvent): MigrateRunState {
  return updateRunState(dir, (fresh) => {
    const result = applyStepEvent(fresh, event);
    if (result.kind === 'error') {
      throw new Error(
        `Cannot record this migration into the run: ${result.reason}`
      );
    }
    return result.state;
  });
}

function recordCommitInLedger(
  dir: string,
  state: MigrateRunState,
  step: MigrateStep,
  migration: PlannedMigration,
  result: Awaited<ReturnType<typeof commitMigrationIfRequested>>,
  absorbedStepIds: string[]
): MigrateRunState {
  if (result.status === 'failed') {
    warnCommitFailed(migration.name);
  }
  const entry = commitResultToLedgerEntry(result, step.id, absorbedStepIds);
  return entry ? appendCommit(dir, entry) : state;
}

// Appends a ledger entry to the freshest on-disk state under the lock. The git
// commit itself already ran outside the lock; only this pure append is locked.
function appendCommit(
  dir: string,
  entry: MigrateCommitLedgerEntry
): MigrateRunState {
  return updateRunState(dir, (fresh) => ({
    ...fresh,
    commits: [...fresh.commits, entry],
  }));
}

// The classic loop's inside-agent path surfaces generator `agentContext` to
// the outer agent; hybrids carry it in the prompt payload instead.
function forwardDroppedAgentContext(
  migration: PlannedMigration,
  agentContext: string[]
): void {
  if (agentContext.length > 0 && isInsideAgent()) {
    printDroppedAgentContextForOuterAgent({ migration, agentContext });
  }
}

function buildOutcome(
  changes: FileChange[],
  nextSteps: string[],
  description: string | undefined,
  root: string
): MigrateStepOutcome {
  const outcome: MigrateStepOutcome = {};
  if (changes.length > 0) {
    outcome.fileChanges = changes.map((c) => c.path);
  }
  // Non-git repos have no HEAD; omit rather than record a placeholder.
  const gitRefAfter = getLatestCommitSha(root);
  if (gitRefAfter) {
    outcome.gitRefAfter = gitRefAfter;
  }
  if (nextSteps.length > 0) {
    outcome.nextSteps = nextSteps;
  }
  if (description) {
    outcome.summary = description;
  }
  return outcome;
}

function printNextSteps(
  migration: PlannedMigration,
  nextSteps: string[]
): void {
  if (nextSteps.length === 0) return;
  output.log({
    title: `Next steps for ${migration.package}: ${migration.name}`,
    bodyLines: nextSteps.map((line) => `- ${line}`),
  });
}

// Surfaces a prompt-based migration that this worker doesn't apply itself:
// under an outer AI agent, as a machine-readable tagged block it can act on;
// otherwise as printed instructions for the user to apply by hand.
function emitOrPrintPrompt(
  root: string,
  migration: PlannedMigration,
  impl?: { logs: string; changes: FileChange[]; agentContext: string[] }
): void {
  const migrationId = `${migration.package}:${migration.name}`;
  const promptPath = migration.prompt;
  const documentationPath = resolveDocumentationPath(root, migration);

  if (isInsideAgent()) {
    emitPromptForOuterAgent(migrationId, promptPath, documentationPath, impl);
  } else {
    printPromptForUser(root, migration, promptPath, documentationPath);
  }
}

function emitPromptForOuterAgent(
  migrationId: string,
  promptPath: string | undefined,
  documentationPath: string | undefined,
  impl:
    | { logs: string; changes: FileChange[]; agentContext: string[] }
    | undefined
): void {
  const payload: Record<string, unknown> = { migrationId, prompt: promptPath };
  if (documentationPath) payload.documentationPath = documentationPath;
  if (impl) {
    payload.impl = {
      logs: impl.logs,
      changes: impl.changes.map((c) => ({ type: c.type, path: c.path })),
      ...(impl.agentContext.length > 0
        ? { agentContext: impl.agentContext }
        : {}),
    };
  }
  // A raw `<` in a migration-authored string could forge the closing tag.
  // Replacing it with the JSON unicode escape leaves the payload valid JSON
  // and strips every raw `<` a hostile value might break out with.
  const json = JSON.stringify(payload, null, 2).replace(/</g, '\\u003c');
  const block = [
    `The following prompt-based migration was not applied automatically. Apply it to this workspace, then continue.`,
    ``,
    `<nx_migrate_prompt migration="${escapeXmlAttr(migrationId)}">`,
    json,
    `</nx_migrate_prompt>`,
  ].join('\n');
  // Bare newline pair frames the block so adjacent stdout doesn't run into it.
  process.stdout.write(`\n${block}\n\n`);
}

function printPromptForUser(
  root: string,
  migration: PlannedMigration,
  promptPath: string | undefined,
  documentationPath: string | undefined
): void {
  const bodyLines: string[] = [];
  if (promptPath) bodyLines.push(`Instructions file: ${promptPath}`);
  if (documentationPath) bodyLines.push(`Documentation: ${documentationPath}`);

  let content = '';
  let readErrorCode: string | undefined;
  if (promptPath) {
    try {
      content = readFileSync(join(root, promptPath), 'utf-8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      readErrorCode = err.code ?? err.message;
    }
  }

  if (readErrorCode) {
    // The migration named a prompt file we can't read; point at it by path and
    // error code rather than render empty "review the instructions" copy.
    bodyLines.push(
      '',
      `The instructions file '${promptPath}' could not be read (${readErrorCode}). Open it manually and apply the instructions.`
    );
  } else {
    if (content) {
      bodyLines.push('', ...content.split('\n'));
    }
    bodyLines.push(
      '',
      'Review the instructions above and apply them manually.'
    );
  }
  output.log({
    title: `Prompt-based migration ${migration.package}: ${migration.name} must be applied manually`,
    bodyLines,
  });
}

// Mirrors migrate.ts's documentation resolution (which run/ can't import): the
// migration's `documentation` ref is package-relative, so resolve it against
// the collection dir and express it workspace-relative. Best-effort.
function resolveDocumentationPath(
  root: string,
  migration: PlannedMigration
): string | undefined {
  if (!migration.documentation) return undefined;
  let collectionPath: string;
  try {
    collectionPath = readMigrationCollection(
      migration.package,
      root
    ).collectionPath;
  } catch {
    return undefined;
  }
  let resolved: string;
  try {
    resolved = require.resolve(migration.documentation, {
      paths: [dirname(collectionPath)],
    });
  } catch {
    return undefined;
  }
  const rel = relative(root, resolved);
  return rel.startsWith('..') ? resolved : rel;
}
