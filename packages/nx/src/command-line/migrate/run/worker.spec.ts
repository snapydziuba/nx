const mockRunMigration = jest.fn();
const mockReadMigrationCollection = jest.fn();
const mockLogSkippedInstall = jest.fn();
let mockSkippedInstall = false;
jest.mock('../execute-migration', () => ({
  ChangedDepInstaller: jest.fn().mockImplementation(() => ({
    installDepsIfChanged: jest.fn().mockResolvedValue(undefined),
    get skippedInstall() {
      return mockSkippedInstall;
    },
  })),
  logSkippedPostMigrationInstall: (...args: unknown[]) =>
    mockLogSkippedInstall(...args),
  runNxOrAngularMigration: (...args: unknown[]) => mockRunMigration(...args),
  readMigrationCollection: (...args: unknown[]) =>
    mockReadMigrationCollection(...args),
}));

const mockCommit = jest.fn();
const mockCheckpoint = jest.fn();
jest.mock('../migrate-commits', () => ({
  commitMigrationIfRequested: (...args: unknown[]) => mockCommit(...args),
  commitCheckpointBeforeMigrations: (...args: unknown[]) =>
    mockCheckpoint(...args),
}));

const mockIsInsideAgent = jest.fn();
jest.mock('../agentic/inception', () => ({
  isInsideAgent: () => mockIsInsideAgent(),
}));

const mockGetLatestCommitSha = jest.fn();
jest.mock('../../../utils/git-utils', () => ({
  ...jest.requireActual('../../../utils/git-utils'),
  getLatestCommitSha: (...args: unknown[]) => mockGetLatestCommitSha(...args),
}));

jest.mock('../../../utils/package-manager', () => ({
  detectPackageManager: () => 'npm',
  getPackageManagerCommand: () => ({ exec: 'npx' }),
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { output } from '../../../utils/output';
import { runSingleMigrationWorker } from './worker';
import {
  createRun,
  readRunState,
  runDir,
  writeRunState,
  type MigrateCommitLedgerEntry,
  type MigrateRunState,
  type MigrateStep,
  type MigrateStepStatus,
} from './run-state';

interface PlannedMigration {
  package: string;
  name: string;
  version: string;
  implementation?: string;
  prompt?: string;
}

const genMig = (pkg: string, name: string): PlannedMigration => ({
  package: pkg,
  name,
  version: '1.0.0',
  implementation: './impl.js',
});
const promptMig = (pkg: string, name: string): PlannedMigration => ({
  package: pkg,
  name,
  version: '1.0.0',
  prompt: `prompts/${name}.md`,
});
const hybridMig = (pkg: string, name: string): PlannedMigration => ({
  package: pkg,
  name,
  version: '1.0.0',
  implementation: './impl.js',
  prompt: `prompts/${name}.md`,
});

const migStep = (
  id: string,
  migrationId: string,
  status: MigrateStepStatus,
  roundIndex = 0
): MigrateStep => ({
  id,
  roundIndex,
  kind: 'migration',
  migrationId,
  status,
  attempt: 1,
  dispenseCount: status === 'pending' ? 0 : 1,
});

const changeList = () => [
  { type: 'UPDATE' as const, path: 'a.ts', content: Buffer.from('x') },
];

describe('runSingleMigrationWorker', () => {
  let root: string;
  let stdout: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nx-migrate-worker-'));
    stdout = '';
    jest.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown
    ) => {
      stdout += String(chunk);
      return true;
    }) as unknown as typeof process.stdout.write);
    jest.spyOn(output, 'log').mockImplementation(() => {});
    jest.spyOn(output, 'warn').mockImplementation(() => {});

    mockRunMigration.mockReset().mockResolvedValue({
      changes: [],
      nextSteps: [],
      agentContext: [],
      logs: '',
      madeChanges: false,
    });
    mockReadMigrationCollection.mockReset().mockImplementation(() => {
      throw new Error('not mocked');
    });
    mockCommit.mockReset().mockResolvedValue({ status: 'no-changes' });
    mockCheckpoint.mockReset();
    mockIsInsideAgent.mockReset().mockReturnValue(false);
    mockGetLatestCommitSha.mockReset().mockReturnValue(null);
    mockLogSkippedInstall.mockReset();
    mockSkippedInstall = false;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function writeMigrations(migrations: PlannedMigration[]): void {
    writeFileSync(
      join(root, 'migrations.json'),
      JSON.stringify({ migrations })
    );
  }

  function standaloneInput(overrides: {
    runMigration: string;
    createCommits?: boolean;
  }) {
    return {
      root,
      options: { runMigration: overrides.runMigration },
      createCommits: overrides.createCommits,
      commitPrefix: 'chore: [nx migration] ',
      skipInstall: true,
      isVerbose: false,
    };
  }

  function recordedInput(runMigration: string, runId: string) {
    return {
      root,
      options: { runMigration, runId },
      createCommits: undefined,
      commitPrefix: 'chore: [nx migration] ',
      skipInstall: true,
      isVerbose: false,
    };
  }

  function setupRun(
    runId: string,
    opts: {
      steps: MigrateStep[];
      migrations?: PlannedMigration[];
      rounds?: { index: number; migrations: PlannedMigration[] }[];
      createCommits?: boolean;
      commits?: MigrateCommitLedgerEntry[];
    }
  ): string {
    const dir = runDir(root, runId);
    mkdirSync(dir, { recursive: true });
    const rounds = opts.rounds ?? [
      { index: 0, migrations: opts.migrations ?? [] },
    ];
    for (const round of rounds) {
      writeFileSync(
        join(dir, `plan-${round.index}.json`),
        JSON.stringify({ migrations: round.migrations })
      );
    }
    const state: MigrateRunState = {
      formatVersion: 1,
      runId,
      createdAt: '2026-01-01T00:00:00.000Z',
      nxVersion: '1.0.0',
      mode: 'orchestrated',
      status: 'active',
      createCommits: opts.createCommits ?? false,
      commitPrefix: 'chore: [nx migration] ',
      rounds: rounds.map((r) => ({
        index: r.index,
        planHash: 'h',
        planSnapshot: `plan-${r.index}.json`,
      })),
      steps: opts.steps,
      issues: [],
      commits: opts.commits ?? [],
      analytics: { startEmitted: false, completeEmitted: false },
    };
    writeRunState(dir, state);
    return dir;
  }

  describe('id resolution', () => {
    it('resolves an exact <package>:<name> id', async () => {
      writeMigrations([genMig('@nx/js', 'a'), genMig('@nx/react', 'b')]);

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/react:b' })
      );

      expect(mockRunMigration).toHaveBeenCalledTimes(1);
      expect(mockRunMigration.mock.calls[0][1]).toMatchObject({
        package: '@nx/react',
        name: 'b',
      });
    });

    it('resolves a bare name when exactly one migration matches', async () => {
      writeMigrations([genMig('@nx/js', 'a'), genMig('@nx/react', 'b')]);

      await runSingleMigrationWorker(standaloneInput({ runMigration: 'b' }));

      expect(mockRunMigration.mock.calls[0][1]).toMatchObject({
        package: '@nx/react',
        name: 'b',
      });
    });

    it('errors on a bare name matching multiple migrations, listing the matches', async () => {
      writeMigrations([genMig('@nx/js', 'dup'), genMig('@nx/react', 'dup')]);

      await expect(
        runSingleMigrationWorker(standaloneInput({ runMigration: 'dup' }))
      ).rejects.toThrow(/@nx\/js:dup[\s\S]*@nx\/react:dup/);
      expect(mockRunMigration).not.toHaveBeenCalled();
    });

    it('errors on an unknown id, naming the id and the source', async () => {
      writeMigrations([genMig('@nx/js', 'a')]);

      await expect(
        runSingleMigrationWorker(standaloneInput({ runMigration: 'nope' }))
      ).rejects.toThrow(
        /No migration matching 'nope' was found in migrations\.json/
      );
    });

    it('errors when migrations.json is missing', async () => {
      await expect(
        runSingleMigrationWorker(standaloneInput({ runMigration: 'x' }))
      ).rejects.toThrow(/File 'migrations\.json' doesn't exist/);
    });
  });

  describe('standalone execution', () => {
    it('runs a generator migration and prints its next steps', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: ['do a thing'],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(mockRunMigration).toHaveBeenCalledTimes(1);
      expect(output.log).toHaveBeenCalledWith(
        expect.objectContaining({ bodyLines: ['- do a thing'] })
      );
    });

    it('commits a generator migration only when create-commits is enabled', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockCommit.mockResolvedValue({ status: 'committed', sha: 'abc' });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen', createCommits: false })
      );
      expect(mockCommit).not.toHaveBeenCalled();

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen', createCommits: true })
      );
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it('checkpoints pre-existing working-tree state before the migration when commits are enabled', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockCommit.mockResolvedValue({ status: 'committed', sha: 'abc' });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen', createCommits: true })
      );

      expect(mockCheckpoint).toHaveBeenCalledWith(
        root,
        'chore: [nx migration] '
      );
      expect(mockCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
        mockRunMigration.mock.invocationCallOrder[0]
      );
    });

    it('does not checkpoint when commits are not enabled', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(mockCheckpoint).not.toHaveBeenCalled();
    });

    it('forwards a generator-only migration agentContext to the outer agent', async () => {
      mockIsInsideAgent.mockReturnValue(true);
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: ['hint one'],
        logs: '',
        madeChanges: true,
      });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(stdout).toContain('<agent_context migration="@nx/js:gen">');
      expect(stdout).toContain('hint one');
    });

    it('does not forward agentContext outside an agent', async () => {
      mockIsInsideAgent.mockReturnValue(false);
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: ['hint one'],
        logs: '',
        madeChanges: true,
      });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(stdout).not.toContain('<agent_context');
    });

    it('treats a failed commit as a warning, not a failure', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockCommit.mockResolvedValue({ status: 'failed', reason: 'boom' });

      await expect(
        runSingleMigrationWorker(
          standaloneInput({ runMigration: '@nx/js:gen', createCommits: true })
        )
      ).resolves.toBeUndefined();
    });

    it('emits a tagged prompt block for a prompt-only migration inside an agent', async () => {
      mockIsInsideAgent.mockReturnValue(true);
      writeMigrations([promptMig('@nx/js', 'p')]);

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:p' })
      );

      expect(mockRunMigration).not.toHaveBeenCalled();
      expect(stdout).toContain('<nx_migrate_prompt migration="@nx/js:p">');
      expect(stdout).toContain('"migrationId": "@nx/js:p"');
      expect(stdout).toContain('"prompt": "prompts/p.md"');
    });

    it('prints prompt instructions for a prompt-only migration outside an agent', async () => {
      mockIsInsideAgent.mockReturnValue(false);
      writeMigrations([promptMig('@nx/js', 'p')]);

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:p' })
      );

      expect(mockRunMigration).not.toHaveBeenCalled();
      expect(stdout).not.toContain('<nx_migrate_prompt');
      expect(output.log).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('must be applied manually'),
        })
      );
    });

    it('runs the generator half then emits the prompt block for a hybrid migration inside an agent', async () => {
      mockIsInsideAgent.mockReturnValue(true);
      writeMigrations([hybridMig('@nx/js', 'h')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: ['generator hint'],
        logs: 'generator ran',
        madeChanges: true,
      });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:h' })
      );

      expect(mockRunMigration).toHaveBeenCalledTimes(1);
      expect(stdout).toContain('<nx_migrate_prompt migration="@nx/js:h">');
      expect(stdout).toContain('"impl"');
      // Hybrid agentContext rides inside the payload, not a separate block.
      expect(stdout).toContain('"agentContext"');
      expect(stdout).toContain('"generator hint"');
      expect(stdout).not.toContain('<agent_context');
    });

    it('warns about an active run but still executes', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      createRun(root, {
        formatVersion: 1,
        runId: 'active-run',
        createdAt: '2026-01-01T00:00:00.000Z',
        nxVersion: '1.0.0',
        mode: 'orchestrated',
        status: 'active',
        createCommits: false,
        commitPrefix: 'chore: [nx migration] ',
        rounds: [],
        steps: [],
        issues: [],
        commits: [],
        analytics: { startEmitted: false, completeEmitted: false },
      });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(output.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('active-run'),
        })
      );
      expect(mockRunMigration).toHaveBeenCalledTimes(1);
    });

    it('does not commit when the generator makes no changes, even with -C', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      // Default mockRunMigration returns madeChanges: false.

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen', createCommits: true })
      );

      expect(mockRunMigration).toHaveBeenCalledTimes(1);
      expect(mockCommit).not.toHaveBeenCalled();
    });

    it('warns when a dependency-changing migration ran with the install skipped', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockSkippedInstall = true;

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(mockLogSkippedInstall).toHaveBeenCalledWith(root);
    });

    it('does not warn about a skipped install when nothing was skipped', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(mockLogSkippedInstall).not.toHaveBeenCalled();
    });

    it('prints the prompt file contents when it is readable', async () => {
      writeMigrations([promptMig('@nx/js', 'p')]);
      mkdirSync(join(root, 'prompts'), { recursive: true });
      writeFileSync(join(root, 'prompts', 'p.md'), 'step one\nstep two');

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:p' })
      );

      expect(output.log).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyLines: expect.arrayContaining([
            'step one',
            'step two',
            'Review the instructions above and apply them manually.',
          ]),
        })
      );
    });

    it('warns naming the prompt file and error code when it cannot be read', async () => {
      // promptMig points at prompts/p.md, which is never created here.
      writeMigrations([promptMig('@nx/js', 'p')]);

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:p' })
      );

      expect(output.log).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyLines: expect.arrayContaining([
            expect.stringMatching(
              /The instructions file 'prompts\/p\.md' could not be read \(ENOENT\)/
            ),
          ]),
        })
      );
      expect(output.log).not.toHaveBeenCalledWith(
        expect.objectContaining({
          bodyLines: expect.arrayContaining([
            'Review the instructions above and apply them manually.',
          ]),
        })
      );
    });

    it('tolerates a newer-format active run and still executes', async () => {
      writeMigrations([genMig('@nx/js', 'gen')]);
      const dir = runDir(root, 'newer-run');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'run.json'),
        JSON.stringify({
          formatVersion: 999,
          runId: 'newer-run',
          createdAt: '2026-01-01T00:00:00.000Z',
          nxVersion: '999.0.0',
          mode: 'orchestrated',
          status: 'active',
          createCommits: false,
          commitPrefix: '',
          rounds: [],
          steps: [],
          issues: [],
          commits: [],
          analytics: { startEmitted: false, completeEmitted: false },
        })
      );

      await runSingleMigrationWorker(
        standaloneInput({ runMigration: '@nx/js:gen' })
      );

      expect(mockRunMigration).toHaveBeenCalledTimes(1);
      expect(output.warn).not.toHaveBeenCalled();
    });
  });

  describe('recorded execution (--run-id)', () => {
    it('records a generator migration: dispensed -> running -> succeeded with an outcome', async () => {
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: ['follow up'],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockGetLatestCommitSha.mockReturnValue('sha-after');
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'dispensed')],
        migrations: [genMig('@nx/js', 'gen')],
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'));

      const state = readRunState(dir);
      expect(state.steps[0].status).toBe('succeeded');
      expect(state.steps[0].pid).toBe(process.pid);
      expect(state.steps[0].startedAt).toBeDefined();
      expect(state.steps[0].outcome).toMatchObject({
        fileChanges: ['a.ts'],
        gitRefAfter: 'sha-after',
        nextSteps: ['follow up'],
      });
    });

    it('parks a prompt-only migration in awaiting-prompt-outcome', async () => {
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:p', 'dispensed')],
        migrations: [promptMig('@nx/js', 'p')],
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:p', 'run-1'));

      expect(readRunState(dir).steps[0].status).toBe('awaiting-prompt-outcome');
      expect(mockRunMigration).not.toHaveBeenCalled();
    });

    it('parks a hybrid migration in awaiting-prompt-outcome after running its generator, marking the generator done', async () => {
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:h', 'dispensed')],
        migrations: [hybridMig('@nx/js', 'h')],
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:h', 'run-1'));

      expect(mockRunMigration).toHaveBeenCalledTimes(1);
      const step = readRunState(dir).steps[0];
      expect(step.status).toBe('awaiting-prompt-outcome');
      expect(step.generatorCompleted).toBe(true);
    });

    it('skips the generator half on a hybrid retry once its generator already completed', async () => {
      mockIsInsideAgent.mockReturnValue(true);
      const dir = setupRun('run-1', {
        steps: [
          {
            ...migStep('step-1', '@nx/js:h', 'dispensed'),
            generatorCompleted: true,
          },
        ],
        migrations: [hybridMig('@nx/js', 'h')],
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:h', 'run-1'));

      // Generator not re-run; only the prompt is re-emitted and the step
      // re-parks with the marker intact.
      expect(mockRunMigration).not.toHaveBeenCalled();
      expect(stdout).toContain('<nx_migrate_prompt migration="@nx/js:h">');
      const step = readRunState(dir).steps[0];
      expect(step.status).toBe('awaiting-prompt-outcome');
      expect(step.generatorCompleted).toBe(true);
    });

    it('records a failed step carrying the error first line as its outcome summary, then rethrows', async () => {
      mockRunMigration.mockRejectedValue(
        new Error('boom: something broke\nstack frame one\nstack frame two')
      );
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'dispensed')],
        migrations: [genMig('@nx/js', 'gen')],
      });

      await expect(
        runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'))
      ).rejects.toThrow('boom');
      const step = readRunState(dir).steps[0];
      expect(step.status).toBe('failed');
      // Only the first line, so the agent gets a summary, not a stack.
      expect(step.outcome.summary).toBe('boom: something broke');
    });

    it('refuses to start a step that was never dispensed, leaving it pending', async () => {
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'pending')],
        migrations: [genMig('@nx/js', 'gen')],
      });

      await expect(
        runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'))
      ).rejects.toThrow(/Cannot record this migration into the run/);
      expect(readRunState(dir).steps[0].status).toBe('pending');
      expect(mockRunMigration).not.toHaveBeenCalled();
    });

    it('refuses to run a step already running under another pid, without invoking the migration engine', async () => {
      // A second worker racing the same dispensed step: the 'start' transition
      // validates against the fresh disk state (already 'running') and aborts
      // before the migration engine runs.
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'running')],
        migrations: [genMig('@nx/js', 'gen')],
      });
      const otherPid = process.pid + 1;
      const state = readRunState(dir);
      writeRunState(dir, {
        ...state,
        steps: [{ ...state.steps[0], pid: otherPid }],
      });

      await expect(
        runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'))
      ).rejects.toThrow(/Cannot record this migration into the run/);
      expect(readRunState(dir).steps[0].status).toBe('running');
      expect(readRunState(dir).steps[0].pid).toBe(otherPid);
      expect(mockRunMigration).not.toHaveBeenCalled();
    });

    it('errors when the run has no step for the migration', async () => {
      setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:other', 'dispensed')],
        migrations: [genMig('@nx/js', 'gen')],
      });

      await expect(
        runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'))
      ).rejects.toThrow(/has no step for migration '@nx\/js:gen'/);
    });

    it('appends a landed ledger entry absorbing prior uncovered failed step ids and attributes them in the commit body', async () => {
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockCommit.mockResolvedValue({ status: 'committed', sha: 'newsha' });
      const dir = setupRun('run-1', {
        steps: [
          migStep('step-1', '@nx/js:prior', 'failed'),
          migStep('step-2', '@nx/js:gen', 'dispensed'),
        ],
        migrations: [genMig('@nx/js', 'gen')],
        createCommits: true,
        commits: [{ kind: 'failed', stepIds: ['step-1'], issueIds: [] }],
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'));

      // The absorbed migrations reach the commit body via the pending arg.
      expect(mockCommit.mock.calls[0][5]).toEqual([
        { package: '@nx/js', name: 'prior' },
      ]);
      const state = readRunState(dir);
      expect(state.commits).toContainEqual({
        kind: 'landed',
        sha: 'newsha',
        stepIds: ['step-2', 'step-1'],
        issueIds: [],
      });
    });

    it('records a failed ledger entry when the commit call throws, then rethrows', async () => {
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockCommit.mockRejectedValue(new Error('install failed'));
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'dispensed')],
        migrations: [genMig('@nx/js', 'gen')],
        createCommits: true,
      });

      await expect(
        runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'))
      ).rejects.toThrow('install failed');

      const state = readRunState(dir);
      expect(state.commits).toContainEqual({
        kind: 'failed',
        stepIds: ['step-1'],
        issueIds: [],
      });
      expect(state.steps[0].status).toBe('failed');
    });

    it('only matches the latest round step when an older round has the same migration id', async () => {
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      const dir = setupRun('run-1', {
        steps: [
          migStep('step-old', '@nx/js:gen', 'failed', 0),
          migStep('step-new', '@nx/js:gen', 'dispensed', 1),
        ],
        rounds: [
          { index: 0, migrations: [genMig('@nx/js', 'gen')] },
          { index: 1, migrations: [genMig('@nx/js', 'gen')] },
        ],
      });
      const before = readRunState(dir);

      await runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'));

      const state = readRunState(dir);
      expect(state.steps.find((s) => s.id === 'step-new').status).toBe(
        'succeeded'
      );
      expect(state.steps.find((s) => s.id === 'step-old')).toEqual(
        before.steps.find((s) => s.id === 'step-old')
      );
    });

    it('records a failed ledger entry and warns when the commit fails', async () => {
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockCommit.mockResolvedValue({ status: 'failed', reason: 'nope' });
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'dispensed')],
        migrations: [genMig('@nx/js', 'gen')],
        createCommits: true,
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'));

      const state = readRunState(dir);
      expect(state.commits).toContainEqual({
        kind: 'failed',
        stepIds: ['step-1'],
        issueIds: [],
      });
      expect(output.warn).toHaveBeenCalled();
      // A failed commit is not a failed step: the generator still succeeded.
      expect(state.steps[0].status).toBe('succeeded');
    });

    it('records no commit ledger entry when the generator makes no changes', async () => {
      // Default mockRunMigration returns madeChanges: false.
      const dir = setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'dispensed')],
        migrations: [genMig('@nx/js', 'gen')],
        createCommits: true,
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'));

      const state = readRunState(dir);
      expect(mockCommit).not.toHaveBeenCalled();
      expect(state.commits).toEqual([]);
      expect(state.steps[0].status).toBe('succeeded');
    });

    it('warns when a recorded dependency-changing migration skips the install', async () => {
      mockRunMigration.mockResolvedValue({
        changes: changeList(),
        nextSteps: [],
        agentContext: [],
        logs: '',
        madeChanges: true,
      });
      mockSkippedInstall = true;
      setupRun('run-1', {
        steps: [migStep('step-1', '@nx/js:gen', 'dispensed')],
        migrations: [genMig('@nx/js', 'gen')],
      });

      await runSingleMigrationWorker(recordedInput('@nx/js:gen', 'run-1'));

      expect(mockLogSkippedInstall).toHaveBeenCalledWith(root);
    });
  });

  describe('run id validation', () => {
    it.each(['../escape', '..', '.'])(
      'rejects the unsafe run id %s',
      async (runId) => {
        writeMigrations([genMig('@nx/js', 'gen')]);

        await expect(
          runSingleMigrationWorker(recordedInput('@nx/js:gen', runId))
        ).rejects.toThrow(`Invalid run id '${runId}'.`);
      }
    );

    it('errors when the run directory does not exist', async () => {
      await expect(
        runSingleMigrationWorker(recordedInput('@nx/js:gen', 'missing'))
      ).rejects.toThrow(
        /No migrate run 'missing' was found under \.nx\/migrate-runs/
      );
    });
  });
});
