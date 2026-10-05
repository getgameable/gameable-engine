// Ported from aos-threejs-poc/packages/avataros-character-runtime/src/rules.js @ cdd63b10
/**
 * rules — the transition-rule evaluator.
 *
 * Differences from the POC app version, kept from its own port notes:
 *
 *  - variables come from `ctx.variables` (no global `animVariables` import);
 *  - clip timings come from `ctx.clipTimings[ctx.currentClipName]` (no
 *    `debugState` import);
 *  - an unknown rule node type throws rather than returning null, because a
 *    typo in a graph that silently evaluates to "false forever" is a state
 *    machine that never transitions and no error to explain it.
 *
 * Rule node types: `varGet`, `ruleAnimTimeRemaining`, `ruleAnimTimeRatio`,
 * `ruleCompare`, `ruleNot`, `ruleAnd`, `ruleOr`, `ruleResult`.
 */
import { type ClipTiming, EMPTY_EDGES, type GraphEdge, type GraphNode, strField } from './types';

/** A rule graph: a `ruleResult` node plus everything feeding it. */
export interface RuleGraph {
  /** Nodes, in no particular order. */
  nodes: readonly GraphNode[];
  /** Edges, in no particular order. */
  edges?: readonly GraphEdge[];
}

/** What a rule graph is allowed to read. */
export interface RuleContext {
  /** Blueprint variables. */
  variables?: ReadonlyMap<string, unknown>;
  /** Clip timings by clip name. */
  clipTimings?: ReadonlyMap<string, ClipTiming>;
  /** The clip the current state is playing, which the anim-time nodes read. */
  currentClipName?: string | null;
}

/**
 * Index edges by the node they target.
 *
 * @param edges Graph edges.
 *
 * @returns Target node id to the edges feeding it.
 */
function buildEdgesByTarget(edges: readonly GraphEdge[]): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    let bucket = map.get(edge.target);
    if (bucket === undefined) {
      bucket = [];
      map.set(edge.target, bucket);
    }
    bucket.push(edge);
  }
  return map;
}

/**
 * The source node id feeding `nodeId` through `handle`.
 *
 * @param edgesByTarget Index from {@link buildEdgesByTarget}.
 * @param nodeId Target node id.
 * @param handle Target handle, or undefined to take the first edge.
 *
 * @returns The source node id, or null.
 */
function inputSource(
  edgesByTarget: ReadonlyMap<string, GraphEdge[]>,
  nodeId: string,
  handle?: string,
): string | null {
  // `?? EMPTY_EDGES`, not `?? []`: a rule graph is walked once per transition
  // edge per frame and most nodes have no incoming edge, so a fresh array per
  // miss was the single most frequent allocation in the state machine.
  const candidates = edgesByTarget.get(nodeId) ?? EMPTY_EDGES;
  if (handle === undefined) return candidates[0]?.source ?? null;
  for (const edge of candidates) if (edge.targetHandle === handle) return edge.source;
  return null;
}

/**
 * Unreal-parity loose equality, the `==` the POC deliberately used.
 *
 * Blueprint variables are untyped: a checkbox writes `true`, a text field
 * writes `"1"`, a slider writes `1`. Strict equality would make the same graph
 * behave differently depending on which editor widget last wrote the variable,
 * so the comparison coerces exactly the way `==` did.
 *
 * @param a Left operand.
 * @param b Right operand.
 *
 * @returns Whether the two are loosely equal.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const aNil = a === null || a === undefined;
  const bNil = b === null || b === undefined;
  if (aNil || bNil) return aNil && bNil; // `null == undefined` is true
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) === Number(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  // Two objects are only loosely equal when they are the same reference, which
  // the identity check above already covered.
  return false;
}

/**
 * Evaluate one rule node.
 *
 * @param nodeId Node to evaluate.
 * @param nodeById Node index.
 * @param edgesByTarget Edge index.
 * @param ctx Rule context.
 *
 * @returns The node's value: a number, a boolean, an arbitrary variable value,
 *   or null when the node or its input is missing.
 */
function evalNode(
  nodeId: string,
  nodeById: ReadonlyMap<string, GraphNode>,
  edgesByTarget: ReadonlyMap<string, GraphEdge[]>,
  ctx: RuleContext,
): unknown {
  const node = nodeById.get(nodeId);
  if (node === undefined) return null;

  switch (node.type) {
    case 'varGet': {
      const varName = strField(node.data, 'varName');
      if (varName === null) return null;
      return ctx.variables?.get(varName) ?? null;
    }

    case 'ruleAnimTimeRemaining':
      return currentTiming(ctx)?.remaining ?? 999;

    case 'ruleAnimTimeRatio':
      return currentTiming(ctx)?.ratio ?? 0;

    case 'ruleNot': {
      const src = inputSource(edgesByTarget, nodeId, 'in');
      if (src === null) return null;
      const val = evalNode(src, nodeById, edgesByTarget, ctx);
      return val === null ? null : !val;
    }

    case 'ruleAnd': {
      const a = branch(edgesByTarget, nodeId, 'a', nodeById, ctx);
      const b = branch(edgesByTarget, nodeId, 'b', nodeById, ctx);
      return Boolean(a) && Boolean(b);
    }

    case 'ruleOr': {
      const a = branch(edgesByTarget, nodeId, 'a', nodeById, ctx);
      const b = branch(edgesByTarget, nodeId, 'b', nodeById, ctx);
      return Boolean(a) || Boolean(b);
    }

    case 'ruleCompare': {
      const src = inputSource(edgesByTarget, nodeId, 'value');
      if (src === null) return false;
      const val = evalNode(src, nodeById, edgesByTarget, ctx);
      if (val === null) return false;
      const op = strField(node.data, 'operator') ?? '==';
      const rawThreshold = node.data?.threshold;
      const threshold = typeof rawThreshold === 'number' ? rawThreshold : 0;
      switch (op) {
        case '==':
          return looseEquals(val, threshold);
        case '!=':
          return !looseEquals(val, threshold);
        case '>':
          return Number(val) > threshold;
        case '<':
          return Number(val) < threshold;
        case '>=':
          return Number(val) >= threshold;
        case '<=':
          return Number(val) <= threshold;
        default:
          return false;
      }
    }

    case 'ruleResult': {
      // Terminal node — evaluate its single input with no handle filter.
      const src = inputSource(edgesByTarget, nodeId);
      if (src === null) return false;
      return evalNode(src, nodeById, edgesByTarget, ctx);
    }

    default:
      throw new Error(`evaluateRule: unsupported rule node type "${node.type}"`);
  }
}

/**
 * The timing of the clip the current state is playing.
 *
 * @param ctx Rule context.
 *
 * @returns The timing, or undefined when no clip is named or tracked.
 */
function currentTiming(ctx: RuleContext): ClipTiming | undefined {
  const name = ctx.currentClipName;
  if (name === null || name === undefined) return undefined;
  return ctx.clipTimings?.get(name);
}

/**
 * Evaluate one input of a boolean node, defaulting to `false` when unwired.
 *
 * @param edgesByTarget Edge index.
 * @param nodeId Target node id.
 * @param handle Target handle.
 * @param nodeById Node index.
 * @param ctx Rule context.
 *
 * @returns The branch value, or false.
 */
function branch(
  edgesByTarget: ReadonlyMap<string, GraphEdge[]>,
  nodeId: string,
  handle: string,
  nodeById: ReadonlyMap<string, GraphNode>,
  ctx: RuleContext,
): unknown {
  const src = inputSource(edgesByTarget, nodeId, handle);
  return src === null ? false : evalNode(src, nodeById, edgesByTarget, ctx);
}

/** A rule graph's two indices, built once. */
interface RuleIndex {
  /** Node id to node. */
  nodeById: Map<string, GraphNode>;
  /** Target node id to the edges feeding it. */
  edgesByTarget: Map<string, GraphEdge[]>;
}

/**
 * Rule indices by rule-graph identity.
 *
 * A state machine evaluates every outgoing transition edge's rule graph every
 * frame. Rebuilding two Maps per edge per frame was pure garbage; `ruleGraphOf`
 * in `sm.ts` hands back the same `RuleGraph` object for the same authored edge
 * data, so this hits from the second frame on.
 */
const ruleIndexCache = new WeakMap<RuleGraph, RuleIndex>();

/**
 * Evaluate a rule graph to a boolean.
 *
 * The graph's indices are memoised on its identity, so a rule graph is treated
 * as IMMUTABLE once evaluated — the same contract the body graph carries.
 *
 * @param graph The rule graph.
 * @param ctx What the graph may read; see {@link RuleContext}.
 *
 * @returns Whether the rule fired.
 */
export function evaluateRule(graph: RuleGraph, ctx: RuleContext = {}): boolean {
  const nodes = graph.nodes;
  if (nodes.length === 0) return false;

  let index = ruleIndexCache.get(graph);
  if (index === undefined) {
    const nodeById = new Map<string, GraphNode>();
    for (const n of nodes) nodeById.set(n.id, n);
    index = { nodeById, edgesByTarget: buildEdgesByTarget(graph.edges ?? EMPTY_EDGES) };
    ruleIndexCache.set(graph, index);
  }

  if (!index.nodeById.has('ruleResult')) return false;
  return Boolean(evalNode('ruleResult', index.nodeById, index.edgesByTarget, ctx));
}
