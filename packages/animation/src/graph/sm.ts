// Ported from aos-threejs-poc/packages/avataros-character-runtime/src/sm.js @ cdd63b10
/**
 * sm — the locomotion / conversational state machine runtime.
 *
 * Ported from the POC's `smRuntime.js` plus the `stateMachine` branch of
 * `GraphEvaluator.js` (`evaluateNode` + `updateSMTransitions`).
 *
 * Key differences from the app version, kept from the POC's own port notes:
 *
 *  - no global `smRuntime` singleton — state lives in `rt.sm.get(node.id)`, so
 *    two characters can share one graph;
 *  - no `Date.now()` — all time through `rt.now()`;
 *  - no `devLog` / `debugState` side effects;
 *  - {@link createSMHandler} returns a handler injected into the dispatcher,
 *    so neither module imports the other.
 *
 * The per-frame path allocates nothing: the inner node/edge lists, their
 * indices and each transition edge's rule graph are all memoised on the
 * identity of the authored objects, and `evalOneState` is a module-level
 * function rather than a closure rebuilt twice a frame.
 */
import {
  buildIndexFor,
  type EvalAccumulator,
  evaluateSubgraph,
  findOutputNode,
  firstEdgeInto,
  type GraphIndex,
  type NodeHandler,
  type NodeHandlers,
} from './evalCore';
import { evaluateRule, type RuleGraph } from './rules';
import {
  edgeList,
  type GraphEdge,
  type GraphNode,
  type GraphNodeData,
  type GraphRuntime,
  nodeList,
  type SMState,
  strField,
  strList,
} from './types';

/** The crossfade length the POC hard-coded in `smRuntime`, in milliseconds. */
export const SM_TRANSITION_MS = 300;

/**
 * Create a fresh per-state-machine state object.
 *
 * @returns State stored in `rt.sm` and mutated in place each frame.
 */
export function createSMState(): SMState {
  return { currentState: null, stateEnteredAt: 0, transition: null, pickedClip: null };
}

/**
 * Pick a clip name from a state node's `clips[]` array or `clipName` field.
 *
 * @param stateNode The state node, or undefined.
 * @param rt Runtime context, for `rand`.
 *
 * @returns The chosen clip name, or null.
 */
function pickClipForState(stateNode: GraphNode | undefined, rt: GraphRuntime): string | null {
  const clips = strList(stateNode?.data, 'clips');
  if (clips.length > 0) {
    const rand = rt.rand ?? ((): number => 0.5);
    return clips[Math.floor(rand() * clips.length)];
  }
  return strField(stateNode?.data, 'clipName');
}

/**
 * Clear sticky random values for every `random` node in an inner node list.
 *
 * Re-entering a state must re-roll its random draws; leaving them sticky is how
 * a state machine ends up playing the same "idle variation" forever.
 *
 * @param innerNodes The state's inner nodes.
 * @param rt Runtime context.
 */
function clearStickyRandomsInNodes(innerNodes: readonly GraphNode[], rt: GraphRuntime): void {
  for (const n of innerNodes) if (n.type === 'random') rt.sticky.delete(n.id);
}

/**
 * Rule graphs by transition-edge payload identity.
 *
 * `null` is cached too: an edge with no rule graph is re-asked every frame and
 * must not re-narrow. The `RuleGraph` object itself has to be stable, because
 * `evaluateRule` memoises its indices on that object.
 */
const ruleGraphCache = new WeakMap<GraphNodeData, RuleGraph | null>();

/**
 * Read a transition edge's rule graph, memoised on the edge's payload identity.
 *
 * @param data The edge's authored payload.
 *
 * @returns The rule graph, or null when the edge carries none. The SAME object
 *   on every call for the same payload.
 */
function ruleGraphOf(data: GraphNodeData | undefined): RuleGraph | null {
  if (data === undefined) return null;
  const cached = ruleGraphCache.get(data);
  if (cached !== undefined) return cached;

  const raw = data.ruleGraph;
  let graph: RuleGraph | null = null;
  if (typeof raw === 'object' && raw !== null) {
    const nodes = nodeList(raw as GraphNodeData, 'nodes');
    if (nodes.length > 0) graph = { nodes, edges: edgeList(raw as GraphNodeData, 'edges') };
  }
  ruleGraphCache.set(data, graph);
  return graph;
}

/**
 * Evaluate one state's inner subgraph at the given weight.
 *
 * Hoisted to module scope with explicit parameters rather than closing over
 * `evalSMState`'s locals: it was a fresh closure per call, twice per frame per
 * state machine, which is exactly the kind of "invisible" per-frame allocation
 * AGENTS hard rule 2 is about.
 *
 * @param index The state machine's inner index, for the state lookup.
 * @param stateId The state node id, or null.
 * @param pickedClipOverride The clip drawn for that state, for legacy states.
 * @param weight The weight to evaluate it at.
 * @param rt Runtime context.
 * @param acc Accumulators to write into.
 * @param handlers Node-type overrides, for nested state machines.
 */
function evalOneState(
  index: GraphIndex,
  stateId: string | null,
  pickedClipOverride: string | null,
  weight: number,
  rt: GraphRuntime,
  acc: EvalAccumulator,
  handlers: NodeHandlers,
): void {
  if (weight <= 0 || stateId === null) return;
  const stateNode = index.nodeById.get(stateId);
  if (stateNode === undefined) return;

  const sNodes = nodeList(stateNode.data, 'innerNodes');
  const sEdges = edgeList(stateNode.data, 'innerEdges');

  if (findOutputNode(sNodes) !== undefined) {
    evaluateSubgraph(sNodes, sEdges, rt, acc, weight, handlers);
    return;
  }

  // Legacy state: `data.clipName` / `data.clips[]`, no inner graph.
  const legacyClip = pickedClipOverride ?? pickClipForState(stateNode, rt);
  if (legacyClip !== null) {
    acc.weights.set(legacyClip, (acc.weights.get(legacyClip) ?? 0) + weight);
    if (!acc.loop.has(legacyClip)) acc.loop.set(legacyClip, true);
  }
}

/**
 * Drive a state machine for one frame.
 *
 * First frame (`currentState` null): enter through the `entry` transition.
 * While a crossfade is in flight: wait, {@link evalSMState} handles the blend.
 * Otherwise: evaluate the outgoing rule-guarded transitions and fire the first
 * that returns true.
 *
 * @param smNode The `stateMachine` node.
 * @param rt Runtime context; `rt.sm` is mutated in place.
 */
export function updateTransitions(smNode: GraphNode, rt: GraphRuntime): void {
  const smState = rt.sm.get(smNode.id);
  if (smState === undefined) return;

  const innerNodes = nodeList(smNode.data, 'innerNodes');
  const innerEdges = edgeList(smNode.data, 'innerEdges');
  const index = buildIndexFor(innerNodes, innerEdges);

  if (smState.currentState === null) {
    let firstEntry: GraphEdge | undefined;
    for (const e of innerEdges) {
      if (e.source === 'entry') {
        firstEntry = e;
        break;
      }
    }
    if (firstEntry === undefined) return;
    const entryStateNode = index.nodeById.get(firstEntry.target);
    smState.currentState = firstEntry.target;
    smState.stateEnteredAt = rt.now();
    smState.pickedClip = pickClipForState(entryStateNode, rt);
    clearStickyRandomsInNodes(nodeList(entryStateNode?.data, 'innerNodes'), rt);
    return;
  }

  // Mid-transition: let evalSMState blend until it commits.
  if (smState.transition !== null) return;

  // Resolve the clip the current state is playing, so the anim-time rule nodes
  // have something to read.
  const currentStateNode = index.nodeById.get(smState.currentState);
  const sEdges = edgeList(currentStateNode?.data, 'innerEdges');
  const sNodes = nodeList(currentStateNode?.data, 'innerNodes');
  const sIndex = buildIndexFor(sNodes, sEdges);
  const outEdge = firstEdgeInto(sIndex, 'output');
  const sourceNode = outEdge === undefined ? undefined : sIndex.nodeById.get(outEdge.source);
  const playNode = sourceNode?.type === 'playClip' ? sourceNode : undefined;
  const currentClipName = strField(playNode?.data, 'clipName');

  for (const edge of innerEdges) {
    if (edge.source !== smState.currentState || edge.source === 'entry') continue;
    const ruleGraph = ruleGraphOf(edge.data);
    if (ruleGraph === null) continue;
    const fired = evaluateRule(ruleGraph, {
      variables: rt.variables,
      clipTimings: rt.clipTimings,
      currentClipName,
    });
    if (!fired) continue;

    const toStateNode = index.nodeById.get(edge.target);
    const fromPickedClip = smState.pickedClip;
    const toPickedClip = pickClipForState(toStateNode, rt);
    clearStickyRandomsInNodes(nodeList(toStateNode?.data, 'innerNodes'), rt);
    smState.transition = {
      from: smState.currentState,
      to: edge.target,
      startTime: rt.now(),
      duration: SM_TRANSITION_MS,
      fromPickedClip,
    };
    smState.currentState = edge.target;
    smState.stateEnteredAt = rt.now();
    smState.pickedClip = toPickedClip;
    break;
  }
}

/**
 * Evaluate the current state — and the crossfade, if one is in flight — into
 * the caller's accumulators.
 *
 * @param smNode The `stateMachine` node.
 * @param rt Runtime context.
 * @param masterWeight Weight inherited from the parent blend.
 * @param acc Accumulators to write into.
 * @param handlers Node-type overrides, for nested state machines.
 */
export function evalSMState(
  smNode: GraphNode,
  rt: GraphRuntime,
  masterWeight: number,
  acc: EvalAccumulator,
  handlers: NodeHandlers,
): void {
  const smState = rt.sm.get(smNode.id);
  if (smState === undefined) return;
  const innerNodes = nodeList(smNode.data, 'innerNodes');
  const index = buildIndexFor(innerNodes, edgeList(smNode.data, 'innerEdges'));

  const transition = smState.transition;
  if (transition !== null) {
    const elapsed = rt.now() - transition.startTime;
    const progress = Math.max(0, Math.min(1, elapsed / transition.duration));
    if (progress >= 1) {
      smState.transition = null;
      evalOneState(
        index,
        smState.currentState,
        smState.pickedClip,
        masterWeight,
        rt,
        acc,
        handlers,
      );
    } else {
      evalOneState(
        index,
        transition.from,
        transition.fromPickedClip,
        masterWeight * (1 - progress),
        rt,
        acc,
        handlers,
      );
      evalOneState(
        index,
        smState.currentState,
        smState.pickedClip,
        masterWeight * progress,
        rt,
        acc,
        handlers,
      );
    }
    return;
  }

  evalOneState(index, smState.currentState, smState.pickedClip, masterWeight, rt, acc, handlers);
}

/**
 * The `stateMachine` node handler, for injection into the dispatcher.
 *
 * @returns A handler that drives transitions then evaluates the current state,
 *   in that order — the same frame order the POC's `updateSMTransitions`
 *   before `evaluateGraph` produced.
 */
export function createSMHandler(): NodeHandler {
  return function handleStateMachine(node, rt, acc, masterWeight, handlers): void {
    if (!rt.sm.has(node.id)) rt.sm.set(node.id, createSMState());
    updateTransitions(node, rt);
    evalSMState(node, rt, masterWeight, acc, handlers);
  };
}
