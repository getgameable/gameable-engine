/**
 * The one thing every model in the eval has in common: text in, text out.
 *
 * Three implementations ship here — a hosted Anthropic model, a local Ollama
 * model, and a canned fake. The runner only ever sees {@link ModelClient}, so
 * a run is a fair comparison: same bundle, same prompt, same scoring.
 *
 * **Nothing in this file makes a paid call unless `GAMEABLE_LLM_EVAL_LIVE=1` is
 * set.** {@link createAnthropicClient} refuses to construct otherwise, so a
 * test, a `--dry-run`, or a distracted afternoon cannot spend money.
 */

/** What one completion cost, in tokens. */
export interface Usage {
  /** Uncached input tokens, billed at the full input rate. */
  readonly inputTokens: number;
  /** Generated tokens. */
  readonly outputTokens: number;
  /** Input tokens served from the prompt cache, billed at ~0.1x. */
  readonly cacheReadTokens: number;
  /** Input tokens written to the prompt cache, billed at ~1.25x. */
  readonly cacheCreationTokens: number;
}

/** An empty usage record, for clients that do not report one. */
export const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** One prompt, already assembled. */
export interface CompletionRequest {
  /** The docs bundle plus the game's current files. Cached when the provider can. */
  readonly system: string;
  /** The task and the output contract. */
  readonly user: string;
  /** Output ceiling. Defaults to 64000 on Anthropic, the server default elsewhere. */
  readonly maxTokens?: number;
}

/** What came back. */
export interface Completion {
  /** Every text block, concatenated. */
  readonly text: string;
  /** Token counts, zeroed when the provider does not report them. */
  readonly usage: Usage;
  /**
   * Why generation stopped. `max_tokens` means truncated and `refusal` means
   * declined; the scorer buckets both separately from a wrong answer.
   */
  readonly stopReason: string;
}

/** Which family a client belongs to. Recorded in the result file. */
export type Provider = 'anthropic' | 'ollama' | 'fake';

/** The interface the runner codes against. */
export interface ModelClient {
  /** Model id, as it appears in the result file name. */
  readonly id: string;
  /** Which family this client talks to. */
  readonly provider: Provider;
  /** Send one prompt. Never throws for a refusal — that comes back as a stop reason. */
  complete(req: CompletionRequest): Promise<Completion>;
}

/** Dollars per million tokens, input and output, for the models the eval runs. */
export const PRICING: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
};

/** Effort levels the non-Haiku models accept. */
export type Effort = 'low' | 'medium' | 'high';

/**
 * What one completion cost in dollars.
 *
 * Cache reads bill at a tenth of the input rate and cache writes at one and a
 * quarter, which is the whole reason the bundle goes in `system`. A local
 * model costs nothing and returns 0.
 *
 * @param model Model id.
 * @param usage Token counts from {@link Completion}.
 * @returns Dollars, or 0 when the model has no published price here.
 */
export function estimateCost(model: string, usage: Usage): number {
  const price = PRICING[model];
  if (price === undefined) return 0;
  const input = usage.inputTokens + usage.cacheReadTokens * 0.1 + usage.cacheCreationTokens * 1.25;
  return (input * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** The model the eval reports as "the small hosted model". */
export const DEFAULT_MODEL = 'claude-haiku-4-5';

/** Models that reject `output_config.effort` and any thinking parameter. */
const NO_EFFORT = new Set(['claude-haiku-4-5']);

/** Options for {@link createAnthropicClient}. */
export interface AnthropicOptions {
  /** `claude-haiku-4-5` (the default), `claude-sonnet-5` or `claude-opus-5`. */
  readonly model: string;
  /** Ignored on Haiku, which rejects it. Defaults to `medium`, for cost. */
  readonly effort?: Effort;
  /** How many times to ride out a 429 before giving up. Default 4. */
  readonly maxRateLimitRetries?: number;
}

/**
 * The hosted path.
 *
 * Refuses to construct unless `GAMEABLE_LLM_EVAL_LIVE=1`. That is the only guard
 * between a `--dry-run` and a bill, so it lives here rather than in the CLI.
 *
 * @param options Model and effort.
 * @returns A client that streams one message per call.
 */
export function createAnthropicClient(options: AnthropicOptions): ModelClient {
  if (process.env.GAMEABLE_LLM_EVAL_LIVE !== '1') {
    throw new Error(
      'refusing to make a paid API call: set GAMEABLE_LLM_EVAL_LIVE=1 to allow live runs, ' +
        'or pass --dry-run / --provider fake to stay offline.',
    );
  }
  const model = options.model;
  const effort = options.effort ?? 'medium';
  const retries = options.maxRateLimitRetries ?? 4;

  /** Constructed once, on the first call, so importing this module stays free. */
  let clientPromise: Promise<AnthropicLike> | undefined;

  /**
   * The SDK client and its error classes, loaded lazily.
   *
   * @returns The client plus the two error constructors the runner cares about.
   */
  async function getClient(): Promise<AnthropicLike> {
    clientPromise ??= (async (): Promise<AnthropicLike> => {
      const mod = await import('@anthropic-ai/sdk');
      const Anthropic = mod.default;
      // Zero-arg: picks up ANTHROPIC_API_KEY or an `ant auth login` profile.
      return { client: new Anthropic(), RateLimitError: Anthropic.RateLimitError };
    })();
    return clientPromise;
  }

  return {
    id: model,
    provider: 'anthropic',
    async complete(req: CompletionRequest): Promise<Completion> {
      const { client, RateLimitError } = await getClient();
      const params: Record<string, unknown> = {
        model,
        max_tokens: req.maxTokens ?? 64_000,
        // One cached block. The bundle is ~60 KB and identical for every
        // prompt in a run, so every call after the first reads it back.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
      };
      if (!NO_EFFORT.has(model)) {
        params['thinking'] = { type: 'adaptive' };
        params['output_config'] = { effort };
      }

      for (let attempt = 0; ; attempt += 1) {
        try {
          const stream = client.messages.stream(params);
          const msg = await stream.finalMessage();
          return {
            text: msg.content
              .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
              .map((block) => block.text)
              .join(''),
            usage: {
              inputTokens: msg.usage.input_tokens ?? 0,
              outputTokens: msg.usage.output_tokens ?? 0,
              cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
            },
            stopReason: msg.stop_reason ?? 'unknown',
          };
        } catch (err) {
          if (err instanceof RateLimitError && attempt < retries) {
            const waitMs = 2 ** attempt * 1000 + Math.round(Math.random() * 500);
            console.warn(`  rate limited; retrying in ${String(waitMs)} ms`);
            await sleep(waitMs);
            continue;
          }
          throw err;
        }
      }
    },
  };
}

/** The slice of the SDK this file uses, so the import can stay dynamic. */
interface AnthropicLike {
  readonly client: {
    messages: {
      stream(params: Record<string, unknown>): {
        finalMessage(): Promise<{
          content: readonly { type: string; text?: string }[];
          usage: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number | null;
            cache_creation_input_tokens?: number | null;
          };
          stop_reason?: string | null;
        }>;
      };
    };
  };
  readonly RateLimitError: new (...args: never[]) => Error;
}

/** Options for {@link createOllamaClient}. */
export interface OllamaOptions {
  /** An Ollama model tag, e.g. `llama3.1:8b` or `qwen2.5-coder:7b`. */
  readonly model: string;
  /** Where the daemon listens. Default `http://localhost:11434`. */
  readonly baseUrl?: string;
  /** Per-request timeout in ms. A 7–8B model on CPU is slow. Default 10 minutes. */
  readonly timeoutMs?: number;
}

/**
 * The local path: Ollama's **native** chat API, not an OpenAI-compatible shim.
 *
 * The shim silently drops fields and normalises errors, which is exactly the
 * information the eval exists to collect.
 *
 * @param options Model tag and daemon address.
 * @returns A client that POSTs one non-streaming chat request per call.
 */
export function createOllamaClient(options: OllamaOptions): ModelClient {
  const baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 600_000;

  return {
    id: options.model,
    provider: 'ollama',
    async complete(req: CompletionRequest): Promise<Completion> {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          ...(req.maxTokens === undefined ? {} : { options: { num_predict: req.maxTokens } }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `ollama ${String(response.status)} ${response.statusText}: ${await response.text()}`,
        );
      }
      const body = (await response.json()) as OllamaChatResponse;
      return {
        text: body.message?.content ?? '',
        usage: {
          inputTokens: body.prompt_eval_count ?? 0,
          outputTokens: body.eval_count ?? 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        stopReason: normaliseOllamaStop(body.done_reason),
      };
    },
  };
}

/** The fields of Ollama's `/api/chat` response the harness reads. */
interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly done_reason?: string;
}

/**
 * Map Ollama's `done_reason` onto the Anthropic vocabulary the scorer buckets.
 *
 * @param reason What the daemon said, if anything.
 * @returns `end_turn`, `max_tokens`, or the raw value.
 */
function normaliseOllamaStop(reason: string | undefined): string {
  if (reason === undefined || reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  return reason;
}

/**
 * What a fake client should say. A string answers every prompt; a record keys
 * answers by prompt id; a function gets the whole request.
 */
export type FakeScript =
  | string
  | readonly string[]
  | Readonly<Record<string, string | FakeReply>>
  | ((req: CompletionRequest, call: number) => string | FakeReply);

/** A scripted reply with its stop reason and usage spelled out. */
export interface FakeReply {
  /** The response body, normally one or more fenced file blocks. */
  readonly text: string;
  /** Defaults to `end_turn`. Set `refusal` or `max_tokens` to exercise those paths. */
  readonly stopReason?: string;
  /** Defaults to a token count derived from the text length. */
  readonly usage?: Usage;
}

/**
 * A deterministic client with no network, no key and no cost.
 *
 * Used by every test and by `--dry-run`. A record script is keyed by prompt
 * id, which the runner puts on the first line of the user message as
 * `task-id: <id>`; an array script is consumed in call order.
 *
 * @param script Canned responses.
 * @param id What to record as the model id. Default `fake`.
 * @returns A client that answers from the script.
 */
export function createFakeClient(script: FakeScript, id = 'fake'): ModelClient {
  let call = 0;
  return {
    id,
    provider: 'fake',
    complete(req: CompletionRequest): Promise<Completion> {
      const index = call;
      call += 1;
      const picked = pick(script, req, index);
      const reply: FakeReply = typeof picked === 'string' ? { text: picked } : picked;
      const text = reply.text;
      return Promise.resolve({
        text,
        usage: reply.usage ?? {
          // A rough but honestly *shaped* stand-in, so an offline run can still
          // forecast a live one: four characters to a token, the cached system
          // prompt counted once as a write and thereafter as a read, and
          // `inputTokens` carrying only what was not cached — which is exactly
          // how the real API reports it.
          inputTokens: Math.ceil(req.user.length / 4),
          outputTokens: Math.ceil(text.length / 4),
          cacheReadTokens: index === 0 ? 0 : Math.ceil(req.system.length / 4),
          cacheCreationTokens: index === 0 ? Math.ceil(req.system.length / 4) : 0,
        },
        stopReason: reply.stopReason ?? 'end_turn',
      });
    },
  };
}

/**
 * Resolve one entry of a {@link FakeScript}.
 *
 * @param script The script.
 * @param req The request being answered.
 * @param call Zero-based call index.
 * @returns The reply for this call.
 */
function pick(script: FakeScript, req: CompletionRequest, call: number): string | FakeReply {
  if (typeof script === 'function') return script(req, call);
  if (typeof script === 'string') return script;
  if (Array.isArray(script)) {
    const entry = (script as readonly string[])[call];
    if (entry === undefined)
      throw new Error(`fake client ran out of script at call ${String(call)}`);
    return entry;
  }
  const id = /^task-id:\s*(\S+)/m.exec(req.user)?.[1];
  const table = script as Readonly<Record<string, string | FakeReply>>;
  const entry = (id === undefined ? undefined : table[id]) ?? table['*'];
  if (entry === undefined) {
    throw new Error(`fake client has no scripted answer for task-id ${id ?? '(none)'}`);
  }
  return entry;
}

/**
 * Wait.
 *
 * @param ms Milliseconds.
 * @returns A promise that settles after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
