/**
 * An exported character's splats, built for a host: the character's sink (its splats and its
 * pose corrections' own), the teeth's sink when the mouth is drawn, and the runtime over both.
 * The engine's character bridge (its first load and a fuller copy's upgrade) and
 * `gameable/three` build a character the same way through here.
 *
 * The sinks come from the host (`gameable/splat`'s `createAnimatedSplat`): this package never
 * imports the splat renderer (see splatSink.ts).
 */
import type { Object3D, WebGPURenderer } from 'three/webgpu';

import type { SplatSink } from '../splatSink.js';
import { correctivePoints } from './corrective.js';
import type { AosrigSplatBundle } from './format.js';
import { createAosrigSplat, type AosrigSplatRuntime } from './runtime.js';

/** What a host's sink maker is asked for. */
export interface AosrigSinkRequest {
  /** Splats it must hold. */
  readonly capacity: number;
  /** The package's colours: sRGB unless its descriptor says otherwise. */
  readonly colorSpace: 'linear' | 'srgb';
  /** The Gameable studio's splat kernel, for the character's own splats (not the teeth's). */
  readonly kernel?: 'studio';
}

/** A sink the host made, which the host also frees. */
export type AosrigHostSink = SplatSink & { dispose(): void };

/** A built character: its runtime and the sinks it writes. */
export interface AosrigCharacterBuild<S extends AosrigHostSink> {
  readonly runtime: AosrigSplatRuntime;
  /** The character's splats; hidden until the host first shows it. */
  readonly sink: S;
  /** The teeth's splats, when the mouth was built; else null. */
  readonly teethSink: S | null;
}

/**
 * Build an exported character's splats and its runtime.
 *
 * On failure every sink made here is freed and the error is thrown on.
 *
 * @param o The package, its rig, the renderer and how to make a sink.
 * @param o.bundle The loaded package.
 * @param o.rig The rig the bindings follow.
 * @param o.renderer The renderer that owns the sinks.
 * @param o.makeSink Makes a sink (`createAnimatedSplat`), with whatever the host adds (a draw order).
 * @param o.mouth Draw the inside of the mouth when the package carries the teeth's points.
 * @param o.webgl The renderer is on the WebGL2 fallback.
 * @param o.releaseBuffer Frees a storage attribute's GPU buffers (`releaseStorageAttribute`).
 * @param o.pause Awaited between blocks of the build, so frames keep drawing.
 * @param o.onMouthError Told when the mouth cannot be built; the character draws without it.
 * @returns The runtime and the sinks.
 * @example
 * ```ts
 * const { runtime, sink } = await buildAosrigCharacter({
 *   bundle, rig, renderer, mouth: true,
 *   makeSink: (request) => createAnimatedSplat(renderer, request),
 * });
 * group.add(sink.object3D);
 * ```
 */
export async function buildAosrigCharacter<S extends AosrigHostSink>(o: {
  readonly bundle: AosrigSplatBundle;
  readonly rig: Object3D;
  readonly renderer: WebGPURenderer;
  readonly makeSink: (request: AosrigSinkRequest) => Promise<S>;
  readonly mouth: boolean;
  readonly webgl?: boolean;
  readonly releaseBuffer?: (attribute: object) => void;
  readonly pause?: () => Promise<void>;
  readonly onMouthError?: (error: unknown) => void;
}): Promise<AosrigCharacterBuild<S>> {
  const d = o.bundle.descriptor;
  const colorSpace = d.colorSpace ?? 'srgb';
  let sink: S | null = null;
  let teethSink: S | null = null;
  try {
    // Room for the character's splats and its pose corrections' new ones.
    sink = await o.makeSink({
      capacity: d.splatCount + correctivePoints(o.bundle.corrective),
      colorSpace,
      kernel: 'studio',
    });
    // Hidden until the host's first update has written the gaussians.
    sink.object3D.visible = false;
    const teeth = o.mouth ? o.bundle.teeth : undefined;
    if (teeth) teethSink = await o.makeSink({ capacity: teeth.info.points, colorSpace });
    const runtime = await createAosrigSplat({
      bundle: o.bundle,
      rig: o.rig,
      sink,
      renderer: o.renderer,
      ...(o.webgl ? { webgl: true } : {}),
      ...(o.releaseBuffer ? { releaseBuffer: o.releaseBuffer } : {}),
      ...(o.pause ? { pause: o.pause } : {}),
      ...(teethSink
        ? { mouth: { sink: teethSink, ...(o.onMouthError ? { onError: o.onMouthError } : {}) } }
        : {}),
    });
    // A mouth that was not built needs no teeth.
    if (runtime.mouth === null && teethSink) {
      teethSink.dispose();
      teethSink = null;
    }
    return { runtime, sink, teethSink };
  } catch (error) {
    sink?.object3D.removeFromParent();
    sink?.dispose();
    teethSink?.dispose();
    throw error;
  }
}
