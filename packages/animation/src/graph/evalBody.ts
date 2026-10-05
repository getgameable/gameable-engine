// Ported from aos-threejs-poc/packages/avataros-character-runtime/src/evalBody.js @ cdd63b10
/**
 * evalBody — evaluate a body blueprint graph into clip weights.
 *
 * Produces `{ weights, loop, speed }`, all keyed by clip name. The POC returned
 * plain objects; Maps are used here so a clip name can be any string (a clip
 * called `constructor` used to be a real bug) and so the accumulators can be
 * reused across frames without `delete`.
 *
 * The accumulators are an explicit out-parameter so the per-frame path in
 * {@link createAnimator} allocates nothing: pass the same
 * {@link EvalAccumulator} every frame and it is cleared and refilled.
 *
 * Nothing else here allocates either: the node/edge index and the `finalPose`
 * lookup are memoised on the graph's identity, which is why a graph must be
 * treated as immutable once it has been evaluated (see `types.ts`).
 */
import {
  buildIndexFor,
  type EvalAccumulator,
  evaluateNode,
  findNodeOfType,
  firstEdgeInto,
  type NodeHandlers,
} from './evalCore';
import { createSMHandler } from './sm';
import {
  type BodyGraph,
  type ClipTiming,
  type GraphRuntime,
  type SMState,
  type StickyRandom,
} from './types';

export type { EvalAccumulator, NodeHandlers } from './evalCore';

/**
 * Create the accumulators an evaluation writes into.
 *
 * @returns Empty accumulators, ready to be reused every frame.
 */
export function createEvalAccumulator(): EvalAccumulator {
  return {
    weights: new Map<string, number>(),
    loop: new Map<string, boolean>(),
    speed: new Map<string, number>(),
  };
}

/** Options for {@link createGraphRuntime}. */
export interface GraphRuntimeOptions {
  /** Millisecond clock. */
  now: () => number;
  /** Uniform `[0, 1)` source; omit for the deterministic 0.5 stand-in. */
  rand?: () => number;
  /** Initial blueprint variables. */
  variables?: Iterable<readonly [string, unknown]>;
}

/**
 * Create the runtime context the evaluator reads and mutates.
 *
 * @param options See {@link GraphRuntimeOptions}.
 *
 * @returns A fresh {@link GraphRuntime}.
 */
export function createGraphRuntime(options: GraphRuntimeOptions): GraphRuntime {
  return {
    now: options.now,
    variables: new Map<string, unknown>(options.variables ?? []),
    sticky: new Map<string, StickyRandom>(),
    valueCache: new Map<string, number>(),
    sm: new Map<string, SMState>(),
    clipTimings: new Map<string, ClipTiming>(),
    rand: options.rand,
  };
}

/** The state-machine handler table, built once and reused. */
const DEFAULT_HANDLERS: NodeHandlers = { stateMachine: createSMHandler() };

/**
 * Evaluate a body graph for one frame.
 *
 * @param graph The graph. Its `finalPose` node is the root; the first edge into
 *   it is the pose that is evaluated. Treated as IMMUTABLE: its index is
 *   memoised on its identity, so an in-place edit is not re-read. Pass a new
 *   graph object to change the graph.
 * @param rt Runtime context; `valueCache` is cleared here, because one call is
 *   one logical frame and stale cache entries would freeze a wired alpha.
 * @param out Accumulators to fill. Cleared first. Omit to allocate fresh ones.
 * @param handlers Node-type overrides; defaults to the built-in state machine.
 *
 * @returns `out`, or the freshly allocated accumulators.
 */
export function evaluateBody(
  graph: BodyGraph,
  rt: GraphRuntime,
  out: EvalAccumulator = createEvalAccumulator(),
  handlers: NodeHandlers = DEFAULT_HANDLERS,
): EvalAccumulator {
  rt.valueCache.clear();
  out.weights.clear();
  out.loop.clear();
  out.speed.clear();

  const finalNode = findNodeOfType(graph.nodes, 'finalPose');
  if (finalNode === undefined) return out;

  const index = buildIndexFor(graph.nodes, graph.edges);
  const finalEdge = firstEdgeInto(index, finalNode.id);
  if (finalEdge === undefined) return out;

  evaluateNode(finalEdge.source, index, rt, out, 1, handlers);
  return out;
}
