/**
 * `gameable/character/aosrig`: an exported (studio-published) character, and nothing else.
 *
 * The package's main entry also carries the decoder characters, which import onnxruntime-web and
 * the RigLogic wasm: an app bundling it gets both wasm files (about 29 MB) in its build output
 * whether it decodes or not. This entry is the exported character's runtime alone (its loader,
 * the deformation, the face tables, the mouth), so a three.js app
 * (`gameable/three`) bundles neither. Everything here is also exported from the
 * main entry, under the same names.
 */

export { CharacterUnsupportedError } from './errors.js';
export type { SlotRange, SplatSink, SplatSinkBuffers } from './splatSink.js';

export { prepareLiftDevice, REQUIRED_STORAGE_BUFFERS } from './device/index.js';
export type { RendererLike } from './device/index.js';

export {
  ARKIT_TO_GNM_DEFAULT,
  createArkitToGnmMap,
  GAZE_FULL_SCALE,
} from './expression/arkitToGnmDefault.js';
export type {
  ArkitGnmTable,
  ArkitGnmTerm,
  ArkitToGnmOptions,
} from './expression/arkitToGnmDefault.js';
export { createFittedArkitMap, type FittedArkitMap } from './expression/arkitFitted.js';
export { ARKIT_NAMES } from './rig/arkit/arkitNames.js';

export { GnmRigBackend, GNM_PACK_FILE } from './rig/gnm/GnmRigBackend.js';
export {
  parseAosRig,
  packAosRig,
  regionSlices,
  unpackHeadExt,
  headExtNames,
} from './rig/gnm/gnmPack.js';
export type { AosRigHeader, AosRigPack, HeadExtLayout } from './rig/gnm/gnmPack.js';

export { headJointOf, loadAosrigSplatBundle, releaseSharedClips } from './aosrigSplat/format.js';
export { yieldingPause } from './aosrigSplat/packed.js';
export type {
  ArkitFaceTableInfo,
  AosrigSplatDescriptor,
  AosrigSplatBundle,
  AosrigSplatLoadOptions,
  AosrigCorrectiveFiles,
} from './aosrigSplat/format.js';
export {
  createSomaPoser,
  createSomaRig,
  parseSomaClips,
  parseSomaSkeleton,
  somaAnimationClip,
} from './aosrigSplat/soma.js';
export type { SomaClip, SomaJoint, SomaPoser, SomaSkeleton } from './aosrigSplat/soma.js';
export { createAosrigSplat } from './aosrigSplat/runtime.js';
export { buildAosrigCharacter } from './aosrigSplat/host.js';
export type {
  AosrigCharacterBuild,
  AosrigHostSink,
  AosrigSinkRequest,
} from './aosrigSplat/host.js';
export type {
  AosrigSplatRuntime,
  AosrigCorrectiveState,
  AosrigMouthHiddenState,
} from './aosrigSplat/runtime.js';
export { capturedLightSamples } from './aosrigSplat/capturedLight.js';
export type {
  CapturedLightOptions,
  CapturedLightSamples,
  RigSurface,
} from './aosrigSplat/capturedLight.js';
export { correctivePoints, MAX_CORRECTIONS_PLAYED } from './aosrigSplat/corrective.js';
export { MOUTH_RENDER_ORDER } from './aosrigSplat/mouthRuntime.js';
export type {
  AosrigMouth,
  AosrigMouthOptions,
  AosrigTeethFiles,
} from './aosrigSplat/mouthRuntime.js';
