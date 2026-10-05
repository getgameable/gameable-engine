// The one adapter-capability question the GPU deform has to ask, kept out of
// OrlGpuDeform so it can be tested without a device.
//
// Ported from aos-threejs-poc/src/lib/orl/gpuLimits.js @ cdd63b10

/**
 * Bytes of skin-matrix rows a J-joint rig uploads: rows 0..2 of each joint's 4x4.
 *
 * @param J Joint count in the DNA.
 * @returns The byte size of the skin-row uniform: 12 floats per joint, 4 bytes each.
 */
export const skinRowsBytes = (J: number): number => J * 12 * 4;

/** The default `maxUniformBufferBindingSize` every WebGPU adapter must support. */
export const DEFAULT_UNIFORM_LIMIT = 65536;

/**
 * Why the skin rows are a UNIFORM at all: it keeps the deform pipeline's storage
 * bindings at 7, so it does not depend on raising `maxStorageBuffersPerShaderStage`
 * — some integrated GPUs report 8, and a pipeline that needs 9 simply never builds
 * on them.
 *
 * The trade is a much lower size ceiling: 64 KiB, which is ~1365 joints. A
 * MetaHuman head is 870 (41,760 bytes), so no shipped DNA is close. This exists
 * because "no shipped DNA is close" is the kind of assumption that otherwise gets
 * discovered as a WebGPU validation error naming a byte count and a binding index,
 * on someone else's machine.
 *
 * @param J Joint count in the DNA.
 * @param device The device whose `maxUniformBufferBindingSize` decides the ceiling.
 *   Omitted or null falls back to the 64 KiB every adapter guarantees.
 * @returns The reason the GPU deform cannot run, or null.
 */
export function uniformCapacityError(J: number, device?: GPUDevice | null): string | null {
  const bytes = skinRowsBytes(J);
  const cap = device?.limits.maxUniformBufferBindingSize ?? DEFAULT_UNIFORM_LIMIT;
  if (bytes <= cap) return null;
  return (
    `this DNA has ${String(J)} joints (${String(bytes)} bytes of skin rows), over this adapter's ` +
    `${String(cap)}-byte uniform limit — the GPU deform would need them as a storage buffer to go further`
  );
}
