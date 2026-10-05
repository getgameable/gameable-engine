// Ported from aos-threejs-poc/tests/unit/characterRuntime.test.mjs @ cdd63b10
import { describe, expect, it } from 'vitest';

import { applyWeights, type WeightedActionLike } from './applyWeights';
import { buildIndexFor, findNodeOfType, findOutputNode } from './evalCore';
import { createGraphRuntime, evaluateBody } from './evalBody';
import { evaluateRule } from './rules';
import { edgeList, EMPTY_EDGES, EMPTY_NODES, nodeList } from './types';
import type { BodyGraph, GraphEdge, GraphNode, GraphNodeData, GraphRuntime } from './types';

/**
 * A runtime on a controllable clock.
 *
 * @param now Clock.
 *
 * @returns The runtime.
 */
function rt(now: () => number = () => 0): GraphRuntime {
  return createGraphRuntime({ now });
}

describe('evaluateRule', () => {
  const graph = {
    nodes: [
      { id: 'ruleResult', type: 'ruleResult', data: {} },
      { id: 'cmp', type: 'ruleCompare', data: { operator: '>', threshold: 5 } },
      { id: 'v', type: 'varGet', data: { varName: 'X' } },
    ],
    edges: [
      { source: 'cmp', target: 'ruleResult', targetHandle: 'in' },
      { source: 'v', target: 'cmp', targetHandle: 'value' },
    ],
  };

  it('compares a variable against a threshold', () => {
    expect(evaluateRule(graph, { variables: new Map([['X', 9]]) })).toBe(true);
    expect(evaluateRule(graph, { variables: new Map([['X', 1]]) })).toBe(false);
  });

  it('handles and / or / not', () => {
    const g = {
      nodes: [
        { id: 'ruleResult', type: 'ruleResult', data: {} },
        { id: 'and', type: 'ruleAnd', data: {} },
        { id: 't', type: 'varGet', data: { varName: 'T' } },
        { id: 'notn', type: 'ruleNot', data: {} },
        { id: 'f', type: 'varGet', data: { varName: 'F' } },
      ],
      edges: [
        { source: 'and', target: 'ruleResult', targetHandle: 'in' },
        { source: 't', target: 'and', targetHandle: 'a' },
        { source: 'notn', target: 'and', targetHandle: 'b' },
        { source: 'f', target: 'notn', targetHandle: 'in' },
      ],
    };
    expect(
      evaluateRule(g, {
        variables: new Map<string, unknown>([
          ['T', true],
          ['F', false],
        ]),
      }),
    ).toBe(true);
  });

  it('keeps Unreal-parity loose equality across editor widget types', () => {
    const g = {
      nodes: [
        { id: 'ruleResult', type: 'ruleResult', data: {} },
        { id: 'cmp', type: 'ruleCompare', data: { operator: '==', threshold: 1 } },
        { id: 'v', type: 'varGet', data: { varName: 'X' } },
      ],
      edges: [
        { source: 'cmp', target: 'ruleResult', targetHandle: 'in' },
        { source: 'v', target: 'cmp', targetHandle: 'value' },
      ],
    };
    expect(evaluateRule(g, { variables: new Map<string, unknown>([['X', true]]) })).toBe(true);
    expect(evaluateRule(g, { variables: new Map<string, unknown>([['X', '1']]) })).toBe(true);
    expect(evaluateRule(g, { variables: new Map<string, unknown>([['X', 0]]) })).toBe(false);
  });

  it('throws on an unknown rule node rather than failing silently forever', () => {
    const g = {
      nodes: [
        { id: 'ruleResult', type: 'ruleResult', data: {} },
        { id: 'x', type: 'ruleNonsense', data: {} },
      ],
      edges: [{ source: 'x', target: 'ruleResult', targetHandle: 'in' }],
    };
    expect(() => evaluateRule(g)).toThrow(/unsupported rule node type/);
  });
});

describe('evaluateBody', () => {
  it('accumulates playClip weight plus loop and speed', () => {
    const g: BodyGraph = {
      nodes: [
        { id: 'final', type: 'finalPose', data: {} },
        { id: 'c', type: 'playClip', data: { clipName: 'idle', loop: true, playSpeed: 1 } },
      ],
      edges: [{ source: 'c', target: 'final', targetHandle: 'in' }],
    };
    const out = evaluateBody(g, rt());
    expect(out.weights.get('idle')).toBe(1);
    expect(out.loop.get('idle')).toBe(true);
    expect(out.speed.get('idle')).toBe(1);
  });

  it('splits weight by a blend alpha read from a variable', () => {
    const g: BodyGraph = {
      nodes: [
        { id: 'final', type: 'finalPose', data: {} },
        { id: 'bl', type: 'blend', data: { alphaVariable: 'W' } },
        { id: 'a', type: 'playClip', data: { clipName: 'A' } },
        { id: 'b', type: 'playClip', data: { clipName: 'B' } },
      ],
      edges: [
        { source: 'bl', target: 'final', targetHandle: 'in' },
        { source: 'a', target: 'bl', targetHandle: 'a' },
        { source: 'b', target: 'bl', targetHandle: 'b' },
      ],
    };
    const runtime = rt();
    runtime.variables.set('W', 0.25);
    const out = evaluateBody(g, runtime);
    expect(out.weights.get('A')).toBeCloseTo(0.75, 9);
    expect(out.weights.get('B')).toBeCloseTo(0.25, 9);
  });

  it('picks exactly one option in a select', () => {
    const g: BodyGraph = {
      nodes: [
        { id: 'final', type: 'finalPose', data: {} },
        { id: 'sel', type: 'select', data: { index: 1, optionCount: 2 } },
        { id: 'o0', type: 'playClip', data: { clipName: 'O0' } },
        { id: 'o1', type: 'playClip', data: { clipName: 'O1' } },
      ],
      edges: [
        { source: 'sel', target: 'final', targetHandle: 'in' },
        { source: 'o0', target: 'sel', targetHandle: 'option-0' },
        { source: 'o1', target: 'sel', targetHandle: 'option-1' },
      ],
    };
    const out = evaluateBody(g, rt());
    expect(out.weights.get('O1')).toBe(1);
    expect(out.weights.get('O0')).toBeUndefined();
  });

  it('throws on an unsupported node type', () => {
    const g: BodyGraph = {
      nodes: [
        { id: 'final', type: 'finalPose', data: {} },
        { id: 'x', type: 'blendByBool', data: {} },
      ],
      edges: [{ source: 'x', target: 'final', targetHandle: 'in' }],
    };
    expect(() => evaluateBody(g, rt())).toThrow(/unsupported node type/);
  });

  it('refuses an additive blend on the base layer', () => {
    const g: BodyGraph = {
      nodes: [
        { id: 'final', type: 'finalPose', data: {} },
        { id: 'bl', type: 'blend', data: { blendMode: 'additive' } },
      ],
      edges: [{ source: 'bl', target: 'final', targetHandle: 'in' }],
    };
    expect(() => evaluateBody(g, rt())).toThrow(/gesture channel/);
  });

  it('reuses the accumulator and the index so the per-frame path allocates nothing', () => {
    const g: BodyGraph = {
      nodes: [
        { id: 'final', type: 'finalPose', data: {} },
        { id: 'c', type: 'playClip', data: { clipName: 'idle' } },
      ],
      edges: [{ source: 'c', target: 'final', targetHandle: 'in' }],
    };
    const runtime = rt();
    const acc = evaluateBody(g, runtime);
    const again = evaluateBody(g, runtime, acc);
    expect(again).toBe(acc);
    expect(again.weights.size).toBe(1);

    // The index the evaluation used is the one still in the cache: if
    // `evaluateBody` rebuilt it per frame, this would be a different object.
    const index = buildIndexFor(g.nodes, g.edges);
    evaluateBody(g, runtime, acc);
    expect(buildIndexFor(g.nodes, g.edges)).toBe(index);
    expect(findNodeOfType(g.nodes, 'finalPose')).toBe(g.nodes[0]);
  });
});

describe('graph index memoisation', () => {
  /**
   * A one-clip graph with fresh arrays every call.
   *
   * @param clipName The clip the graph plays.
   *
   * @returns The graph.
   */
  function oneClipGraph(clipName: string): BodyGraph {
    return {
      nodes: [
        { id: 'final', type: 'finalPose', data: {} },
        { id: 'c', type: 'playClip', data: { clipName } },
      ],
      edges: [{ source: 'c', target: 'final', targetHandle: 'in' }],
    };
  }

  it('builds one index per graph identity, and a separate one per graph', () => {
    const a = oneClipGraph('idle');
    const b = oneClipGraph('walk');
    expect(buildIndexFor(a.nodes, a.edges)).toBe(buildIndexFor(a.nodes, a.edges));
    expect(buildIndexFor(b.nodes, b.edges)).not.toBe(buildIndexFor(a.nodes, a.edges));
  });

  it('rebuilds when the same nodes are paired with different edges', () => {
    const g = oneClipGraph('idle');
    const first = buildIndexFor(g.nodes, g.edges);
    const otherEdges: GraphEdge[] = [{ source: 'c', target: 'final' }];
    expect(buildIndexFor(g.nodes, otherEdges)).not.toBe(first);
  });

  it('memoises nodeList and edgeList per (data, key), not per call', () => {
    const data: GraphNodeData = {
      innerNodes: [{ id: 'output', type: 'stateOutput' }],
      innerEdges: [{ source: 'a', target: 'output' }],
      other: [{ id: 'x', type: 'playClip' }],
    };
    expect(nodeList(data, 'innerNodes')).toBe(nodeList(data, 'innerNodes'));
    expect(edgeList(data, 'innerEdges')).toBe(edgeList(data, 'innerEdges'));
    // A different key on the same data is a different list.
    expect(nodeList(data, 'other')).not.toBe(nodeList(data, 'innerNodes'));
    // A different data object gets its own, even with identical contents.
    const twin: GraphNodeData = { innerNodes: [{ id: 'output', type: 'stateOutput' }] };
    expect(nodeList(twin, 'innerNodes')).not.toBe(nodeList(data, 'innerNodes'));
    // Misses are the shared frozen empties, so they cost no allocation either.
    expect(nodeList(data, 'missing')).toBe(EMPTY_NODES);
    expect(edgeList(data, 'missing')).toBe(EMPTY_EDGES);
    expect(nodeList(undefined, 'innerNodes')).toBe(EMPTY_NODES);
    // The output lookup is memoised on the same array.
    const inner = nodeList(data, 'innerNodes');
    expect(findOutputNode(inner)).toBe(inner[0]);
    expect(findOutputNode(inner)).toBe(findOutputNode(inner));
  });

  it('does NOT re-read a graph mutated in place — the contract setGraph documents', () => {
    const g = oneClipGraph('idle');
    const runtime = rt();
    expect(evaluateBody(g, runtime).weights.get('idle')).toBe(1);

    // Editing the authored arrays in place is invisible: the index is keyed on
    // their identity. This is the price of a zero-allocation frame path.
    (g.nodes as GraphNode[]).push({ id: 'c2', type: 'playClip', data: { clipName: 'wave' } });
    (g.edges as GraphEdge[])[0] = { source: 'c2', target: 'final', targetHandle: 'in' };
    const stale = evaluateBody(g, runtime);
    expect(stale.weights.get('idle')).toBe(1);
    expect(stale.weights.get('wave')).toBeUndefined();

    // Handing over a freshly built graph is what a caller must do instead.
    const fresh: BodyGraph = { nodes: [...g.nodes], edges: [...g.edges] };
    const applied = evaluateBody(fresh, runtime);
    expect(applied.weights.get('wave')).toBe(1);
  });
});

describe('state machine', () => {
  /**
   * A two-state machine: A, then B once `GoB` is set.
   *
   * @returns The graph.
   */
  function smGraph(): BodyGraph {
    /**
     * One state with an inner playClip subgraph.
     *
     * @param id State id.
     * @param clip Clip name.
     *
     * @returns The state node.
     */
    const state = (id: string, clip: string) => ({
      id,
      type: 'state',
      data: {
        name: id,
        innerNodes: [
          { id: 'output', type: 'stateOutput', data: {} },
          { id: `${id}_clip`, type: 'playClip', data: { clipName: clip, loop: true } },
        ],
        innerEdges: [{ source: `${id}_clip`, target: 'output', targetHandle: 'in' }],
      },
    });
    const sm = {
      id: 'sm',
      type: 'stateMachine',
      data: {
        innerNodes: [
          { id: 'entry', type: 'entry', data: {} },
          state('A', 'clipA'),
          state('B', 'clipB'),
        ],
        innerEdges: [
          { id: 'e0', type: 'transition', source: 'entry', target: 'A', data: {} },
          {
            id: 'e1',
            type: 'transition',
            source: 'A',
            target: 'B',
            data: {
              ruleGraph: {
                nodes: [
                  { id: 'ruleResult', type: 'ruleResult', data: {} },
                  { id: 'g', type: 'varGet', data: { varName: 'GoB' } },
                ],
                edges: [{ source: 'g', target: 'ruleResult', targetHandle: 'in' }],
              },
            },
          },
        ],
      },
    };
    return {
      nodes: [{ id: 'final', type: 'finalPose', data: {} }, sm],
      edges: [{ source: 'sm', target: 'final', targetHandle: 'in' }],
    };
  }

  it('starts in the entry state', () => {
    const runtime = rt();
    const out = evaluateBody(smGraph(), runtime);
    expect(out.weights.get('clipA')).toBe(1);
    expect(runtime.sm.get('sm')?.currentState).toBe('A');
  });

  it('crossfades to B when the rule fires, then settles on B', () => {
    const g = smGraph();
    let t = 0;
    const runtime = rt(() => t);
    evaluateBody(g, runtime);
    runtime.variables.set('GoB', true);
    t = 1000;
    const mid = evaluateBody(g, runtime);
    expect(mid.weights.get('clipA') ?? 0).toBeCloseTo(1, 6); // crossfade just started
    t = 1150;
    const half = evaluateBody(g, runtime);
    expect(half.weights.get('clipB') ?? 0).toBeCloseTo(0.5, 6);
    t = 1400;
    const done = evaluateBody(g, runtime);
    expect(done.weights.get('clipB') ?? 0).toBeGreaterThan(0.99);
    expect(done.weights.get('clipA') ?? 0).toBeLessThan(0.01);
  });
});

describe('applyWeights', () => {
  /** A recording stand-in for three's AnimationAction. */
  interface FakeAction extends WeightedActionLike {
    /** Last weight written. */
    weight: number;
    /** Whether it is scheduled. */
    running: boolean;
  }

  /**
   * Build a fake action.
   *
   * @returns The action.
   */
  function fakeAction(): FakeAction {
    return {
      weight: 0,
      running: false,
      timeScale: 1,
      clampWhenFinished: false,
      loop: 0,
      setEffectiveWeight(w: number): void {
        this.weight = w;
      },
      setLoop(mode: number): void {
        this.loop = mode;
      },
      isRunning(): boolean {
        return this.running;
      },
      play(): void {
        this.running = true;
      },
      stop(): void {
        this.running = false;
      },
    };
  }

  it('applies weight, loop and speed, and stops absent clips', () => {
    const idle = fakeAction();
    const wave = fakeAction();
    wave.running = true; // was playing, and is absent from the weights
    const actions = new Map<string, WeightedActionLike>([
      ['idle', idle],
      ['wave', wave],
    ]);
    applyWeights(
      new Map([['idle', 0.8]]),
      new Map([['idle', true]]),
      new Map([['idle', 1.5]]),
      actions,
    );
    expect(idle.weight).toBe(0.8);
    expect(idle.timeScale).toBe(1.5);
    expect(idle.loop).toBe(2201);
    expect(idle.clampWhenFinished).toBe(false);
    expect(idle.running).toBe(true);
    expect(wave.running).toBe(false);
  });

  it('clamps a non-looping clip and plays it once', () => {
    const hit = fakeAction();
    applyWeights(
      new Map([['hit', 1]]),
      new Map([['hit', false]]),
      null,
      new Map<string, WeightedActionLike>([['hit', hit]]),
    );
    expect(hit.loop).toBe(2200);
    expect(hit.clampWhenFinished).toBe(true);
  });

  it('stops everything when the weights are null', () => {
    const idle = fakeAction();
    idle.running = true;
    applyWeights(null, null, null, new Map<string, WeightedActionLike>([['idle', idle]]));
    expect(idle.running).toBe(false);
  });
});
