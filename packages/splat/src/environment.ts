import {
  EquirectangularReflectionMapping,
  PMREMGenerator,
  type Scene,
  type Texture,
  type Renderer,
} from 'three/webgpu';

/** Shared mesh environment and Gaussian probe settings. SH must already be in world space. */
export interface EnvironmentProbeOptions {
  /** Nine RGB radiance coefficients, already rotated to match the scene. */
  radianceSH: readonly (readonly [number, number, number])[];
  /** Shared brightness multiplier. Default 1. */
  intensity?: number;
  /** Panorama yaw in radians; does not rotate the supplied world-space SH. */
  yaw?: number;
  /** Set false to temporarily attach no mesh environment. Default true. */
  enabled?: boolean;
}

/**
 * Filter a caller-owned panorama for mesh IBL and scale its world-space Gaussian probe.
 * Dispose restores the previous scene environment if this helper still owns it.
 * The input texture remains caller-owned. No assets or network requests are created.
 *
 * @param scene Scene receiving mesh IBL.
 * @param renderer Initialized engine renderer.
 * @param panorama Linear HDR equirectangular panorama.
 * @param options Probe and matching mesh intensity/orientation.
 * @returns Shared SH coefficients and idempotent cleanup.
 * @example
 * ```ts
 * const lighting = createEnvironmentProbe(engine.scene, engine.renderer, panorama, {
 *   radianceSH: probe.radianceSH, intensity: 0.95, yaw: probe.yaw,
 * });
 * splat.setEnvironmentLighting({ radianceSH: lighting.radianceSH });
 * // On shutdown: lighting.dispose(); panorama.dispose();
 * ```
 */
export function createEnvironmentProbe(
  scene: Scene,
  renderer: Renderer,
  panorama: Texture,
  options: EnvironmentProbeOptions,
) {
  const intensity = options.intensity ?? 1;
  const yaw = options.yaw ?? 0;
  if (
    !Number.isFinite(intensity) ||
    intensity < 0 ||
    !Number.isFinite(yaw) ||
    options.radianceSH.length !== 9 ||
    options.radianceSH.some(
      (c) => (c as readonly number[]).length !== 3 || c.some((v) => !Number.isFinite(v)),
    )
  )
    throw new RangeError('Invalid environment probe');
  const radianceSH = options.radianceSH.map(
    (c) => c.map((v) => v * intensity) as [number, number, number],
  );
  const previous = scene.environment;
  const previousIntensity = scene.environmentIntensity;
  const previousRotation = scene.environmentRotation.clone();
  const mapping = panorama.mapping;
  const generator = new PMREMGenerator(renderer);
  let filtered;
  try {
    panorama.mapping = EquirectangularReflectionMapping;
    filtered = generator.fromEquirectangular(panorama);
  } finally {
    panorama.mapping = mapping;
    generator.dispose();
  }
  const attached = options.enabled === false ? null : filtered.texture;
  scene.environment = attached;
  scene.environmentIntensity = intensity;
  scene.environmentRotation.set(0, yaw, 0);
  let disposed = false;
  return {
    radianceSH,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (scene.environment === attached) {
        scene.environment = previous;
        scene.environmentIntensity = previousIntensity;
        scene.environmentRotation.copy(previousRotation);
      }
      filtered.dispose();
    },
  };
}
