// Single ORT-Web import indirection: every module in this package imports
// onnxruntime-web through this file so the bundle is selected in one place.
//
// The bundle is chosen at import-resolution time by the package `exports` map:
//   "onnxruntime-web"        -> the JSEP build (ort-wasm-simd-threaded.jsep.wasm;
//                               its 'webgpu' EP is the JS-encoded JSEP backend)
//   "onnxruntime-web/webgpu" -> the native C++/Dawn WebGPU EP
//
// We ship the JSEP build, as the POC does. Two correctness defects of the native
// EP do not reproduce on JSEP: the fused trunk+geom graph aliasing its own `code`
// intermediate-also-output on a gpu-buffer, and the small-in_channels appr Conv
// miscompute. On JSEP neither occurs, so `code` stays on a gpu-buffer through the
// geom->appr handoff and appr runs on WebGPU.
//
// ROLLBACK to the native EP is the single specifier below.
//
// Ported from aos-threejs-poc/src/ogs/inference/ort.ts @ cdd63b10
export * from 'onnxruntime-web';
