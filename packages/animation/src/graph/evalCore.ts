// Ported from aos-threejs-poc/packages/avataros-character-runtime/src/evalBody.js @ cdd63b10
/**
 * evalCore — the node dispatcher shared by `evalBody` and `sm`.
 *
 * The POC had `evalBody.js` and `sm.js` importing each other: `evalBody`
 * needed `createSMHandler`, `sm` needed `evaluateSubgraph`. That cycle worked
 * because both uses were call-time, but it is fragile under a bundler and hard
 * to read. The dispatcher lives here instead, so `evalBody -> evalCore` and
 * `sm -> evalCore` are both one-way. The handler-injection pattern is kept
 * exactly as the POC had it, because that is what lets the state-machine node
 * type be resolved without `evalCore` knowing about state machines.
 *
 * Contract preserved from the POC:
 *
 *  - `rt.valueCache` is per frame; the caller clears it;
 *  - `rt.rand` falls back to `() => 0.5`, a deterministic stand-in, so tests are
 *    reproducible with no mocking;
 *  - additive blend mode is NOT supported here — it throws, because additive
 *    layering is the gesture channel's job, not the base layer's;
 *  - any unrecognised node type throws.
 */
import {
  EMPTY_EDGES,
  type GraphEdge,
  type GraphNode,
  type GraphRuntime,
  numField,
  strField,
} from './types';

/** Node and edge indices for one (sub)graph. */
export interface GraphIndex {
  /** Node id to node. */
  nodeById: Map<string, GraphNode>;
  /** Target node id to the edges feeding it. */
  edgesByTarget: Map<string, GraphEdge[]>;
}

/** The accumulators an evaluation writes into. */
export interface EvalAccumulator {
  /** Clip name to summed weight. */
  weights: Map<string, number>;
  /** Clip name to loop flag; first writer wins. */
  loop: Map<string, boolean>;
  /** Clip name to time scale; first writer wins. */
  speed: Map<string, number>;
}

/**
 * A node-type override, injected to resolve `stateMachine` without a cycle.
 *
 * @param node The node being evaluated.
 * @param rt Runtime context.
 * @param acc Accumulators to write into.
 * @param masterWeight Weight inherited from the parent blend.
 * @param handlers The handler table, passed down for nested graphs.
 */
export type NodeHandler = (
  node: GraphNode,
  rt: GraphRuntime,
  acc: EvalAccumulator,
  masterWeight: number,
  handlers: NodeHandlers,
) => void;

/** Node-type overrides by node type. */
export interface NodeHandlers {
  /** Handles `stateMachine` nodes. */
  stateMachine?: NodeHandler;
}

/**
 * Build the node and edge indices for a (sub)graph.
 *
 * The raw primitive: it always builds. The per-frame path calls
 * {@link buildIndexFor} instead, which memoises this on the node array's
 * identity.
 *
 * @param nodes Nodes.
 * @param edges Edges.
 *
 * @returns The indices.
 *
 * @example
 * ```ts
 * const index = buildIndex([{ id: 'a', type: 'playClip' }], []);
 * console.log(index.nodeById.get('a')?.type); // 'playClip'
 * ```
 */
export function buildIndex(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphIndex {
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);
  const edgesByTarget = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    let bucket = edgesByTarget.get(e.target);
    if (bucket === undefined) {
      bucket = [];
      edgesByTarget.set(e.target, bucket);
    }
    bucket.push(e);
  }
  return { nodeById, edgesByTarget };
}

/** One memoised index, remembered against the edge array it was built with. */
interface CachedIndex {
  /** The edge array the index was built from. */
  edges: readonly GraphEdge[];
  /** The index itself. */
  index: GraphIndex;
}

/**
 * Indices by node-array identity.
 *
 * Both halves of the key are stable: a body graph is immutable after load, and
 * `nodeList`/`edgeList` hand back the same narrowed arrays for the same
 * authored object. So the per-frame path hits this cache every time after the
 * first frame and the evaluator builds no Maps at all.
 */
const indexCache = new WeakMap<readonly GraphNode[], CachedIndex>();

/**
 * The node and edge indices for a (sub)graph, built once per graph.
 *
 * Memoised on the identity of `nodes` (and re-checked against `edges`, so a
 * node array reused with different edges is never served a stale index). This
 * is what makes the per-frame evaluation allocation-free: `evaluateBody` and
 * every state's subgraph go through here.
 *
 * Mutating a node or edge array in place after the first evaluation will NOT be
 * picked up — see the immutability contract in `types.ts`.
 *
 * @param nodes Nodes.
 * @param edges Edges.
 *
 * @returns The indices; the SAME object on every call for the same arrays.
 *
 * @example
 * ```ts
 * const nodes = [{ id: 'a', type: 'playClip' }];
 * console.log(buildIndexFor(nodes, []) === buildIndexFor(nodes, [])); // false: edges differ
 * const edges: never[] = [];
 * console.log(buildIndexFor(nodes, edges) === buildIndexFor(nodes, edges)); // true
 * ```
 */
export function buildIndexFor(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[] = EMPTY_EDGES,
): GraphIndex {
  const cached = indexCache.get(nodes);
  if (cached !== undefined && cached.edges === edges) return cached.index;
  const index = buildIndex(nodes, edges);
  indexCache.set(nodes, { edges, index });
  return index;
}

/**
 * The resolved output node per node array; `null` means "looked, found none".
 *
 * A `WeakMap` cannot tell a miss from a cached `undefined`, hence the explicit
 * null. The lookups below are written as plain loops rather than `Array.find`
 * with a predicate, because a predicate closure is an allocation per call and
 * these run every frame.
 */
const outputNodeCache = new WeakMap<readonly GraphNode[], GraphNode | null>();

/** The same, per node array and per node type. */
const typeNodeCache = new WeakMap<readonly GraphNode[], Map<string, GraphNode | null>>();

/**
 * The node a (sub)graph's output edge hangs off, memoised per node array.
 *
 * @param nodes The (sub)graph's nodes.
 *
 * @returns The `output` / `stateOutput` node, or undefined when there is none.
 *
 * @example
 * ```ts
 * const nodes = [{ id: 'output', type: 'stateOutput' }];
 * console.log(findOutputNode(nodes)?.id); // 'output'
 * ```
 */
export function findOutputNode(nodes: readonly GraphNode[]): GraphNode | undefined {
  const cached = outputNodeCache.get(nodes);
  if (cached !== undefined) return cached ?? undefined;
  let found: GraphNode | null = null;
  for (const node of nodes) {
    if (node.id === 'output' || node.type === 'stateOutput') {
      found = node;
      break;
    }
  }
  outputNodeCache.set(nodes, found);
  return found ?? undefined;
}

/**
 * The first node of a given type, memoised per node array.
 *
 * @param nodes The (sub)graph's nodes.
 * @param type The node type to find, e.g. `finalPose`.
 *
 * @returns The node, or undefined when the graph has none.
 *
 * @example
 * ```ts
 * const nodes = [{ id: 'final', type: 'finalPose' }];
 * console.log(findNodeOfType(nodes, 'finalPose')?.id); // 'final'
 * ```
 */
export function findNodeOfType(nodes: readonly GraphNode[], type: string): GraphNode | undefined {
  let byType = typeNodeCache.get(nodes);
  if (byType === undefined) {
    byType = new Map<string, GraphNode | null>();
    typeNodeCache.set(nodes, byType);
  }
  const cached = byType.get(type);
  if (cached !== undefined) return cached ?? undefined;
  let found: GraphNode | null = null;
  for (const node of nodes) {
    if (node.type === type) {
      found = node;
      break;
    }
  }
  byType.set(type, found);
  return found ?? undefined;
}

/**
 * The edge feeding `targetId` through `handle`.
 *
 * @param index Graph index.
 * @param targetId Target node id.
 * @param handle Target handle.
 *
 * @returns The edge, or undefined.
 */
export function findEdgeByHandle(
  index: GraphIndex,
  targetId: string,
  handle: string,
): GraphEdge | undefined {
  const bucket = index.edgesByTarget.get(targetId);
  if (bucket === undefined) return undefined;
  for (const e of bucket) if (e.targetHandle === handle) return e;
  return undefined;
}

/**
 * The first edge feeding `targetId`, whatever its handle.
 *
 * @param index Graph index.
 * @param targetId Target node id.
 *
 * @returns The edge, or undefined.
 */
export function firstEdgeInto(index: GraphIndex, targetId: string): GraphEdge | undefined {
  return index.edgesByTarget.get(targetId)?.[0];
}

/**
 * Evaluate a value-producing node to a number.
 *
 * Only `getVariable` and `random` produce values; anything else caches 0.
 *
 * @param nodeId Node to evaluate.
 * @param index Graph index.
 * @param rt Runtime context.
 *
 * @returns The value.
 */
export function evaluateValue(nodeId: string, index: GraphIndex, rt: GraphRuntime): number {
  const cached = rt.valueCache.get(nodeId);
  if (cached !== undefined) return cached;

  const node = index.nodeById.get(nodeId);
  let value = 0;

  if (node?.type === 'getVariable') {
    const name = strField(node.data, 'variableName');
    const raw = name === null ? undefined : rt.variables.get(name);
    value = Number(raw);
    if (!Number.isFinite(value)) value = 0;
    rt.valueCache.set(nodeId, value);
    return value;
  }

  if (node?.type === 'random') {
    const min = numField(node.data, 'min', 0);
    const max = numField(node.data, 'max', 1);
    const randomType = strField(node.data, 'randomType') ?? 'float';
    const sticky = rt.sticky.get(nodeId);
    if (
      sticky !== undefined &&
      sticky.min === min &&
      sticky.max === max &&
      sticky.randomType === randomType
    ) {
      value = sticky.value;
    } else {
      const draw = (rt.rand ?? (() => 0.5))();
      value =
        randomType === 'int'
          ? Math.floor(draw * (Math.floor(max) - Math.ceil(min) + 1)) + Math.ceil(min)
          : draw * (max - min) + min;
      rt.sticky.set(nodeId, { value, min, max, randomType });
    }
    rt.valueCache.set(nodeId, value);
    return value;
  }

  rt.valueCache.set(nodeId, value);
  return value;
}

/**
 * Recursively evaluate a pose node, accumulating clip weights.
 *
 * @param nodeId Node to evaluate.
 * @param index Graph index.
 * @param rt Runtime context.
 * @param acc Accumulators to write into.
 * @param masterWeight Weight inherited from the parent blend.
 * @param handlers Node-type overrides.
 */
export function evaluateNode(
  nodeId: string,
  index: GraphIndex,
  rt: GraphRuntime,
  acc: EvalAccumulator,
  masterWeight: number,
  handlers: NodeHandlers,
): void {
  const node = index.nodeById.get(nodeId);
  if (node === undefined) return;

  switch (node.type) {
    case 'playClip': {
      const clipName = strField(node.data, 'clipName');
      if (clipName !== null) {
        acc.weights.set(clipName, (acc.weights.get(clipName) ?? 0) + masterWeight);
        // First-writer-wins per clip, matching the POC's GraphEvaluator: two
        // branches of a blend can name the same clip, and the first one to
        // claim it owns its loop and speed.
        if (!acc.loop.has(clipName)) acc.loop.set(clipName, node.data?.loop === true);
        if (!acc.speed.has(clipName)) {
          const raw = numField(node.data, 'playSpeed', 1);
          acc.speed.set(clipName, raw > 0 ? raw : 1);
        }
      }
      return;
    }

    case 'blend': {
      if (strField(node.data, 'blendMode') === 'additive') {
        throw new Error(
          'evaluateBody: additive blend is not a base-layer mode; layer it through the gesture channel',
        );
      }

      // Alpha resolution order: wired input > alphaVariable > data.alpha > 0.5.
      let alpha = numField(node.data, 'alpha', 0.5);
      const alphaEdge = findEdgeByHandle(index, nodeId, 'alpha-in');
      if (alphaEdge !== undefined) {
        alpha = evaluateValue(alphaEdge.source, index, rt);
      } else {
        const alphaVariable = strField(node.data, 'alphaVariable');
        if (alphaVariable !== null) {
          const varVal = rt.variables.get(alphaVariable);
          if (varVal !== undefined && varVal !== null) {
            const n = Number(varVal);
            alpha = Number.isFinite(n) ? n : 0;
          }
        }
      }

      const aEdge = findEdgeByHandle(index, nodeId, 'a');
      const bEdge = findEdgeByHandle(index, nodeId, 'b');
      if (aEdge !== undefined) {
        evaluateNode(aEdge.source, index, rt, acc, masterWeight * (1 - alpha), handlers);
      }
      if (bEdge !== undefined) {
        evaluateNode(bEdge.source, index, rt, acc, masterWeight * alpha, handlers);
      }
      return;
    }

    case 'select': {
      const idxEdge = findEdgeByHandle(index, nodeId, 'in-index');
      let idx = numField(node.data, 'index', 0);
      if (idxEdge !== undefined) idx = Math.round(evaluateValue(idxEdge.source, index, rt));
      const optionCount = numField(node.data, 'optionCount', 2);
      const clamped = Math.max(0, Math.min(optionCount - 1, Math.round(idx)));
      const optionEdge = findEdgeByHandle(index, nodeId, `option-${String(clamped)}`);
      if (optionEdge !== undefined) {
        evaluateNode(optionEdge.source, index, rt, acc, masterWeight, handlers);
      }
      return;
    }

    // getVariable and random are value nodes. In practice they are only reached
    // through evaluateValue, but a graph may wire one into a pose input; the
    // POC fell through silently there and so do we.
    case 'getVariable':
    case 'random':
      return;

    case 'stateMachine': {
      const handler = handlers.stateMachine;
      if (handler === undefined) {
        throw new Error('evaluateBody: no stateMachine handler was injected');
      }
      handler(node, rt, acc, masterWeight, handlers);
      return;
    }

    // Terminals: the caller already resolved the edge into their output.
    case 'stateOutput':
    case 'finalPose':
      return;

    default:
      throw new Error(`evaluateBody: unsupported node type "${node.type}"`);
  }
}

/**
 * Evaluate an inner state graph into the caller's accumulators.
 *
 * @param nodes Inner nodes.
 * @param edges Inner edges.
 * @param rt Runtime context.
 * @param acc Accumulators, shared with the parent.
 * @param masterWeight Weight inherited from the parent.
 * @param handlers Node-type overrides.
 */
export function evaluateSubgraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  rt: GraphRuntime,
  acc: EvalAccumulator,
  masterWeight: number,
  handlers: NodeHandlers,
): void {
  if (nodes.length === 0) return;
  const index = buildIndexFor(nodes, edges);
  const outputNode = findOutputNode(nodes);
  if (outputNode === undefined) return;
  const outputEdge = firstEdgeInto(index, outputNode.id);
  if (outputEdge === undefined) return;
  evaluateNode(outputEdge.source, index, rt, acc, masterWeight, handlers);
}
