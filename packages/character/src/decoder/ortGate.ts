// Cross-pipeline ORT run-serialization gate.
//
// The JSEP WebGPU EP processes one inference at a time PER RUNTIME: two overlapping
// `session.run()` calls — even on different `InferenceSession` objects, even across
// different characters that share the one `onnxruntime-web` runtime — throw "Session
// already started" / "Session mismatch" (and a heap OOB on WASM). Every consumer of
// the shared runtime MUST route its session create + run through this single
// module-level gate so no two ORT ops ever overlap.
//
// Cost is one microtask hop per op. Runs `fn` whether the prior op resolved or
// rejected, so one failure cannot wedge the queue.
//
// Ported from aos-threejs-poc/src/lib/ortGate.js @ cdd63b10

let ortGate: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with no other gated ORT operation in flight.
 *
 * @param fn The ORT operation to serialise — a session create or a `session.run()`.
 * @returns Whatever `fn` resolves to, once every earlier gated op has settled. A
 * rejection propagates to this caller and does not wedge the queue.
 */
export function withOrtGate<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = ortGate.then(fn, fn);
  ortGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
