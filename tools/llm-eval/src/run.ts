/**
 * The runner.
 *
 * ```sh
 * node tools/llm-eval/src/run.ts --dry-run                          # offline, no key, no cost
 * node tools/llm-eval/src/run.ts --model claude-haiku-4-5 --prompts all
 * node tools/llm-eval/src/run.ts --model qwen2.5-coder:7b --provider ollama --prompts all
 * ```
 *
 * One prompt is one loop: scaffold a fresh game, hand the model the docs
 * bundle and the current source, apply whatever comes back, and score it. The
 * game directory is thrown away afterwards; the transcript is not.
 *
 * **No paid call happens without `GAMEABLE_LLM_EVAL_LIVE=1`** — the guard is in
 * `createAnthropicClient`, so `--dry-run` and every test are free by
 * construction rather than by care.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFences } from './fences.ts';
import {
  createAnthropicClient,
  createFakeClient,
  createOllamaClient,
  DEFAULT_MODEL,
  estimateCost,
  NO_USAGE,
  type Completion,
  type Effort,
  type ModelClient,
} from './model.ts';
import { buildRequest, bundlePathFor } from './request.ts';
import {
  loadPrompts,
  runChecks,
  selectPrompts,
  type StageName,
  type TaskPrompt,
} from './prompts.ts';
import {
  CLEAN_BASELINE,
  disqualifiedStages,
  extrapolateCost,
  redBaselineStages,
  judge,
  summarise,
  type PromptResult,
  type RunReport,
  type SkippedPrompt,
} from './score.ts';
import { formatDuration, renderScoreboard, thresholdFor } from './scoreboard.ts';
import { stageBuild, stageE2e, stageTypecheck, stageUnit, type StageResult } from './stages.ts';
import {
  findRepoRoot,
  linkNodeModules,
  prepareWorkspace,
  resolveTemplate,
  scaffoldGame,
  writeGameFile,
  type ResolvedTemplate,
  type Workspace,
} from './workspace.ts';

/** One screen of help. */
const HELP = `
Gameable Engine llm-eval — can a small model, given only the docs, make a working game change?

  node tools/llm-eval/src/run.ts --dry-run
  node tools/llm-eval/src/run.ts --model claude-haiku-4-5 --prompts all

  --model <id>          claude-haiku-4-5 (default), claude-sonnet-5, claude-opus-5,
                        or an Ollama tag such as qwen2.5-coder:7b
  --provider <name>     anthropic | ollama | fake. Inferred from the model id.
  --prompts <what>      all (default), fps, third-person, or a comma-separated list of ids
  --effort <level>      low | medium | high. Ignored on Haiku, which rejects it. Default medium.
  --ollama-url <url>    default http://localhost:11434
  --max-tokens <n>      output ceiling per call. Default 64000.
  --template-dir <p>    scaffold from this directory instead of templates/<name>
  --out <dir>           where results land. Default tools/llm-eval/results
  --cache <dir>         where the one shared npm install lives
  --fresh               reinstall the shared cache before running
  --keep                keep the scaffolded game directories
  --limit <n>           stop after n prompts
  --dry-run             one prompt, fake client, canned correct answer. Offline. Free.
  --list                print the task set and exit
  -h, --help            this

Environment:
  GAMEABLE_LLM_EVAL_LIVE=1   required before any paid API call is made
  GAMEABLE_LLM_EVAL_WASM=1   score the full componentize path instead of --no-wasm
  GAMEABLE_LLM_EVAL_E2E=1    also boot the built game in headless Chromium
  GAMEABLE_LLM_EVAL_CACHE    where the shared npm install lives
`.trim();

/** Parsed command line. */
interface Options {
  model: string;
  provider: 'anthropic' | 'ollama' | 'fake';
  prompts: string;
  effort: Effort;
  ollamaUrl: string | undefined;
  maxTokens: number | undefined;
  templateDir: string | undefined;
  out: string | undefined;
  cache: string | undefined;
  fresh: boolean;
  keep: boolean;
  limit: number | undefined;
  dryRun: boolean;
  list: boolean;
  help: boolean;
}

/**
 * Parse `process.argv`.
 *
 * @param argv Arguments after the executable and script.
 * @returns The options, with defaults filled in.
 */
export function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    model: DEFAULT_MODEL,
    provider: 'anthropic',
    prompts: 'all',
    effort: 'medium',
    ollamaUrl: undefined,
    maxTokens: undefined,
    templateDir: undefined,
    out: undefined,
    cache: undefined,
    fresh: false,
    keep: false,
    limit: undefined,
    dryRun: false,
    list: false,
    help: false,
  };
  let explicitProvider = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    /**
     * Take the next argument as this flag's value.
     *
     * @returns The value.
     */
    const value = (): string => {
      i += 1;
      const next = argv[i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--model':
        options.model = value();
        break;
      case '--provider': {
        const provider = value();
        if (provider !== 'anthropic' && provider !== 'ollama' && provider !== 'fake') {
          throw new Error(`--provider must be anthropic, ollama or fake, not ${provider}`);
        }
        options.provider = provider;
        explicitProvider = true;
        break;
      }
      case '--prompts':
        options.prompts = value();
        break;
      case '--effort': {
        const effort = value();
        if (effort !== 'low' && effort !== 'medium' && effort !== 'high') {
          throw new Error(`--effort must be low, medium or high, not ${effort}`);
        }
        options.effort = effort;
        break;
      }
      case '--ollama-url':
        options.ollamaUrl = value();
        break;
      case '--max-tokens':
        options.maxTokens = Number.parseInt(value(), 10);
        break;
      case '--template-dir':
        options.templateDir = value();
        break;
      case '--out':
        options.out = value();
        break;
      case '--cache':
        options.cache = value();
        break;
      case '--fresh':
        options.fresh = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--limit':
        options.limit = Number.parseInt(value(), 10);
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  if (options.dryRun) {
    options.provider = 'fake';
    if (options.prompts === 'all') options.prompts = 'double-player-move-speed';
  } else if (!explicitProvider) {
    options.provider = options.model.startsWith('claude') ? 'anthropic' : 'ollama';
  }
  return options;
}

/**
 * Build the client the options describe.
 *
 * @param options The command line.
 * @returns A model client.
 */
export function clientFor(options: Options): ModelClient {
  if (options.provider === 'fake') {
    return createFakeClient(cannedCorrectAnswer, options.dryRun ? 'fake-dry-run' : 'fake');
  }
  if (options.provider === 'ollama') {
    return createOllamaClient({ model: options.model, baseUrl: options.ollamaUrl });
  }
  return createAnthropicClient({ model: options.model, effort: options.effort });
}

/**
 * The `--dry-run` answer: a genuinely correct patch, derived from the request.
 *
 * It reads `src/game.ts` back out of the system message the runner just built
 * and returns it with the walk speed doubled. That exercises the request
 * assembly, the fence parser, the path guard, the writer and all five stages —
 * the whole pipeline except the network — and it is the same shape a real
 * model's answer takes.
 *
 * @param req The request the runner assembled.
 * @returns A fenced whole-file answer.
 */
export function cannedCorrectAnswer(req: { system: string; user: string }): string {
  const block = /## `src\/game\.ts`\n\n```ts\n([\s\S]*?)\n```/.exec(req.system);
  const current = block?.[1];
  if (current === undefined) {
    throw new Error('the dry run expected src/game.ts in the system prompt and did not find it');
  }
  const patched = current.replace(/walkSpeed:\s*\d+(\.\d+)?/, 'walkSpeed: 10');
  return ['```ts', '// file: src/game.ts', patched, '```'].join('\n');
}

/**
 * Run the eval.
 *
 * @param argv Arguments after the executable and script.
 * @returns A process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(HELP);
    return 1;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const repoRoot = findRepoRoot();
  const here = fileURLToPath(new URL('..', import.meta.url))
    .replaceAll('\\', '/')
    .replace(/\/$/, '');
  const outDir = options.out ?? `${here}/results`;

  const all = loadPrompts();
  if (options.list) {
    for (const prompt of all) {
      console.log(`${prompt.id.padEnd(30)} ${prompt.template.padEnd(13)} ${prompt.title}`);
    }
    console.log(`\n${String(all.length)} prompts`);
    return 0;
  }

  let selected = selectPrompts(all, options.prompts);
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);

  const client = clientFor(options);
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${client.id.replace(/[^\w.-]/g, '_')}`;
  const transcriptRoot = `${outDir}/transcripts/${runId}`;
  const cacheRoot = (
    options.cache ??
    process.env['GAMEABLE_LLM_EVAL_CACHE'] ??
    join(tmpdir(), 'gameable-llm-eval')
  ).replaceAll('\\', '/');
  // Games are scaffolded outside the repository on purpose: 20 of them with a
  // junctioned node_modules would otherwise sit inside a checkout that eslint,
  // prettier and tsc all walk.
  const runRoot = `${cacheRoot}/runs/${runId}`;
  mkdirSync(transcriptRoot, { recursive: true });

  console.log(`\nGameable Engine llm-eval — ${client.id} (${client.provider})`);
  console.log(`  ${String(selected.length)} prompt(s), results -> ${outDir}`);
  if (options.provider === 'anthropic' && process.env['GAMEABLE_LLM_EVAL_LIVE'] !== '1') {
    console.error(
      '\nerror: live runs need GAMEABLE_LLM_EVAL_LIVE=1. Use --dry-run to stay offline.',
    );
    return 1;
  }

  /** One prepared install per template, built on first use. */
  const workspaces = new Map<string, Workspace>();
  const results: PromptResult[] = [];
  const skippedPrompts: SkippedPrompt[] = [];

  for (const prompt of selected) {
    const template = resolveTemplate(repoRoot, prompt.template, options.templateDir);
    if (template === undefined) {
      if (prompt.skipUntilTemplate === true) {
        skippedPrompts.push({
          id: prompt.id,
          title: prompt.title,
          reason: `templates/${prompt.template} is not finished yet (no src/game.ts)`,
        });
        console.log(`  skip ${prompt.id} — templates/${prompt.template} has no src/game.ts yet`);
        continue;
      }
      const fallback = resolveTemplate(repoRoot, 'tiny-game', `${repoRoot}/fixtures/tiny-game`);
      if (fallback === undefined) {
        throw new Error(`no templates/${prompt.template} and no fixtures/tiny-game to stand in`);
      }
      console.warn(
        `  warning: templates/${prompt.template} is missing; scaffolding fixtures/tiny-game instead. Scores are not comparable.`,
      );
      await runOne(prompt, { ...fallback, substituteFor: prompt.template });
      continue;
    }
    await runOne(prompt, template);
  }

  /**
   * Scaffold, ask, apply and score one prompt.
   *
   * @param prompt The task.
   * @param template Where to scaffold from.
   * @returns Nothing; pushes onto {@link results}.
   */
  async function runOne(prompt: TaskPrompt, template: ResolvedTemplate): Promise<void> {
    const key = `${template.name}:${template.dir}`;
    let workspace = workspaces.get(key);
    if (workspace === undefined) {
      workspace = await prepareWorkspace({
        repoRoot,
        template,
        cacheRoot: options.cache,
        fresh: options.fresh,
        log: (line) => {
          console.log(line);
        },
      });
      workspaces.set(key, workspace);
    }

    // The clock starts after the shared install: that is a one-off setup cost
    // for the whole run, not something to charge to the first prompt.
    const started = Date.now();
    const gameDir = `${runRoot}/${prompt.id}`;
    const transcript = `${transcriptRoot}/${prompt.id}`;
    mkdirSync(transcript, { recursive: true });
    rmSync(gameDir, { recursive: true, force: true });
    await scaffoldGame({ repoRoot, template, targetDir: gameDir });
    linkNodeModules(gameDir, workspace);
    if (prompt.scaffoldEmpty === true) emptySource(gameDir);

    const bundle = readFileSync(
      bundlePathFor(repoRoot, template.substituteFor ?? template.name),
      'utf8',
    );
    const request = buildRequest({ prompt, bundle, gameDir });
    writeFileSync(`${transcript}/system.md`, request.system, 'utf8');
    writeFileSync(`${transcript}/user.md`, request.user, 'utf8');

    process.stdout.write(`  ${prompt.id.padEnd(30)} `);

    let completion: Completion;
    let harnessError: string | undefined;
    try {
      completion = await client.complete({
        system: request.system,
        user: request.user,
        maxTokens: options.maxTokens,
      });
    } catch (err) {
      harnessError = err instanceof Error ? err.message : String(err);
      completion = { text: '', usage: NO_USAGE, stopReason: 'error' };
    }
    writeFileSync(`${transcript}/response.md`, completion.text, 'utf8');

    const parsed = parseFences(completion.text);
    const written = new Map<string, string>();
    for (const file of parsed.files) {
      writeGameFile(gameDir, file.path, file.content);
      written.set(file.path, file.content);
      writeFileSync(`${transcript}/${file.path.replaceAll('/', '__')}`, file.content, 'utf8');
    }

    const skip = new Set<StageName>(prompt.skipStages ?? []);
    let skipReason = prompt.skipReason ?? 'the prompt opted out';
    // A stage the untouched scaffold already fails measures the repository, not
    // the model, so nobody is scored on it.
    const disqualified = disqualifiedStages(workspace.baseline);
    if (disqualified.size > 0) {
      for (const name of disqualified) skip.add(name);
      skipReason = 'the untouched scaffold already fails this stage';
    }
    if (harnessError !== undefined || parsed.files.length === 0) {
      // Nothing was applied: scoring the pristine scaffold would score the
      // template, not the model. Fail the checks stage and skip the rest.
      for (const name of ['typecheck', 'unit', 'build', 'e2e'] as StageName[]) skip.add(name);
      skipReason = 'the model wrote no files';
    }
    const ctx = { gameDir, repoRoot, skip, skipReason };

    const typecheck = await stageTypecheck(ctx);
    const unit = await stageUnit(ctx);
    const build = await stageBuild(ctx);
    const e2e = await stageE2e(ctx);

    const checkResults = runChecks(prompt.checks, written);
    const checksOk =
      harnessError === undefined &&
      parsed.files.length > 0 &&
      parsed.rejected.length === 0 &&
      checkResults.every((c) => c.ok);
    const checks: StageResult = {
      name: 'checks',
      status: skip.has('checks') ? 'skipped' : checksOk ? 'pass' : 'fail',
      durationMs: 0,
      detail: checksOk
        ? undefined
        : parsed.files.length === 0
          ? `the model wrote no files (${String(parsed.blocks)} fenced block(s) seen)`
          : checkResults
              .filter((c) => !c.ok)
              .map((c) => c.detail ?? '')
              .join('\n'),
    };

    const stages = { typecheck, unit, build, e2e, checks } as const;
    const verdict = judge(stages, completion.stopReason, harnessError);
    const cost = estimateCost(client.id, completion.usage);

    const result: PromptResult = {
      id: prompt.id,
      title: prompt.title,
      model: client.id,
      provider: client.provider,
      pass: verdict.pass,
      stages,
      ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
      tokens: completion.usage,
      cost,
      durationMs: Date.now() - started,
      transcript: transcript.replace(`${here}/`, ''),
      stopReason: harnessError === undefined ? completion.stopReason : `error: ${harnessError}`,
      filesWritten: parsed.files.map((f) => f.path),
      rejectedPaths: parsed.rejected.map((r) => ({ path: r.path, reason: r.reason })),
      missingExpectedFiles: prompt.expectedFiles.filter((f) => !written.has(f)),
      checks: checkResults,
    };
    results.push(result);

    console.log(
      `${verdict.pass ? 'pass' : `FAIL (${verdict.failure ?? '?'})`}  ${formatDuration(result.durationMs)}`,
    );
    if (!options.keep) rmSync(gameDir, { recursive: true, force: true });
  }

  const finishedAt = new Date();
  const first = workspaces.values().next();
  const workspace = first.done ? undefined : first.value;
  const summary = summarise(results, skippedPrompts);
  const report: RunReport = {
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model: client.id,
    provider: client.provider,
    template: {
      name: workspace?.template.name ?? 'none',
      dir: workspace?.template.dir ?? '',
      ...(workspace?.template.substituteFor === undefined
        ? {}
        : { substituteFor: workspace.template.substituteFor }),
    },
    templateRepairs: workspace?.repairs ?? [],
    baseline: workspace?.baseline ?? CLEAN_BASELINE,
    linkMode: workspace?.linkMode ?? 'none',
    node: process.version,
    options: {
      prompts: options.prompts,
      effort: options.effort,
      wasm: process.env['GAMEABLE_LLM_EVAL_WASM'] === '1',
      e2e: process.env['GAMEABLE_LLM_EVAL_E2E'] === '1',
      dryRun: options.dryRun,
    },
    results,
    skipped: skippedPrompts,
    summary,
  };

  mkdirSync(outDir, { recursive: true });
  const jsonPath = `${outDir}/${runId}.json`;
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // A fake run has no price of its own, but its token counts are real — the
  // system prompt is the real bundle and the real source. Pricing them at the
  // default hosted model is how `--dry-run` answers "what would this cost?".
  const priceAt = client.provider === 'fake' ? DEFAULT_MODEL : client.id;
  const forecast = extrapolateCost(results, priceAt, all.length);
  const costNote =
    client.provider === 'ollama'
      ? 'A local model costs nothing per token; the cost here is wall clock.'
      : [
          client.provider === 'fake'
            ? `The fake client is free. Its token counts are real, so they are priced here at \`${priceAt}\` rates ($1/$5 per MTok) to forecast a live run.`
            : `Measured: $${summary.cost.toFixed(4)} for ${String(results.length)} prompt(s).`,
          '',
          `Extrapolated to all ${String(all.length)} prompts at \`${priceAt}\` rates:`,
          '',
          `- first call (writes the bundle into the cache): $${forecast.firstCall.toFixed(4)}`,
          `- every call after it (reads it back): $${forecast.perCachedCall.toFixed(4)}`,
          `- **full ${String(all.length)}-prompt run: $${forecast.total.toFixed(2)}**`,
        ].join('\n');

  writeFileSync(`${outDir}/latest.md`, renderScoreboard(report, { costNote }), 'utf8');

  const bar = thresholdFor(client.provider);
  console.log('');
  console.log(
    `  ${String(summary.passed)}/${String(summary.attempted)} passed (${(summary.passRate * 100).toFixed(0)}%)` +
      (bar.value === 0 ? '' : `, bar is ${(bar.value * 100).toFixed(0)}% for a ${bar.label}`),
  );
  for (const [bucket, count] of Object.entries(summary.buckets)) {
    console.log(`    ${bucket.padEnd(12)} ${String(count)}`);
  }
  console.log(`  $${summary.cost.toFixed(4)} · ${formatDuration(summary.durationMs)}`);
  if (client.provider !== 'ollama') {
    console.log(
      `  forecast: $${forecast.total.toFixed(2)} for all ${String(all.length)} prompts at ${priceAt} rates` +
        ` ($${forecast.firstCall.toFixed(4)} first call, $${forecast.perCachedCall.toFixed(4)} cached)`,
    );
  }
  console.log(`  ${jsonPath}`);
  console.log(`  ${outDir}/latest.md`);
  const redBaseline = redBaselineStages(report.baseline);
  if (redBaseline.length > 0) {
    console.log('');
    console.log(
      `  the untouched scaffold already fails ${redBaseline.join(', ')}; those stages were skipped`,
    );
    if (report.baseline.typecheck.status === 'fail') {
      console.log('  THIS RUN IS NOT VALID: fix `npm run typecheck` at the root and run it again.');
    }
  }
  console.log('');

  if (!options.keep) rmSync(runRoot, { recursive: true, force: true });
  if (report.baseline.typecheck.status === 'fail') return 2;
  return summary.attempted > 0 && summary.passed === summary.attempted ? 0 : 1;
}

/**
 * Delete the game's TypeScript so the model has to write it from the bundle.
 *
 * `src/main.ts` stays — it is the host, and it reaches the game through
 * `await import('./game')`, which is exactly the seam the task is about.
 * `src/assets.json` and the configuration stay too: the task is "write a
 * game", not "reconstruct a build system". `tests/` goes, because the
 * template's own suite imports the template's own modules by path and the
 * tsconfig includes it, which would make the typecheck stage measure the
 * deleted files rather than the model's.
 *
 * @param gameDir The scaffolded game.
 * @returns Nothing.
 */
function emptySource(gameDir: string): void {
  const src = join(gameDir, 'src');
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      rmSync(join(src, entry.name), { recursive: true, force: true });
      continue;
    }
    if (entry.name.endsWith('.ts') && entry.name !== 'vite-env.d.ts' && entry.name !== 'main.ts') {
      rmSync(join(src, entry.name), { force: true });
    }
  }
  rmSync(join(gameDir, 'tests'), { recursive: true, force: true });
}

/** True when this module was run, rather than imported by a test. */
const RUN_DIRECTLY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) {
  process.exitCode = await main(process.argv.slice(2));
}
