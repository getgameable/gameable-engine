/**
 * Shared node/edge shapes and unknown-safe field readers for the body graph.
 *
 * Graph JSON is authored content — it arrives from a bundle, a save file or a
 * network response — so every `data` field is `unknown` and is narrowed at the
 * point of use. Nothing in this package trusts a graph enough to cast it.
 *
 * Narrowing is not free, and the evaluator asks the same questions of the same
 * objects sixty times a second, so every reader that builds an array or an
 * index memoises it on the IDENTITY of the authored object. That makes one
 * contract load-bearing: **a graph is immutable once it has been handed to the
 * evaluator.** Editing a node array in place will not be seen; hand over a new
 * graph object instead (`Animator.setGraph`), which is free — the caches are
 * `WeakMap`s and the old graph's entries go with it.
 */
import type { Clock } from '../clock';

/** A node's authored payload: arbitrary JSON. */
export type GraphNodeData = Readonly<Record<string, unknown>>;

/** One node of a body or rule graph. */
export interface GraphNode {
  /** Unique within its (sub)graph. */
  id: string;
  /** Node type, e.g. `playClip`, `blend`, `stateMachine`, `ruleCompare`. */
  type: string;
  /** Authored payload. */
  data?: GraphNodeData;
}

/** One edge of a body or rule graph. */
export interface GraphEdge {
  /** Optional identity; unused by the evaluator. */
  id?: string;
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Which input of the target this edge feeds, e.g. `a`, `b`, `alpha-in`. */
  targetHandle?: string;
  /** Authored payload; a transition edge carries its `ruleGraph` here. */
  data?: GraphNodeData;
}

/** A body graph: the `finalPose` node plus everything feeding it. */
export interface BodyGraph {
  /** Nodes, in no particular order. */
  nodes: readonly GraphNode[];
  /** Edges, in no particular order. */
  edges: readonly GraphEdge[];
}

/** How far through a clip the mixer currently is; the input rules read. */
export interface ClipTiming {
  /** Current time in seconds. */
  time: number;
  /** Clip length in seconds. */
  duration: number;
  /** Seconds left before the clip ends. */
  remaining: number;
  /** `time / duration`, in `[0, 1)`. */
  ratio: number;
}

/** A sticky random draw, held until its bounds change or its state is re-entered. */
export interface StickyRandom {
  /** The drawn value. */
  value: number;
  /** Lower bound the draw was made against. */
  min: number;
  /** Upper bound the draw was made against. */
  max: number;
  /** `float` or `int`. */
  randomType: string;
}

/** Per-state-machine runtime state, keyed by the state-machine node's id. */
export interface SMState {
  /** Current state node id, or null before the entry transition runs. */
  currentState: string | null;
  /** Clock reading when the current state was entered. */
  stateEnteredAt: number;
  /** The in-flight crossfade, or null. */
  transition: SMTransition | null;
  /** The clip drawn for the current state, for legacy states with no subgraph. */
  pickedClip: string | null;
}

/** An in-flight crossfade between two states. */
export interface SMTransition {
  /** State being left. */
  from: string;
  /** State being entered. */
  to: string;
  /** Clock reading when the crossfade started. */
  startTime: number;
  /** Crossfade length in milliseconds. */
  duration: number;
  /** The clip the `from` state had drawn, so the fade-out keeps playing it. */
  fromPickedClip: string | null;
}

/**
 * Everything the graph evaluator needs from the outside world.
 *
 * The POC read all of this from module singletons (`animVariables`,
 * `smRuntime`, `debugState`) and from `Date.now()`. Injecting it is what makes
 * the evaluator testable, lets two characters share one graph, and keeps the
 * clock consistent with the rest of the package.
 */
export interface GraphRuntime {
  /** Millisecond clock. */
  now: Clock;
  /** Blueprint variables read by `getVariable` and `varGet`. */
  variables: Map<string, unknown>;
  /** Sticky random draws by node id. */
  sticky: Map<string, StickyRandom>;
  /** Per-frame value cache; cleared at the start of every evaluation. */
  valueCache: Map<string, number>;
  /** State-machine state by node id. */
  sm: Map<string, SMState>;
  /** Clip timings by clip name, for the anim-time rule nodes. */
  clipTimings: Map<string, ClipTiming>;
  /** Uniform `[0, 1)` source. Absent means a deterministic 0.5, so tests are reproducible. */
  rand?: () => number;
}

/**
 * Read a numeric field, falling back when it is absent or not finite.
 *
 * @param data Authored payload, possibly undefined.
 * @param key Field name.
 * @param fallback Value used when the field is missing or not a finite number.
 *
 * @returns The field as a number.
 */
export function numField(data: GraphNodeData | undefined, key: string, fallback: number): number {
  const raw = data?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/**
 * Read a string field.
 *
 * @param data Authored payload, possibly undefined.
 * @param key Field name.
 *
 * @returns The field, or null when it is missing or not a non-empty string.
 */
export function strField(data: GraphNodeData | undefined, key: string): string | null {
  const raw = data?.[key];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * Read a boolean field with strict `=== true` semantics.
 *
 * @param data Authored payload, possibly undefined.
 * @param key Field name.
 *
 * @returns Whether the field is exactly `true`.
 */
export function isTrue(data: GraphNodeData | undefined, key: string): boolean {
  return data?.[key] === true;
}

/**
 * The array returned for an absent or malformed list field.
 *
 * Module-level and frozen, so a miss costs no allocation and every miss returns
 * the SAME array — which is what lets the index caches downstream key on
 * identity without a special case for "this state has no inner nodes".
 *
 * @example
 * ```ts
 * console.log(nodeList({ a: 1 }, 'innerNodes') === EMPTY_NODES); // true
 * ```
 */
export const EMPTY_NODES: readonly GraphNode[] = Object.freeze([]);

/**
 * The edge counterpart of `EMPTY_NODES`.
 *
 * @example
 * ```ts
 * console.log(edgeList(undefined, 'innerEdges') === EMPTY_EDGES); // true
 * ```
 */
export const EMPTY_EDGES: readonly GraphEdge[] = Object.freeze([]);

/**
 * Narrowed node lists, per `data` object, per field name.
 *
 * Graph JSON is immutable after load (see {@link nodeList}), so the filter only
 * has to run once per `(data, key)` pair for the lifetime of the graph. A
 * `WeakMap` keyed on the authored object means a graph that is dropped takes
 * its cache with it.
 */
const nodeListCache = new WeakMap<GraphNodeData, Map<string, readonly GraphNode[]>>();

/** The edge counterpart of `nodeListCache`. */
const edgeListCache = new WeakMap<GraphNodeData, Map<string, readonly GraphEdge[]>>();

/**
 * Read a nested node list, e.g. a state machine's `innerNodes`.
 *
 * **Memoised on the identity of `data`.** The narrowed array is built once per
 * `(data, key)` pair and the same array is returned forever after, because the
 * state machine asks for `innerNodes` five to eight times per frame and a fresh
 * `filter` each time is per-frame garbage (AGENTS hard rule 2). The contract
 * this buys is that **graph JSON is immutable after load**: mutate an authored
 * node array in place and the evaluator will not see it. Swap the whole graph
 * object instead — that is what `Animator.setGraph` is for.
 *
 * @param data Authored payload, possibly undefined.
 * @param key Field name.
 *
 * @returns The nodes, or `EMPTY_NODES` when the field is absent or
 *   malformed. The array is shared; never mutate it.
 */
export function nodeList(data: GraphNodeData | undefined, key: string): readonly GraphNode[] {
  if (data === undefined) return EMPTY_NODES;
  let byKey = nodeListCache.get(data);
  if (byKey === undefined) {
    byKey = new Map<string, readonly GraphNode[]>();
    nodeListCache.set(data, byKey);
  }
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;

  const raw = data[key];
  const list: readonly GraphNode[] = !Array.isArray(raw)
    ? EMPTY_NODES
    : raw.filter(
        (n): n is GraphNode =>
          typeof n === 'object' &&
          n !== null &&
          typeof (n as GraphNode).id === 'string' &&
          typeof (n as GraphNode).type === 'string',
      );
  byKey.set(key, list);
  return list;
}

/**
 * Read a nested edge list, e.g. a state machine's `innerEdges`.
 *
 * Memoised exactly as {@link nodeList} is, and under the same
 * "graph JSON is immutable after load" contract.
 *
 * @param data Authored payload, possibly undefined.
 * @param key Field name.
 *
 * @returns The edges, or `EMPTY_EDGES` when the field is absent or
 *   malformed. The array is shared; never mutate it.
 */
export function edgeList(data: GraphNodeData | undefined, key: string): readonly GraphEdge[] {
  if (data === undefined) return EMPTY_EDGES;
  let byKey = edgeListCache.get(data);
  if (byKey === undefined) {
    byKey = new Map<string, readonly GraphEdge[]>();
    edgeListCache.set(data, byKey);
  }
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;

  const raw = data[key];
  const list: readonly GraphEdge[] = !Array.isArray(raw)
    ? EMPTY_EDGES
    : raw.filter(
        (e): e is GraphEdge =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as GraphEdge).source === 'string' &&
          typeof (e as GraphEdge).target === 'string',
      );
  byKey.set(key, list);
  return list;
}

/**
 * Read a string array field, e.g. a state's `clips`.
 *
 * @param data Authored payload, possibly undefined.
 * @param key Field name.
 *
 * @returns The strings, or an empty array.
 */
export function strList(data: GraphNodeData | undefined, key: string): readonly string[] {
  const raw = data?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}
