// GAMEABLE EDIT 0 BEGIN
/**
 * AnimatedGaussianSplat - a fork of three.js's GaussianSplat.
 *
 * Forked from three@0.186.0, examples/jsm/objects/GaussianSplat.js
 * (sha256 ea3f148d39413ef31781cdbb1c97a8972b2dce01ef5eebe6ef800c2b1ba7ab42).
 *
 * The MIT License
 *
 * Copyright (c) 2010-2026 three.js authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * Every deviation from that file is inside an `GAMEABLE EDIT <n>` block and is
 * explained in UPSTREAM.md next to this file. scripts/diff-upstream.mjs removes
 * the blocks and asserts what is left is byte-identical to upstream, so do not
 * change a single character outside one.
 */
// GAMEABLE EDIT 0 END
import {
	Box3,
	BufferAttribute,
	InstancedBufferGeometry,
	Matrix3,
	Matrix4,
	Mesh,
	NodeMaterial,
	Ray,
	Sphere,
	StorageBufferAttribute,
	Vector2,
	Vector3
} from 'three/webgpu';

// GAMEABLE EDIT 13 BEGIN
import { modelNormalMatrix, modelWorldMatrix, sRGBTransferEOTF, getDistanceAttenuation } from 'three/tsl';
// GAMEABLE EDIT 13 END
// GAMEABLE EDIT 20 BEGIN
import { sRGBTransferOETF } from 'three/tsl';
// GAMEABLE EDIT 20 END
// GAMEABLE EDIT 17 BEGIN
import { StorageInstancedBufferAttribute } from 'three/webgpu';
// GAMEABLE EDIT 17 END
// GAMEABLE EDIT 16 BEGIN
import {
	Loop as shadowLoop,
	abs as shadowAbs,
	ivec2 as shadowIvec2,
	length as shadowLength,
	select as shadowSelect,
	smoothstep as shadowSmoothstep,
	textureLoad as shadowTextureLoad,
	uniformArray as shadowUniformArray
} from 'three/tsl';
// GAMEABLE EDIT 16 END
import {
	Discard,
	Fn,
	If,
	atan,
	cameraProjectionMatrix,
	cameraViewport,
	cos,
	dot,
	exp,
	float,
	highpModelViewMatrix,
	instanceIndex,
	max,
	min,
	normalize,
	positionGeometry,
	sin,
	sqrt,
	storage,
	uint,
	uniform,
	unpackUnorm4x8,
	varyingProperty,
	vec2,
	vec3,
	vec4
} from 'three/tsl';

// GAMEABLE EDIT 0 BEGIN
// The two relative addon imports below become package-exports specifiers, so this fork can
// live outside three's examples tree and so ESLint's gameable/no-bare-three-import rule is
// satisfied. scripts/diff-upstream.mjs maps them back before diffing.
// GAMEABLE EDIT 0 END
import { CountingSort } from 'three/addons/gpgpu/CountingSort.js';
import {
	SH_BAND_COMPONENTS,
	SH_BAND_WORDS,
	getSphericalHarmonicsDegree
} from 'three/addons/utils/GaussianSplatUtils.js';

const BIN_COUNT = 4096;
const WORKGROUP_SIZE = 256;
const SORT_DIRECTION_THRESHOLD = 0.9995;
const KERNEL_2D_SIZE = 0.3;
const SPLAT_KERNEL_CUTOFF = 2;
// GAMEABLE EDIT 18 BEGIN
// The studio's kernel (PlayCanvas 2.22 classic GSplat) in true pixels. PlayCanvas projects the
// covariance with focal = viewport width * P00, twice the pixel focal length, so its constants are
// in half-pixel units: its +0.3 blur is 0.075 px^2, its 0.1 minor-axis floor 0.025 px^2 (never
// reached above the blur, so not applied here) and its minPixelSize 2 a 1 px half-extent.
const STUDIO_TAIL = Math.exp( - 4 );
const STUDIO_BLUR = 0.075;
const STUDIO_MIN_HALF_EXTENT = 1;
const STUDIO_ALPHA_CLIP = 1 / 255;
// GAMEABLE EDIT 18 END
const COVARIANCE_FLATNESS = 1e-4;
const MIN_RAYCAST_OPACITY = 0.2;
const MAX_SCREEN_SPACE_SPLAT_SIZE = 1024;
const CLIP_XY = 1.4;

const _worldCenter = /*@__PURE__*/ new Vector3();
const _viewCenter = /*@__PURE__*/ new Vector3();
const _worldScale = /*@__PURE__*/ new Vector3();
const _sortDirection = /*@__PURE__*/ new Vector3();
const _sortDepthRange = /*@__PURE__*/ new Vector2();
const _worldMatrixInverse = /*@__PURE__*/ new Matrix4();
const _modelViewMatrix = /*@__PURE__*/ new Matrix4();
const _inverseMatrix = /*@__PURE__*/ new Matrix4();
const _ray = /*@__PURE__*/ new Ray();
const _sphere = /*@__PURE__*/ new Sphere();
const _covarianceMatrix = /*@__PURE__*/ new Matrix3();
const _originOffset = /*@__PURE__*/ new Vector3();
const _mDirection = /*@__PURE__*/ new Vector3();
const _mOriginOffset = /*@__PURE__*/ new Vector3();
const _vector = /*@__PURE__*/ new Vector3();
// GAMEABLE EDIT 9 BEGIN

/**
 * Thrown when a splat is asked to do something it cannot do.
 *
 * Edit 1 throws it for a dynamic splat asked for spherical-harmonics degree above 0, and
 * edit 9 for `setSortCenters` on a static splat, which sorts from its own geometry.
 */
class SplatUnsupportedError extends Error {

	constructor( message ) {

		super( message );
		this.name = 'SplatUnsupportedError';

	}

}
// GAMEABLE EDIT 9 END

/**
 * A minimal renderer for 3D Gaussian splat geometry.
 *
 * Note that this class can only be used with {@link WebGPURenderer}. The
 * `forceWebGL` fallback of {@link WebGPURenderer} is supported, but
 * {@link WebGLRenderer} is not. Import maps or package exports must resolve
 * both `three/webgpu` and `three/tsl`.
 *
 * ```js
 * const splats = new GaussianSplat( geometry );
 * scene.add( splats );
 * ```
 *
 * @augments Mesh
 * @three_import import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
 */
class GaussianSplat extends Mesh {

	/**
	 * Constructs a new Gaussian splat mesh.
	 *
	 * @param {BufferGeometry} splatGeometry - The splat geometry to render. Higher-order spherical harmonics attributes must use packed `Uint32Array` words from {@link createGaussianSplatGeometry} (`SH_BAND_WORDS[ degree ]` words per splat, four clamped-byte coefficients per word).
	 * @param {Object} [options] - Options.
	 * @param {boolean} [options.autoSort=true] - Whether to sort automatically in `onBeforeRender`.
	 */
	constructor( splatGeometry, { autoSort = true } = {} ) {

		// GAMEABLE EDIT 1 BEGIN
		// Dynamic capacity. `new AnimatedGaussianSplat( { capacity, boundingSphere } )` allocates
		// `capacity` gaussians of zero-filled storage and keeps no CPU mirror at all. The
		// descriptor is swapped for a stand-in that answers the four reads upstream makes below,
		// every one of them O(1): three `getAttribute` calls (whose `array` is null, which routes
		// createStorageBuffers to the no-repack path), `getSphericalHarmonicsDegree` (which
		// returns 0 for anything that is not a BufferGeometry) and the two bounding-volume null
		// checks. Nothing below this point knows the difference.
		const dynamicDescriptor = isDynamicDescriptor( splatGeometry ) ? splatGeometry : null;

		if ( dynamicDescriptor !== null ) splatGeometry = createDynamicStandIn( dynamicDescriptor );
		// GAMEABLE EDIT 1 END
		const positionAttribute = splatGeometry.getAttribute( 'position' );
		const covarianceAttribute = splatGeometry.getAttribute( 'covariance' );
		const colorAttribute = splatGeometry.getAttribute( 'color' );
		const sphericalHarmonicsDegree = getSphericalHarmonicsDegree( splatGeometry );
		const count = positionAttribute.count;

		if ( splatGeometry.boundingBox === null ) splatGeometry.computeBoundingBox();
		if ( splatGeometry.boundingSphere === null ) splatGeometry.computeBoundingSphere();

		const geometry = createGeometry( count );
		const buffers = createStorageBuffers( count, positionAttribute.array, covarianceAttribute.array, colorAttribute.array, {
			degree: sphericalHarmonicsDegree,
			sh1: sphericalHarmonicsDegree >= 1 ? splatGeometry.getAttribute( 'sphericalHarmonics1' ).array : undefined,
			sh2: sphericalHarmonicsDegree >= 2 ? splatGeometry.getAttribute( 'sphericalHarmonics2' ).array : undefined,
			sh3: sphericalHarmonicsDegree >= 3 ? splatGeometry.getAttribute( 'sphericalHarmonics3' ).array : undefined
		} );
		// GAMEABLE EDIT 14 BEGIN
		// What the packed colour bytes mean. 'linear' is upstream's assumption (and the default
		// here; gameable/splat's wrappers default to 'srgb'). 'srgb' (a cloud trained blending its
		// sRGB values: nearly all of them) decodes each gaussian's colour to linear in the vertex
		// shader, after its spherical harmonics, so tint, light and shadow work in linear light;
		// edit 20 encodes it back, and only an sRGB pass draws it, blending on sRGB values.
		// A static geometry says it the same way, on `userData.colorSpace` (createSplatObject's
		// `colorSpace` option).
		const staticColorSpace = dynamicDescriptor === null && splatGeometry.userData !== undefined ? splatGeometry.userData.colorSpace : undefined;
		buffers.colorSpace = dynamicDescriptor !== null && dynamicDescriptor.colorSpace !== undefined ? dynamicDescriptor.colorSpace : ( staticColorSpace !== undefined ? staticColorSpace : 'linear' );
		if ( buffers.colorSpace !== 'linear' && buffers.colorSpace !== 'srgb' ) throw new RangeError( 'Splat colorSpace must be linear or srgb' );
		// GAMEABLE EDIT 14 END
		// GAMEABLE EDIT 18 BEGIN
		// The kernel a dynamic splat draws with: three's (2 sigma, opacity reduced as the 2D blur
		// grows) or the Gameable studio's ('studio': 2.83 sigma with the tail subtracted to reach 0
		// there, and the trained opacity as it is), which is what exported characters were made on.
		buffers.kernel = dynamicDescriptor !== null && dynamicDescriptor.kernel !== undefined ? dynamicDescriptor.kernel : 'three';
		if ( buffers.kernel !== 'three' && buffers.kernel !== 'studio' ) throw new RangeError( 'Splat kernel must be three or studio' );
		// GAMEABLE EDIT 18 END
		// GAMEABLE EDIT 19 BEGIN
		// A multiplier on every gaussian's colour (`setColorScale`), after the colour-space decode:
		// a tint and an exposure to fit a character into the light of a scene. White by default.
		buffers.colorScale = uniform( new Vector3( 1, 1, 1 ) );
		// GAMEABLE EDIT 19 END
		// GAMEABLE EDIT 20 BEGIN
		// An sRGB cloud was trained blending its stored sRGB values, so it is drawn only by an sRGB
		// pass (gameable/core's attachSrgbPass), which sets this to 1 while it draws it; its colour
		// then leaves the vertex stage encoded again. At 0 the cloud draws nothing.
		buffers.srgbOutput = buffers.colorSpace === 'srgb' ? uniform( 0 ) : null;
		// GAMEABLE EDIT 20 END
		const localCameraPosition = uniform( new Vector3() );
		const sphericalHarmonicsComputeNode = createSphericalHarmonicsComputeNode( buffers, localCameraPosition );
		const sort = new CountingSort( count, { binCount: BIN_COUNT, workgroupSize: WORKGROUP_SIZE } );
		const materialNodes = createMaterialNodes( buffers, sort, localCameraPosition );
		const material = createMaterial( materialNodes.vertexNode, materialNodes.fragmentNode );

		super( geometry, material );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isGaussianSplat = true;

		this.type = 'GaussianSplat';

		/**
		 * The source splat geometry.
		 *
		 * @type {BufferGeometry}
		 */
		this.splatGeometry = splatGeometry;

		/**
		 * The bounding box of the splats. Can be computed via {@link GaussianSplat#computeBoundingBox}.
		 *
		 * @type {?Box3}
		 * @default null
		 */
		this.boundingBox = null;

		/**
		 * The bounding sphere of the splats. Can be computed via {@link GaussianSplat#computeBoundingSphere}.
		 *
		 * @type {?Sphere}
		 * @default null
		 */
		this.boundingSphere = null;

		/**
		 * Whether to sort automatically in `onBeforeRender`.
		 *
		 * @type {boolean}
		 */
		this.autoSort = autoSort;

		this._buffers = buffers;
		// GAMEABLE EDIT 14 BEGIN
		/** What the colour buffer's bytes mean: 'linear' (upstream) or 'srgb' (decoded per gaussian, see edit 20). */
		this.colorSpace = buffers.colorSpace;
		// GAMEABLE EDIT 14 END
		// GAMEABLE EDIT 20 BEGIN
		/** For an sRGB cloud, the switch an sRGB pass sets to 1 while it draws it; else null. */
		this.srgbOutput = buffers.srgbOutput;
		this._srgbPassWarned = false;
		// GAMEABLE EDIT 20 END
		this._sort = sort;
		this._sortMatrix = uniform( new Matrix4() );
		this._sortDepthRange = uniform( new Vector2( 0, 1 ) );
		this._sortInitialized = false;
		this._lastSortDirection = new Vector3();
		this._localCameraPosition = localCameraPosition;
		this._sphericalHarmonicsComputeNode = sphericalHarmonicsComputeNode;
		this._sphericalHarmonicsInitialized = false;
		this._lastSphericalHarmonicsCameraMatrix = new Matrix4();
		this._lastSphericalHarmonicsWorldMatrix = new Matrix4();
		this._sphericalHarmonicsVertexNode = materialNodes.sphericalHarmonicsVertexNode;
		this._precomputedSphericalHarmonicsVertexNode = materialNodes.vertexNode;
		this._positionAttribute = positionAttribute;

		const centerRead = buffers.centerRead;
		const sortMatrix = this._sortMatrix;
		const sortDepthRange = this._sortDepthRange;

		sort.setBinNode( () => {

			const center = centerRead.element( instanceIndex ).xyz.toVar( 'center' );
			const viewCenter = sortMatrix.mul( vec4( center, 1 ) ).xyz.toVar( 'viewCenter' );
			const depth = viewCenter.z.negate().toVar( 'depth' );
			const range = max( sortDepthRange.y.sub( sortDepthRange.x ), 0.0001 ).toVar( 'range' );
			const normalized = depth.sub( sortDepthRange.x ).div( range ).clamp( 0, 1 ).toVar( 'normalized' );
			const depthBin = uint( normalized.mul( BIN_COUNT - 1 ) ).toVar( 'depthBin' );

			return uint( BIN_COUNT - 1 ).sub( depthBin );

		} );

		this.onBeforeRender = ( renderer, scene, camera ) => {

			// GAMEABLE EDIT 20 BEGIN
			if ( this.srgbOutput !== null && this.srgbOutput.value < 0.5 && this._srgbPassWarned === false ) {

				this._srgbPassWarned = true;
				console.warn( 'GaussianSplat: an sRGB splat draws only through an sRGB pass; attach one to its scene (@gameable/core\'s attachSrgbPass). Nothing is drawn here.' );

			}
			// GAMEABLE EDIT 20 END
			const vertexNode = renderer.backend && renderer.backend.isWebGLBackend === true ?
				this._sphericalHarmonicsVertexNode :
				this._precomputedSphericalHarmonicsVertexNode;

			if ( vertexNode !== null && material.vertexNode !== vertexNode ) {

				material.vertexNode = vertexNode;
				material.needsUpdate = true;

			}

			this.updateSphericalHarmonics( renderer, camera );

			if ( this.autoSort === true ) {

				this.updateSort( renderer, camera );

			}

		};
		// GAMEABLE EDIT 1 BEGIN

		/**
		 * Whether this splat was constructed from a capacity rather than from geometry.
		 *
		 * @type {boolean}
		 * @readonly
		 */
		this._dynamic = dynamicDescriptor !== null;

		// Nothing mirrors the GPU data on the CPU, so there is no source geometry to keep.
		if ( this._dynamic === true ) this.splatGeometry = null;

		// GAMEABLE EDIT 1 END
		// GAMEABLE EDIT 6 BEGIN
		// Owner-supplied bounds. Zero-filled centers would give a degenerate (radius 0) sphere,
		// which collapses the sort's depth range onto one bin, so the owner declares up front
		// where the gaussians are going to be. Culling is off because a producer can move them
		// outside the declared sphere between two frames and the CPU would never know.
		if ( this._dynamic === true ) {

			const sphere = dynamicDescriptor.boundingSphere;

			this.boundingSphere = sphere !== undefined && sphere !== null ?
				new Sphere( new Vector3().copy( sphere.center ), sphere.radius ) :
				new Sphere( new Vector3(), 1 );
			this.frustumCulled = false;

		}
		// GAMEABLE EDIT 6 END

	}

	/**
	 * Updates the view-dependent spherical harmonics colors if the camera or
	 * mesh transform has changed.
	 *
	 * @param {Renderer} renderer - The renderer.
	 * @param {Camera} camera - The camera used for rendering.
	 * @return {boolean} Whether a compute pass was dispatched this call.
	 */
	// GAMEABLE EDIT 13 BEGIN
	/** Configure optional environment diffuse lighting; null restores captured radiance. */
	setEnvironmentLighting( options ) {

		if ( options !== null ) {

			if ( ! Array.isArray( options.radianceSH ) || options.radianceSH.length !== 9 ||
				options.radianceSH.some( c => ! Array.isArray( c ) || c.length !== 3 || c.some( v => ! Number.isFinite( v ) ) ) ) {

				throw new RangeError( 'Splat lighting needs nine finite RGB radiance SH coefficients' );

			}

			for ( const key of [ 'emissionWeight', 'diffuseWeight' ] ) {

				if ( options[ key ] !== undefined && ( ! Number.isFinite( options[ key ] ) || options[ key ] < 0 ) ) throw new RangeError( 'Splat lighting weights must be finite and nonnegative' );

			}

			if ( options.pointLights !== undefined && ( ! Array.isArray( options.pointLights ) || options.pointLights.length > 16 || options.pointLights.some( light => ! light?.isPointLight ) ) ) throw new RangeError( 'Splat lighting supports up to sixteen PointLights' );
			if ( options.twoSided !== undefined && typeof options.twoSided !== 'boolean' ) throw new RangeError( 'Splat lighting twoSided must be boolean' );
			if ( options.pointLightSoftness !== undefined && ( ! Number.isFinite( options.pointLightSoftness ) || options.pointLightSoftness <= 0 ) ) throw new RangeError( 'Splat lighting pointLightSoftness must be finite and positive' );
			if ( options.normalOrigin !== undefined && ( options.normalOrigin.length !== 3 || options.normalOrigin.some( v => ! Number.isFinite( v ) ) ) ) throw new RangeError( 'Splat lighting normalOrigin must be a finite vec3' );
			if ( options.inputColorSpace !== undefined && options.inputColorSpace !== 'linear' && options.inputColorSpace !== 'srgb' ) throw new RangeError( 'Splat lighting inputColorSpace must be linear or srgb' );

		}

		this._buffers.environmentLighting = options === null ? null : {
			radianceSH: options.radianceSH.map( c => [ ...c ] ),
			emissionWeight: options.emissionWeight ?? 0.25,
			diffuseWeight: options.diffuseWeight ?? 0.75,
			normalOrigin: options.normalOrigin ? [ ...options.normalOrigin ] : ( this.boundingSphere?.center.toArray() ?? [ 0, 0, 0 ] ),
			inputColorSpace: options.inputColorSpace ?? 'linear',
			twoSided: options.twoSided ?? false,
			pointLightSoftness: options.pointLightSoftness ?? 0.25,
			// Keep the light references; their mutable properties are sampled into uniforms.
			pointLights: ( options.pointLights ?? [] ).map( light => {

				const position = new Vector3();
				const color = new Vector3();
				return {
					position: uniform( position ).onRenderUpdate( () => light.getWorldPosition( position ) ),
					color: uniform( color ).onRenderUpdate( () => color.set( light.color.r, light.color.g, light.color.b ).multiplyScalar( light.visible ? light.intensity : 0 ) ),
					distance: uniform( light.distance ).onRenderUpdate( () => light.distance ),
					decay: uniform( light.decay ).onRenderUpdate( () => light.decay )
				};

			} )
		};
		const nodes = createMaterialNodes( this._buffers, this._sort, this._localCameraPosition );
		this._sphericalHarmonicsVertexNode = nodes.sphericalHarmonicsVertexNode;
		this._precomputedSphericalHarmonicsVertexNode = nodes.vertexNode;
		this.material.vertexNode = nodes.vertexNode;
		this.material.colorNode = nodes.fragmentNode;
		this.material.needsUpdate = true;

	}
	// GAMEABLE EDIT 13 END
	// GAMEABLE EDIT 15 BEGIN
	/**
	 * Scale each fragment's opacity by a node the owner builds from the splat's view-space
	 * centre (a vec3 node), or null to draw as upstream. Used by a character's mouth to fade
	 * the face's points behind the lips' line where the mouth's inside shows.
	 *
	 * @param {?function(Node): Node} builder - Returns a float node, the factor.
	 */
	setFragmentAlpha( builder ) {

		if ( builder !== null && typeof builder !== 'function' ) throw new TypeError( 'Splat fragment alpha must be a function or null' );
		this._buffers.fragmentAlpha = builder;
		const nodes = createMaterialNodes( this._buffers, this._sort, this._localCameraPosition );
		this._sphericalHarmonicsVertexNode = nodes.sphericalHarmonicsVertexNode;
		this._precomputedSphericalHarmonicsVertexNode = nodes.vertexNode;
		this.material.vertexNode = nodes.vertexNode;
		this.material.colorNode = nodes.fragmentNode;
		this.material.needsUpdate = true;

	}
	// GAMEABLE EDIT 15 END
	// GAMEABLE EDIT 19 BEGIN
	/**
	 * Multiply every gaussian's colour (linear, after the colour-space decode): a tint and an
	 * exposure. (1, 1, 1) draws the colours as they are. A uniform: no rebuild, cheap per frame.
	 *
	 * @param {number} r - Red multiplier.
	 * @param {number} g - Green multiplier.
	 * @param {number} b - Blue multiplier.
	 */
	setColorScale( r, g, b ) {

		this._buffers.colorScale.value.set( r, g, b );

	}
	// GAMEABLE EDIT 19 END
	// GAMEABLE EDIT 16 BEGIN
	/**
	 * Darken each gaussian a key light's depth map says is blocked, and each gaussian on the floor
	 * under a character's feet, or pass null to draw as before. Evaluated at each gaussian's
	 * centre in the vertex stage, so the cost follows the gaussian count, not the screen. It keeps
	 * edits 13 and 15's state and rebuilds the material the same way they do.
	 *
	 * @param {?Object} options - See `createShadowReceiver`.
	 */
	setShadowReceiver( options ) {

		this._buffers.shadowReceiver = options === null ? null : createShadowReceiver( options );
		const nodes = createMaterialNodes( this._buffers, this._sort, this._localCameraPosition );
		this._sphericalHarmonicsVertexNode = nodes.sphericalHarmonicsVertexNode;
		this._precomputedSphericalHarmonicsVertexNode = nodes.vertexNode;
		this.material.vertexNode = nodes.vertexNode;
		this.material.colorNode = nodes.fragmentNode;
		this.material.needsUpdate = true;

	}
	// GAMEABLE EDIT 16 END
	updateSphericalHarmonics( renderer, camera ) {

		if ( this._sphericalHarmonicsComputeNode === null ) return false;

		const isWebGLBackend = renderer.backend && renderer.backend.isWebGLBackend === true;

		if ( this._sphericalHarmonicsInitialized === true &&
			camera.matrixWorld.equals( this._lastSphericalHarmonicsCameraMatrix ) &&
			this.matrixWorld.equals( this._lastSphericalHarmonicsWorldMatrix ) &&
			( isWebGLBackend === true || this._buffers.sphericalHarmonicsContributionRead !== undefined ) ) {

			return false;

		}

		if ( isWebGLBackend === true ) {

			enableWebGLBuffers( this._buffers );

		}

		_worldMatrixInverse.copy( this.matrixWorld ).invert();
		this._localCameraPosition.value.setFromMatrixPosition( camera.matrixWorld ).applyMatrix4( _worldMatrixInverse );

		this._lastSphericalHarmonicsCameraMatrix.copy( camera.matrixWorld );
		this._lastSphericalHarmonicsWorldMatrix.copy( this.matrixWorld );
		this._sphericalHarmonicsInitialized = true;

		if ( isWebGLBackend === true ) return false;

		ensureSphericalHarmonicsContributionBuffer( this._buffers );
		renderer.compute( this._sphericalHarmonicsComputeNode );

		return true;

	}

	/**
	 * Computes the bounding box of the splats, updating {@link GaussianSplat#boundingBox}.
	 *
	 * Each splat is expanded by its own extent rather than treated as a point, so the bounds cover
	 * what is drawn.
	 */
	computeBoundingBox() {
		// GAMEABLE EDIT 8 BEGIN

		// Dynamic mode has no CPU mirror to scan. The owner's sphere is the only bound there,
		// and it is set in the constructor or by setBoundingSphere().
		if ( this._dynamic === true ) return;

		// GAMEABLE EDIT 8 END

		if ( this.boundingBox === null ) this.boundingBox = new Box3();

		this.boundingBox.makeEmpty();

		const positionAttribute = this.splatGeometry.getAttribute( 'position' );
		const covarianceAttribute = this.splatGeometry.getAttribute( 'covariance' );
		const count = positionAttribute.count;

		for ( let i = 0; i < count; i ++ ) {

			const x = positionAttribute.getX( i );
			const y = positionAttribute.getY( i );
			const z = positionAttribute.getZ( i );

			const c00 = covarianceAttribute.getComponent( i, 0 );
			const c11 = covarianceAttribute.getComponent( i, 3 );
			const c22 = covarianceAttribute.getComponent( i, 5 );

			// the radius of the drawn largest extent
			const radius = SPLAT_KERNEL_CUTOFF * Math.sqrt( Math.max( c00, c11, c22 ) );

			this.boundingBox.expandByPoint( _vector.set( x - radius, y - radius, z - radius ) );
			this.boundingBox.expandByPoint( _vector.set( x + radius, y + radius, z + radius ) );

		}

	}

	/**
	 * Computes the bounding sphere of the splats, updating {@link GaussianSplat#boundingSphere}.
	 *
	 * Each splat is expanded by its own extent rather than treated as a point, so the bounds cover
	 * what is drawn.
	 */
	computeBoundingSphere() {
		// GAMEABLE EDIT 8 BEGIN

		// See computeBoundingBox. The null guard matters because _updateSortUniforms() calls
		// this when boundingSphere is null, and it must not be left null afterwards.
		if ( this._dynamic === true ) {

			if ( this.boundingSphere === null ) this.boundingSphere = new Sphere( new Vector3(), 1 );

			return;

		}

		// GAMEABLE EDIT 8 END

		if ( this.boundingSphere === null ) this.boundingSphere = new Sphere();

		this.computeBoundingBox();
		this.boundingBox.getBoundingSphere( this.boundingSphere );

		const positionAttribute = this.splatGeometry.getAttribute( 'position' );
		const covarianceAttribute = this.splatGeometry.getAttribute( 'covariance' );
		const count = positionAttribute.count;
		const center = this.boundingSphere.center;

		let maxRadius = 0;

		for ( let i = 0; i < count; i ++ ) {

			const x = positionAttribute.getX( i );
			const y = positionAttribute.getY( i );
			const z = positionAttribute.getZ( i );

			const c00 = covarianceAttribute.getComponent( i, 0 );
			const c11 = covarianceAttribute.getComponent( i, 3 );
			const c22 = covarianceAttribute.getComponent( i, 5 );

			// the radius of the drawn largest extent
			const radius = SPLAT_KERNEL_CUTOFF * Math.sqrt( Math.max( c00, c11, c22 ) );

			maxRadius = Math.max( maxRadius, center.distanceTo( _vector.set( x, y, z ) ) + radius );

		}

		this.boundingSphere.radius = maxRadius;

	}

	/**
	 * Computes intersection points between a casted ray and the splats.
	 *
	 * @param {Raycaster} raycaster - The raycaster.
	 * @param {Array<Object>} intersects - The target array that holds the intersection points.
	 */
	raycast( raycaster, intersects ) {
		// GAMEABLE EDIT 8 BEGIN

		// Raycasting a dynamic splat would read a CPU mirror that does not exist. Pick against
		// the character's collider instead.
		if ( this._dynamic === true ) return;

		// GAMEABLE EDIT 8 END

		const matrixWorld = this.matrixWorld;

		// Checking boundingSphere distance to ray

		if ( this.boundingSphere === null ) this.computeBoundingSphere();

		_sphere.copy( this.boundingSphere );
		_sphere.applyMatrix4( matrixWorld );

		if ( raycaster.ray.intersectsSphere( _sphere ) === false ) return;

		//

		_inverseMatrix.copy( matrixWorld ).invert();
		_ray.copy( raycaster.ray ).applyMatrix4( _inverseMatrix );

		// test with bounding box in local space

		if ( this.boundingBox !== null ) {

			if ( _ray.intersectsBox( this.boundingBox ) === false ) return;

		}

		const positionAttribute = this.splatGeometry.getAttribute( 'position' );
		const covarianceAttribute = this.splatGeometry.getAttribute( 'covariance' );
		const colorAttribute = this.splatGeometry.getAttribute( 'color' );
		const count = positionAttribute.count;

		for ( let i = 0; i < count; i ++ ) {

			computeRayIntersection( positionAttribute, covarianceAttribute, colorAttribute, i, matrixWorld, raycaster, intersects, this );

		}

	}

	// GAMEABLE EDIT 4 BEGIN
	/**
	 * Marks the gaussians as changed, so the next {@link GaussianSplat#updateSort} re-sorts
	 * whatever the camera did.
	 *
	 * Upstream only re-sorts when the view direction has moved further than
	 * `SORT_DIRECTION_THRESHOLD` (0.9995, about 1.81 degrees). A producer that rewrites the
	 * centers every frame invalidates the depth order even with a completely static camera,
	 * so it calls this after every compute pass that touched the buffers.
	 */
	markGaussiansChanged() {

		this._sortInitialized = false;

	}

	// GAMEABLE EDIT 4 END
	// GAMEABLE EDIT 9 BEGIN
	/**
	 * Hands the WebGL fallback's CPU sort the centres to sort by. Dynamic mode only.
	 *
	 * The fallback sorts on the CPU from `_positionAttribute.array` (xyz per gaussian), and a
	 * dynamic splat keeps no CPU copy of what its producer writes on the GPU. The owner reads
	 * the centres back and passes them here; the next `updateSort` sorts from them with the
	 * current camera. Until the first call there is nothing to sort from, and `updateSort`
	 * draws in index order instead.
	 *
	 * @param {Float32Array} centers - `count * 3` floats, xyz per gaussian in local space. Kept
	 * by reference: the owner may rewrite it in place and call this again.
	 */
	setSortCenters( centers ) {

		if ( this._dynamic !== true ) {

			throw new SplatUnsupportedError( 'AnimatedGaussianSplat: setSortCenters is for dynamic splats; a static splat sorts from its own geometry.' );

		}

		this._positionAttribute.array = centers;
		this._sortInitialized = false;

	}

	// GAMEABLE EDIT 9 END
	// GAMEABLE EDIT 6 BEGIN
	/**
	 * Declares where the gaussians are, in local space.
	 *
	 * Dynamic mode never derives this: the sort's depth range is built from it, so a sphere
	 * that does not contain the splats quantises them into too few bins and the order degrades.
	 *
	 * @param {Vector3} center - Center of the sphere, in local space.
	 * @param {number} radius - Radius of the sphere, in local units.
	 */
	setBoundingSphere( center, radius ) {

		if ( this.boundingSphere === null ) this.boundingSphere = new Sphere();

		this.boundingSphere.center.copy( center );
		this.boundingSphere.radius = radius;

	}

	// GAMEABLE EDIT 6 END
	// GAMEABLE EDIT 11 BEGIN
	/**
	 * Releases every GPU resource this splat allocated.
	 *
	 * Upstream has no `dispose`. A `GaussianSplat` owns four `StorageBufferAttribute`s in
	 * `_buffers`, a fifth allocated lazily by the WebGPU spherical-harmonics pre-pass, and a
	 * `CountingSort` — which has no `dispose` of its own in r186 — holding four more. Dropping
	 * the object leaks all of them; for a 250k-gaussian character that is about 2 MB of GPU
	 * memory per despawn.
	 *
	 * `BufferAttribute#dispose` only dispatches a `dispose` event, and nothing in three's
	 * renderer listens for one on a *storage* attribute (`Geometries.js` unregisters vertex and
	 * index attributes only), so the owner passes `release` to actually destroy the GPU buffer.
	 * `gameable/splat` routes that through `src/backendBuffers.ts`, the one file in the
	 * repository allowed to touch `renderer.backend`.
	 *
	 * Idempotent: a second call does nothing.
	 *
	 * @param {?Function} [release=null] - Called with each `StorageBufferAttribute` before it is
	 * disposed, to free the GPU buffer behind it.
	 */
	dispose( release = null ) {

		if ( this._disposed === true ) return;

		this._disposed = true;

		for ( const attribute of this.storageAttributes() ) {

			if ( release !== null ) release( attribute );

			attribute.dispose();

		}

		this.geometry.dispose();
		this.material.dispose();

	}

	/**
	 * Every `StorageBufferAttribute` this splat owns, deduplicated.
	 *
	 * Read and write nodes come in pairs over one attribute (`orderRead`/`orderWrite`,
	 * `binRead`/`binWrite`, the two spherical-harmonics contribution nodes), hence the set. The
	 * sort's bin, histogram and offset attributes are constructor locals in `CountingSort`, so
	 * they are reached through the storage nodes that wrap them.
	 *
	 * @return {Set<Object>} The attributes, each exactly once.
	 */
	storageAttributes() {

		const attributes = new Set();
		const buffers = this._buffers;

		const add = ( nodeOrAttribute ) => {

			if ( nodeOrAttribute === null || nodeOrAttribute === undefined ) return;

			const attribute = nodeOrAttribute.isNode === true ? nodeOrAttribute.value : nodeOrAttribute;

			if ( attribute !== null && attribute !== undefined ) attributes.add( attribute );

		};

		add( buffers.centerRead );
		add( buffers.covarianceARead );
		add( buffers.covarianceBRead );
		add( buffers.colorRead );
		add( buffers.sphericalHarmonicsContributionRead );

		for ( let degree = 1; degree <= buffers.sphericalHarmonicsDegree; degree ++ ) {

			add( buffers[ `sphericalHarmonics${ degree }Attribute` ] );

		}

		const sort = this._sort;

		add( sort.orderAttribute );
		add( sort.binRead );
		add( sort.histogramAtomic );
		add( sort.offsetAtomic );

		return attributes;

	}

	// GAMEABLE EDIT 11 END
	/**
	 * Updates the draw order if the camera or mesh orientation has changed enough
	 * to need a new sort.
	 *
	 * @param {Renderer} renderer - The renderer.
	 * @param {Camera} camera - The camera used for rendering.
	 * @return {boolean} Whether a sort was dispatched this call.
	 */
	updateSort( renderer, camera ) {
		// GAMEABLE EDIT 9 BEGIN

		// The WebGL fallback sorts on the CPU from `_positionAttribute.array`, which a dynamic
		// splat only has once its owner has read the centres back and called `setSortCenters`.
		// Until then there is nothing to sort from: keep the upstream order (the identity) and
		// still switch the storage reads to PBO textures, which the draw needs either way.
		if ( this._dynamic === true && renderer.backend && renderer.backend.isWebGLBackend === true && this._positionAttribute.array === null ) {

			enableWebGLBuffers( this._buffers );
			this._sort.enableWebGLBuffers();

			return false;

		}

		// GAMEABLE EDIT 9 END

		this.updateWorldMatrix( true, false );

		const needsSort = this._needsSort( camera );

		if ( this._sortInitialized === false || needsSort === true ) {

			this._updateSortUniforms( camera );

			if ( renderer.backend && renderer.backend.isWebGLBackend === true ) {

				enableWebGLBuffers( this._buffers );
				this._sort.enableWebGLBuffers();
				this._sortCPU();

			} else {

				this._sort.compute( renderer );

			}

			this._sortInitialized = true;
			this._lastSortDirection.copy( _sortDirection );

			return true;

		}

		return false;

	}

	_needsSort( camera ) {

		_modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse, this.matrixWorld );

		const e = _modelViewMatrix.elements;
		_sortDirection.set( e[ 2 ], e[ 6 ], e[ 10 ] ).normalize();

		return _sortDirection.dot( this._lastSortDirection ) < SORT_DIRECTION_THRESHOLD;

	}

	_updateSortUniforms( camera ) {

		this._sortMatrix.value.multiplyMatrices( camera.matrixWorldInverse, this.matrixWorld );

		if ( this.boundingSphere === null ) this.computeBoundingSphere();

		_worldCenter.copy( this.boundingSphere.center ).applyMatrix4( this.matrixWorld );
		_viewCenter.copy( _worldCenter ).applyMatrix4( camera.matrixWorldInverse );

		_worldScale.setFromMatrixScale( this.matrixWorld );

		const radius = this.boundingSphere.radius * Math.max( _worldScale.x, _worldScale.y, _worldScale.z );
		const depth = - _viewCenter.z;
		const nearDepth = Math.max( camera.near, depth - radius );
		const farDepth = Math.max( nearDepth + 0.0001, depth + radius );

		_sortDepthRange.set( nearDepth, farDepth );
		this._sortDepthRange.value.copy( _sortDepthRange );

	}

	_sortCPU() {

		const centers = this._positionAttribute.array;
		const matrix = this._sortMatrix.value.elements;
		const nearDepth = this._sortDepthRange.value.x;
		const range = Math.max( this._sortDepthRange.value.y - nearDepth, 0.0001 );
		const scale = ( BIN_COUNT - 1 ) / range;

		this._sort.computeCPU( ( i ) => {

			const i3 = i * 3;
			const depth = - ( matrix[ 2 ] * centers[ i3 ] + matrix[ 6 ] * centers[ i3 + 1 ] + matrix[ 10 ] * centers[ i3 + 2 ] + matrix[ 14 ] );
			const depthBin = Math.min( BIN_COUNT - 1, Math.max( 0, Math.floor( ( depth - nearDepth ) * scale ) ) );

			return BIN_COUNT - 1 - depthBin;

		} );

	}

}

// Intersects the ray with the ellipsoid the splat's covariance describes, which reduces to a
// quadratic in t whose smaller root is the near surface.
function computeRayIntersection( positionAttribute, covarianceAttribute, colorAttribute, index, matrixWorld, raycaster, intersects, object ) {

	// skip faint splats - cheapest possible rejection, a single attribute read
	if ( colorAttribute.getW( index ) < MIN_RAYCAST_OPACITY ) {

		return;

	}

	// the diagonal of the covariance bounds the splat's drawn extent (same radius used by
	// computeBoundingBox/computeBoundingSphere); reject rays that don't pass near the splat
	// at all before doing any of the more expensive matrix work below
	const c00 = covarianceAttribute.getComponent( index, 0 );
	const c11 = covarianceAttribute.getComponent( index, 3 );
	const c22 = covarianceAttribute.getComponent( index, 5 );
	const maxVariance = Math.max( c00, c11, c22 );

	if ( maxVariance <= 0 ) {

		return;

	}

	const center = _vector.fromBufferAttribute( positionAttribute, index );
	const boundingRadius = SPLAT_KERNEL_CUTOFF * Math.sqrt( maxVariance );

	if ( _ray.distanceSqToPoint( center ) > boundingRadius * boundingRadius ) {

		return;

	}

	// the attribute holds the upper triangle of the symmetric covariance
	const c01 = covarianceAttribute.getComponent( index, 1 );
	const c02 = covarianceAttribute.getComponent( index, 2 );
	const c12 = covarianceAttribute.getComponent( index, 4 );

	// splats are often flat enough to make the covariance singular, so the thinnest axis is floored
	// relative to the widest to keep the quadratic solvable
	const minVariance = maxVariance * COVARIANCE_FLATNESS;

	_covarianceMatrix.set(
		c00 + minVariance, c01, c02,
		c01, c11 + minVariance, c12,
		c02, c12, c22 + minVariance
	);

	const determinant = _covarianceMatrix.determinant();

	if ( determinant <= 0 ) {

		return;

	}

	// inverse( covariance ), applied below to the ray direction and to the origin offset
	_covarianceMatrix.invert();

	_mDirection.copy( _ray.direction ).applyMatrix3( _covarianceMatrix );

	// squared length of the ray direction in the ellipsoid's metric; must be positive for a valid covariance
	const a = _ray.direction.dot( _mDirection );

	if ( a <= 0 ) {

		return;

	}

	_originOffset.copy( _ray.origin ).sub( center );
	_mOriginOffset.copy( _originOffset ).applyMatrix3( _covarianceMatrix );

	const b = 2 * _originOffset.dot( _mDirection );
	const c = _originOffset.dot( _mOriginOffset ) - SPLAT_KERNEL_CUTOFF * SPLAT_KERNEL_CUTOFF;
	const discriminant = b * b - 4 * a * c;

	if ( discriminant < 0 ) {

		return;

	}

	const sqrtDiscriminant = Math.sqrt( discriminant );
	let t = ( - b - sqrtDiscriminant ) / ( 2 * a );

	// the near surface is behind the origin when the ray starts inside the splat
	if ( t < 0 ) {

		t = ( - b + sqrtDiscriminant ) / ( 2 * a );

	}

	if ( t < 0 ) {

		return;

	}

	const intersectPoint = new Vector3();
	_ray.at( t, intersectPoint ).applyMatrix4( matrixWorld );

	const distance = raycaster.ray.origin.distanceTo( intersectPoint );
	if ( distance < raycaster.near || distance > raycaster.far ) {

		return;

	}

	intersects.push( {

		distance: distance,
		point: intersectPoint,
		index: index,
		face: null,
		faceIndex: null,
		barycoord: null,
		object: object

	} );

}

// GAMEABLE EDIT 1 BEGIN
/**
 * Whether the constructor was handed `{ capacity, boundingSphere }` rather than a geometry.
 *
 * @param {BufferGeometry|Object} value - The constructor's first argument.
 * @return {boolean} True for a dynamic descriptor.
 */
function isDynamicDescriptor( value ) {

	return value !== null && typeof value === 'object' && value.isBufferGeometry !== true &&
		typeof value.capacity === 'number';

}

/**
 * The O(1) stand-in the dynamic constructor path runs on.
 *
 * It answers everything the constructor asks a geometry and nothing else. Deliberately not a
 * BufferGeometry: `getSphericalHarmonicsDegree` returns 0 for anything without
 * `isBufferGeometry`, which is the SH-degree-0 path dynamic mode supports.
 *
 * @param {Object} descriptor - `{ capacity, boundingSphere }`.
 * @return {Object} The stand-in.
 */
function createDynamicStandIn( descriptor ) {

	// Padded to the WebGL fallback's PBO texture shape (edit 17), on both backends.
	const capacity = padStorageCapacity( Math.max( 1, Math.floor( descriptor.capacity ) ) );
	const positionAttribute = { count: capacity, itemSize: 3, array: null };
	const emptyAttribute = { count: capacity, itemSize: 1, array: null };

	return {
		boundingBox: new Box3(),
		boundingSphere: new Sphere( new Vector3(), 1 ),
		getAttribute: ( name ) => name === 'position' ? positionAttribute : emptyAttribute
	};

}

// GAMEABLE EDIT 1 END
// GAMEABLE EDIT 17 BEGIN
/**
 * The storage capacity a dynamic splat really allocates for a requested one.
 *
 * On the WebGL fallback every storage buffer the draw reads is mirrored into a "PBO" texture
 * `2^ceil(log2(sqrt(n)))` texels wide, and `GLSLNodeBuilder.setupPBO` grows the attribute's
 * CPU array to fill it when the material is built. If a compute pass created the GL buffer
 * first, at the smaller size, the buffer-to-texture copy after every transform-feedback pass
 * overflows (`glTexSubImage2D ... overflow`) and nothing draws. Allocating the texture's
 * size up front removes the ordering hazard. The padded slots stay zero (colour 0 is alpha 0),
 * so they cost a few invisible instances and nothing else. Done on WebGPU too, because the
 * backend is not known when the splat is constructed, and because one capacity per request
 * keeps both backends indexing the same slots.
 *
 * @param {number} capacity - Requested gaussians, a positive integer.
 * @return {number} `width * height` of the PBO texture that holds `capacity` elements.
 */
function padStorageCapacity( capacity ) {

	const width = Math.pow( 2, Math.ceil( Math.log2( Math.sqrt( capacity ) ) ) );
	const height = Math.ceil( capacity / width );

	return width * height;

}

// GAMEABLE EDIT 17 END
function createGeometry( count ) {

	const geometry = new InstancedBufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( [
		- 2, - 2, 0,
		2, - 2, 0,
		2, 2, 0,
		- 2, 2, 0
	] ), 3 ) );
	geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
	geometry.instanceCount = count;

	return geometry;

}

function createStorageBuffers( count, centers, covariances, colors, sphericalHarmonics ) {

	const centerData = new Float32Array( count * 4 );
	const covarianceAData = new Float32Array( count * 4 );
	const covarianceBData = new Float32Array( count * 4 );
	const colorData = new Uint32Array( count );
	const sphericalHarmonicsDegree = sphericalHarmonics.degree;

	// GAMEABLE EDIT 1 BEGIN
	// Dynamic mode passes null arrays. The four typed arrays above are already zero-filled,
	// which is exactly the state a producer wants (color 0 means alpha 0 means invisible), so
	// the O(N) repack is skipped entirely: the dangling `else` hands the loop below to the
	// static path unchanged, which is what keeps this an insertion rather than a rewrite.
	if ( centers === null ) {

		if ( sphericalHarmonicsDegree !== 0 ) {

			throw new SplatUnsupportedError( 'AnimatedGaussianSplat: dynamic mode supports spherical-harmonics degree 0 only.' );

		}

	} else
	// GAMEABLE EDIT 1 END
	for ( let i = 0; i < count; i ++ ) {

		const i3 = i * 3;
		const i4 = i * 4;
		const i6 = i * 6;

		centerData[ i4 ] = centers[ i3 ];
		centerData[ i4 + 1 ] = centers[ i3 + 1 ];
		centerData[ i4 + 2 ] = centers[ i3 + 2 ];

		covarianceAData[ i4 ] = covariances[ i6 ];
		covarianceAData[ i4 + 1 ] = covariances[ i6 + 1 ];
		covarianceAData[ i4 + 2 ] = covariances[ i6 + 2 ];
		covarianceAData[ i4 + 3 ] = covariances[ i6 + 3 ];

		covarianceBData[ i4 ] = covariances[ i6 + 4 ];
		covarianceBData[ i4 + 1 ] = covariances[ i6 + 5 ];

		colorData[ i ] = ( colors[ i4 ] |
			colors[ i4 + 1 ] << 8 |
			colors[ i4 + 2 ] << 16 |
			colors[ i4 + 3 ] << 24 ) >>> 0;

	}

	const centerAttribute = new StorageBufferAttribute( centerData, 4 );
	const covarianceAAttribute = new StorageBufferAttribute( covarianceAData, 4 );
	const covarianceBAttribute = new StorageBufferAttribute( covarianceBData, 4 );
	const colorAttribute = new StorageBufferAttribute( colorData, 1 );

	const buffers = {
		count,
		sphericalHarmonicsDegree,
		webGLBuffersEnabled: false,
		centerRead: storage( centerAttribute, 'vec4', count ).toReadOnly(),
		covarianceARead: storage( covarianceAAttribute, 'vec4', count ).toReadOnly(),
		covarianceBRead: storage( covarianceBAttribute, 'vec4', count ).toReadOnly(),
		colorRead: storage( colorAttribute, 'uint', count ).toReadOnly()
	};
	// GAMEABLE EDIT 17 BEGIN
	// Dynamic mode: the four buffers a producer writes are `StorageInstancedBufferAttribute`s
	// over the same zero-filled arrays (the plain attributes above are dropped before anything
	// uploads them). On the WebGL fallback a TSL compute runs as transform feedback, and
	// `WebGLBackend.compute` only draws instanced, with `instanceIndex` = `gl_InstanceID`, when
	// its first attribute is instanced; otherwise every invocation reads and writes element 0.
	// WebGPU treats the two classes the same.
	if ( centers === null ) {

		buffers.centerRead = storage( new StorageInstancedBufferAttribute( centerData, 4 ), 'vec4', count ).toReadOnly();
		buffers.covarianceARead = storage( new StorageInstancedBufferAttribute( covarianceAData, 4 ), 'vec4', count ).toReadOnly();
		buffers.covarianceBRead = storage( new StorageInstancedBufferAttribute( covarianceBData, 4 ), 'vec4', count ).toReadOnly();
		buffers.colorRead = storage( new StorageInstancedBufferAttribute( colorData, 1 ), 'uint', count ).toReadOnly();

	}

	// GAMEABLE EDIT 17 END

	for ( let degree = 1; degree <= sphericalHarmonicsDegree; degree ++ ) {

		const words = SH_BAND_WORDS[ degree ];
		const attribute = new StorageBufferAttribute( sphericalHarmonics[ `sh${ degree }` ], 1 );

		buffers[ `sphericalHarmonics${ degree }Attribute` ] = attribute;
		buffers[ `sphericalHarmonics${ degree }Read` ] = storage( attribute, 'uint', count * words ).toReadOnly();
		buffers[ `sphericalHarmonics${ degree }Words` ] = words;

	}

	return buffers;

}

function ensureSphericalHarmonicsContributionBuffer( buffers ) {

	if ( buffers.sphericalHarmonicsContributionRead !== undefined ) return;

	// WebGPU stores one precomputed SH contribution per splat. The WebGL
	// fallback evaluates SH in the vertex shader because its transform-feedback
	// compute path cannot perform the packed buffer's indexed reads, so allocate
	// this additional buffer lazily only when the WebGPU pre-pass runs.
	const attribute = new StorageBufferAttribute( new Float32Array( buffers.count * 4 ), 4 );

	buffers.sphericalHarmonicsContributionRead = storage( attribute, 'vec4', buffers.count ).toReadOnly();
	buffers.sphericalHarmonicsContributionWrite = storage( attribute, 'vec4', buffers.count );

}

function enableWebGLBuffers( buffers ) {

	if ( buffers.webGLBuffersEnabled === true ) return;

	buffers.centerRead.setPBO( true );
	buffers.covarianceARead.setPBO( true );
	buffers.covarianceBRead.setPBO( true );
	buffers.colorRead.setPBO( true );

	for ( let degree = 1; degree <= buffers.sphericalHarmonicsDegree; degree ++ ) {

		buffers[ `sphericalHarmonics${ degree }Read` ].setPBO( true );

	}

	buffers.webGLBuffersEnabled = true;

}

function unpackSphericalHarmonicsCoefficients( buffer, splatIndex, words, componentCount ) {

	const coefficients = [];
	let remaining = componentCount;

	for ( let word = 0; word < words && remaining > 0; word ++ ) {

		const packed = buffer.element( splatIndex.mul( words ).add( word ) ).toVar();
		const bytesInWord = Math.min( 4, remaining );

		for ( let byteIndex = 0; byteIndex < bytesInWord; byteIndex ++ ) {

			const byte = packed.shiftRight( byteIndex * 8 ).bitAnd( 0xff );
			coefficients.push( float( byte ).sub( 128 ).div( 128 ) );

		}

		remaining -= bytesInWord;

	}

	return coefficients;

}

function assembleSphericalHarmonicsVectors( coefficients, name ) {

	const vectors = [];
	const vectorCount = coefficients.length / 3;

	for ( let i = 0; i < vectorCount; i ++ ) {

		const offset = i * 3;
		vectors.push( vec3(
			coefficients[ offset ],
			coefficients[ offset + 1 ],
			coefficients[ offset + 2 ]
		).toVar( `${ name }${ i }` ) );

	}

	return vectors;

}

function accumulateSphericalHarmonics( vectors, weights ) {

	let result = vectors[ 0 ].mul( weights[ 0 ] );

	for ( let i = 1; i < vectors.length; i ++ ) {

		result = result.add( vectors[ i ].mul( weights[ i ] ) );

	}

	return result;

}

function applySphericalHarmonicsBand( buffer, splatIndex, words, componentCount, name, weights ) {

	const coefficients = unpackSphericalHarmonicsCoefficients( buffer, splatIndex, words, componentCount );
	const vectors = assembleSphericalHarmonicsVectors( coefficients, name );

	return accumulateSphericalHarmonics( vectors, weights );

}

function applySphericalHarmonics( rgb, center, localCameraPosition, splatIndex, buffers ) {

	const viewDirection = normalize( center.sub( localCameraPosition ) ).toVar( 'sphericalHarmonicsViewDirection' );
	const x = viewDirection.x;
	const y = viewDirection.y;
	const z = viewDirection.z;

	rgb.addAssign( applySphericalHarmonicsBand(
		buffers.sphericalHarmonics1Read,
		splatIndex,
		buffers.sphericalHarmonics1Words,
		SH_BAND_COMPONENTS[ 1 ],
		'sh1_',
		[
			y.mul( - 0.4886025 ),
			z.mul( 0.4886025 ),
			x.mul( - 0.4886025 )
		]
	) );

	if ( buffers.sphericalHarmonicsDegree >= 2 ) {

		const xx = x.mul( x ).toVar( 'shXX' );
		const yy = y.mul( y ).toVar( 'shYY' );
		const zz = z.mul( z ).toVar( 'shZZ' );

		rgb.addAssign( applySphericalHarmonicsBand(
			buffers.sphericalHarmonics2Read,
			splatIndex,
			buffers.sphericalHarmonics2Words,
			SH_BAND_COMPONENTS[ 2 ],
			'sh2_',
			[
				x.mul( y ).mul( 1.0925484 ),
				y.mul( z ).mul( - 1.0925484 ),
				zz.mul( 2 ).sub( xx ).sub( yy ).mul( 0.3153915 ),
				x.mul( z ).mul( - 1.0925484 ),
				xx.sub( yy ).mul( 0.5462742 )
			]
		) );

		if ( buffers.sphericalHarmonicsDegree >= 3 ) {

			const xy = x.mul( y ).toVar( 'shXY' );

			rgb.addAssign( applySphericalHarmonicsBand(
				buffers.sphericalHarmonics3Read,
				splatIndex,
				buffers.sphericalHarmonics3Words,
				SH_BAND_COMPONENTS[ 3 ],
				'sh3_',
				[
					y.mul( xx.mul( 3 ).sub( yy ) ).mul( - 0.5900436 ),
					xy.mul( z ).mul( 2.8906114 ),
					y.mul( zz.mul( 4 ).sub( xx ).sub( yy ) ).mul( - 0.4570458 ),
					z.mul( zz.mul( 2 ).sub( xx.mul( 3 ) ).sub( yy.mul( 3 ) ) ).mul( 0.3731763 ),
					x.mul( zz.mul( 4 ).sub( xx ).sub( yy ) ).mul( - 0.4570458 ),
					z.mul( xx.sub( yy ) ).mul( 1.4453057 ),
					x.mul( xx.sub( yy.mul( 3 ) ) ).mul( - 0.5900436 )
				]
			) );

		}

	}

}

function createSphericalHarmonicsComputeNode( buffers, localCameraPosition ) {

	if ( buffers.sphericalHarmonicsDegree === 0 ) return null;

	return Fn( () => {

		const splatIndex = instanceIndex;
		const center = buffers.centerRead.element( splatIndex ).xyz.toVar( 'center' );
		const rgb = vec3( 0 ).toVar( 'sphericalHarmonicsContribution' );

		applySphericalHarmonics( rgb, center, localCameraPosition, splatIndex, buffers );
		buffers.sphericalHarmonicsContributionWrite.element( splatIndex ).assign( vec4( rgb, 0 ) );

	} )().compute( buffers.count, [ WORKGROUP_SIZE ] ).setName( 'GaussianSplatSphericalHarmonics' );

}

function createMaterialNodes( buffers, sort, localCameraPosition ) {

	// GAMEABLE EDIT 13 BEGIN
	const environmentLighting = buffers.environmentLighting;
	// GAMEABLE EDIT 13 END
	const splatUv = varyingProperty( 'vec2', 'vSplatUv' );
	const splatColor = varyingProperty( 'vec4', 'vSplatColor' );
	// GAMEABLE EDIT 15 BEGIN
	const fragmentAlpha = buffers.fragmentAlpha ?? null;
	const splatView = varyingProperty( 'vec3', 'vSplatView' );
	// GAMEABLE EDIT 15 END
	// GAMEABLE EDIT 16 BEGIN
	const shadowReceiver = buffers.shadowReceiver ?? null;
	// GAMEABLE EDIT 16 END

	const createVertexNode = ( usePrecomputedSphericalHarmonics ) => Fn( () => {

		const splatIndex = sort.orderRead.element( instanceIndex ).toVar( 'splatIndex' );
		const center = buffers.centerRead.element( splatIndex ).xyz.toVar( 'center' );
		const covA = buffers.covarianceARead.element( splatIndex ).toVar( 'covA' );
		const covB = buffers.covarianceBRead.element( splatIndex ).toVar( 'covB' );
		const color = unpackUnorm4x8( buffers.colorRead.element( splatIndex ) ).toVar( 'splatColor' );
		const rgb = color.rgb.toVar( 'splatRgb' );

		if ( buffers.sphericalHarmonicsDegree > 0 ) {

			if ( usePrecomputedSphericalHarmonics === true ) {

				rgb.addAssign( buffers.sphericalHarmonicsContributionRead.element( splatIndex ).rgb );

			} else {

				applySphericalHarmonics( rgb, center, localCameraPosition, splatIndex, buffers );

			}

		}

		splatUv.assign( positionGeometry.xy );
		// GAMEABLE EDIT 18 BEGIN
		// The studio's quad reaches sqrt(8) sigma, not 2: the same unit quad, scaled.
		if ( buffers.kernel === 'studio' ) splatUv.assign( positionGeometry.xy.mul( Math.SQRT2 ) );
		// GAMEABLE EDIT 18 END

		const viewCenter4 = highpModelViewMatrix.mul( vec4( center, 1 ) ).toVar( 'viewCenter4' );
		const viewCenter = viewCenter4.xyz.toVar( 'viewCenter' );
		// GAMEABLE EDIT 15 BEGIN
		if ( fragmentAlpha !== null ) splatView.assign( viewCenter );
		// GAMEABLE EDIT 15 END
		const centerClip = cameraProjectionMatrix.mul( viewCenter4 ).toVar( 'centerClip' );

		const m = highpModelViewMatrix;
		const r0 = vec3( m[ 0 ].x, m[ 1 ].x, m[ 2 ].x ).toVar( 'r0' );
		const r1 = vec3( m[ 0 ].y, m[ 1 ].y, m[ 2 ].y ).toVar( 'r1' );
		const r2 = vec3( m[ 0 ].z, m[ 1 ].z, m[ 2 ].z ).toVar( 'r2' );

		const cov0 = vec3( covA.x, covA.y, covA.z ).toVar( 'cov0' );
		const cov1 = vec3( covA.y, covA.w, covB.x ).toVar( 'cov1' );
		const cov2 = vec3( covA.z, covB.x, covB.y ).toVar( 'cov2' );

		const vc0 = vec3( dot( r0, cov0 ), dot( r0, cov1 ), dot( r0, cov2 ) ).toVar( 'vc0' );
		const vc1 = vec3( dot( r1, cov0 ), dot( r1, cov1 ), dot( r1, cov2 ) ).toVar( 'vc1' );
		const vc2 = vec3( dot( r2, cov0 ), dot( r2, cov1 ), dot( r2, cov2 ) ).toVar( 'vc2' );

		const c00 = dot( vc0, r0 ).toVar( 'c00' );
		const c01 = dot( vc0, r1 ).toVar( 'c01' );
		const c02 = dot( vc0, r2 ).toVar( 'c02' );
		const c11 = dot( vc1, r1 ).toVar( 'c11' );
		const c12 = dot( vc1, r2 ).toVar( 'c12' );
		const c22 = dot( vc2, r2 ).toVar( 'c22' );

		const z = min( viewCenter.z, - 0.01 ).toVar( 'z' );
		const invZ = float( 1 ).div( z ).toVar( 'invZ' );
		const invZ2 = invZ.mul( invZ ).toVar( 'invZ2' );
		const focal = cameraViewport.zw.mul( 0.5 ).mul( vec2( cameraProjectionMatrix[ 0 ].x, cameraProjectionMatrix[ 1 ].y ) ).toVar( 'focal' );

		const j00 = focal.x.negate().mul( invZ ).toVar( 'j00' );
		const j11 = focal.y.negate().mul( invZ ).toVar( 'j11' );
		const j02 = focal.x.mul( viewCenter.x ).mul( invZ2 ).toVar( 'j02' );
		const j12 = focal.y.mul( viewCenter.y ).mul( invZ2 ).toVar( 'j12' );

		const aBase = j00.mul( j00 ).mul( c00 )
			.add( j00.mul( j02 ).mul( c02 ).mul( 2 ) )
			.add( j02.mul( j02 ).mul( c22 ) )
			.toVar( 'cov2dABase' );
		const b = j00.mul( j11 ).mul( c01 )
			.add( j00.mul( j12 ).mul( c02 ) )
			.add( j02.mul( j11 ).mul( c12 ) )
			.add( j02.mul( j12 ).mul( c22 ) )
			.toVar( 'cov2dB' );
		const cBase = j11.mul( j11 ).mul( c11 )
			.add( j11.mul( j12 ).mul( c12 ).mul( 2 ) )
			.add( j12.mul( j12 ).mul( c22 ) )
			.toVar( 'cov2dCBase' );
		const a = aBase.add( KERNEL_2D_SIZE ).toVar( 'cov2dA' );
		const c = cBase.add( KERNEL_2D_SIZE ).toVar( 'cov2dC' );
		const detBase = aBase.mul( cBase ).sub( b.mul( b ) ).toVar( 'detBase' );
		const det = a.mul( c ).sub( b.mul( b ) ).toVar( 'det' );
		const alphaScale = sqrt( max( detBase.div( max( det, 0.000001 ) ), 0 ) ).toVar( 'alphaScale' );

		splatColor.assign( vec4( rgb.clamp( 0, 1 ), color.a.mul( alphaScale ) ) );
		// GAMEABLE EDIT 18 BEGIN
		// The studio keeps each gaussian's trained opacity: no reduction for the 2D blur.
		// Its blur is 0.075 px^2, a quarter of three's 0.3: four times the blur washed out skin detail.
		if ( buffers.kernel === 'studio' ) {

			splatColor.assign( vec4( splatColor.rgb, color.a ) );
			a.assign( aBase.add( STUDIO_BLUR ) );
			c.assign( cBase.add( STUDIO_BLUR ) );

		}
		// GAMEABLE EDIT 18 END
		// GAMEABLE EDIT 14 BEGIN
		if ( buffers.colorSpace === 'srgb' ) {

			// The file's colour, harmonics included, decoded to linear here, for tint, light and
			// shadow; edit 20 encodes it back when the sRGB pass draws it.
			rgb.assign( sRGBTransferEOTF( rgb.clamp( 0, 1 ) ) );
			splatColor.rgb.assign( rgb );

		}
		// GAMEABLE EDIT 14 END
		// GAMEABLE EDIT 19 BEGIN
		rgb.mulAssign( buffers.colorScale );
		splatColor.rgb.assign( rgb );
		// GAMEABLE EDIT 19 END
		// GAMEABLE EDIT 13 BEGIN
		if ( environmentLighting ) {

			// An 'srgb' buffer is already decoded above: the lighting must not decode it again.
			const lighting = buffers.colorSpace === 'srgb' ? { ...environmentLighting, inputColorSpace: 'linear' } : environmentLighting;
			splatColor.rgb.assign( environmentDiffuse( rgb, center, covA, covB, lighting ) );

		}
		// GAMEABLE EDIT 13 END
		// GAMEABLE EDIT 16 BEGIN
		if ( shadowReceiver ) splatColor.rgb.mulAssign( shadowFactorAt( modelWorldMatrix.mul( vec4( center, 1 ) ).xyz, shadowReceiver ) );
		// GAMEABLE EDIT 16 END
		// GAMEABLE EDIT 20 BEGIN
		// Tint, light and shadow were applied in linear light above; encode the result again.
		if ( buffers.srgbOutput !== null ) splatColor.rgb.assign( sRGBTransferOETF( splatColor.rgb.max( 0 ) ) );
		// GAMEABLE EDIT 20 END

		const halfTrace = a.add( c ).mul( 0.5 ).toVar( 'halfTrace' );
		const radius = sqrt( max( a.sub( c ).mul( 0.5 ).pow2().add( b.mul( b ) ), 0.0000001 ) ).toVar( 'radius' );
		const lambda1 = max( halfTrace.add( radius ), 0.0000001 ).toVar( 'lambda1' );
		const lambda2 = max( halfTrace.sub( radius ), 0.0000001 ).toVar( 'lambda2' );
		const axis1 = vec2( 1, 0 ).toVar( 'axis1' );

		If( radius.greaterThan( 0.00001 ), () => {

			const angle = atan( b.mul( 2 ), a.sub( c ) ).mul( 0.5 ).toVar( 'angle' );
			axis1.assign( vec2( cos( angle ), sin( angle ) ) );

		} );

		const axis2 = vec2( axis1.y.negate(), axis1.x ).toVar( 'axis2' );

		const scale1 = min( sqrt( lambda1 ), MAX_SCREEN_SPACE_SPLAT_SIZE ).toVar( 'scale1' );
		const scale2 = min( sqrt( lambda2 ), MAX_SCREEN_SPACE_SPLAT_SIZE ).toVar( 'scale2' );
		const offsetPixels = axis1.mul( positionGeometry.x ).mul( scale1 ).add( axis2.mul( positionGeometry.y ).mul( scale2 ) ).toVar( 'offsetPixels' );
		// GAMEABLE EDIT 18 BEGIN
		if ( buffers.kernel === 'studio' ) {

			offsetPixels.mulAssign( Math.SQRT2 );
			// PlayCanvas skips a gaussian whose larger half-extent is under 1 px: moved off screen.
			If( scale1.mul( Math.sqrt( 8 ) ).lessThan( STUDIO_MIN_HALF_EXTENT ), () => {

				offsetPixels.assign( vec2( 1e6, 1e6 ) );

			} );

		}
		// GAMEABLE EDIT 18 END
		const offsetNdc = offsetPixels.mul( 2 ).div( cameraViewport.zw ).toVar( 'offsetNdc' );
		const clip = centerClip.add( vec4( offsetNdc.mul( centerClip.w ), 0, 0 ) ).toVar( 'clip' );

		const clipLimit = centerClip.w.mul( CLIP_XY ).toVar( 'clipLimit' );

		If( viewCenter.z.greaterThanEqual( - 0.01 )
			.or( centerClip.z.lessThan( centerClip.w.negate() ) )
			.or( centerClip.z.greaterThan( centerClip.w ) )
			.or( centerClip.x.lessThan( clipLimit.negate() ) )
			.or( centerClip.x.greaterThan( clipLimit ) )
			.or( centerClip.y.lessThan( clipLimit.negate() ) )
			.or( centerClip.y.greaterThan( clipLimit ) ), () => {

			clip.assign( vec4( 2, 2, 2, 1 ) );

		} );
		// GAMEABLE EDIT 20 BEGIN
		// An sRGB cloud outside its pass: every gaussian off screen.
		if ( buffers.srgbOutput !== null ) {

			If( buffers.srgbOutput.lessThan( 0.5 ), () => {

				clip.assign( vec4( 2, 2, 2, 1 ) );

			} );

		}
		// GAMEABLE EDIT 20 END

		return clip;

	} )();

	const vertexNode = createVertexNode( true );
	const sphericalHarmonicsVertexNode = buffers.sphericalHarmonicsDegree > 0 ? createVertexNode( false ) : null;

	const fragmentNode = Fn( () => {

		const r2 = dot( splatUv, splatUv ).toVar( 'r2' );
		// GAMEABLE EDIT 18 BEGIN
		// The studio's falloff: exp(-r2/2) with its value at sqrt(8) sigma subtracted and rescaled,
		// so alpha reaches exactly 0 at the quad's edge instead of cutting off at 0.135.
		if ( buffers.kernel === 'studio' ) {

			If( r2.greaterThan( 8 ), () => {

				Discard();

			} );

			const falloff = exp( r2.mul( - 0.5 ) ).sub( STUDIO_TAIL ).div( 1 - STUDIO_TAIL ).max( 0 );
			const alpha = ( fragmentAlpha !== null ? falloff.mul( splatColor.a ).mul( fragmentAlpha( splatView ) ) : falloff.mul( splatColor.a ) ).toVar( 'studioAlpha' );
			// and its forward pass drops fragments under 1/255
			If( alpha.lessThan( STUDIO_ALPHA_CLIP ), () => {

				Discard();

			} );
			return vec4( splatColor.rgb, alpha );

		}

		// GAMEABLE EDIT 18 END

		If( r2.greaterThan( 4 ), () => {

			Discard();

		} );

		// GAMEABLE EDIT 15 BEGIN
		if ( fragmentAlpha !== null ) {

			return vec4( splatColor.rgb, exp( r2.mul( - 0.5 ) ).mul( splatColor.a ).mul( fragmentAlpha( splatView ) ) );

		}
		// GAMEABLE EDIT 15 END
		return vec4( splatColor.rgb, exp( r2.mul( - 0.5 ) ).mul( splatColor.a ) );

	} )();

	return { vertexNode, sphericalHarmonicsVertexNode, fragmentNode };

}

function createMaterial( vertexNode, fragmentNode ) {

	const material = new NodeMaterial();
	material.vertexNode = vertexNode;
	material.colorNode = fragmentNode;
	material.transparent = true;
	material.depthWrite = false;
	material.depthTest = true;
	material.forceSinglePass = true;
	material.fog = false;

	return material;

}

export { GaussianSplat };
// GAMEABLE EDIT 1 BEGIN
// The fork's public names. Upstream's `export { GaussianSplat }` is left in place so the
// stripped file stays byte-identical to upstream; nothing outside this directory imports it.
export { GaussianSplat as AnimatedGaussianSplat, SplatUnsupportedError };
// GAMEABLE EDIT 1 END
// GAMEABLE EDIT 17 BEGIN
export { padStorageCapacity };
// GAMEABLE EDIT 17 END
// GAMEABLE EDIT 13 BEGIN
/** Diffuse IBL from the current deformed covariance's shortest axis; opacity is untouched. */
function environmentDiffuse( rgb, center, covA, covB, options ) {

	// Scale before forming the adjugate so very small head splats remain well conditioned.
	const scale = max( max( covA.x, covA.w ), max( covB.y, 1e-20 ) );
	const a = covA.x.div( scale ).add( 0.0001 );
	const b = covA.y.div( scale );
	const c = covA.z.div( scale );
	const d = covA.w.div( scale ).add( 0.0001 );
	const e = covB.x.div( scale );
	const f = covB.y.div( scale ).add( 0.0001 );
	const row0 = vec3( d.mul( f ).sub( e.mul( e ) ), c.mul( e ).sub( b.mul( f ) ), b.mul( e ).sub( c.mul( d ) ) );
	const row1 = vec3( row0.y, a.mul( f ).sub( c.mul( c ) ), b.mul( c ).sub( a.mul( e ) ) );
	const row2 = vec3( row0.z, row1.z, a.mul( d ).sub( b.mul( b ) ) );
	const radial = center.sub( vec3( ...options.normalOrigin ) ).toVar( 'lightRadial' );
	const n = radial.add( vec3( 0.00001, 0.00002, 0.00003 ) ).normalize().toVar( 'lightNormal' );
	for ( let i = 0; i < 4; i ++ ) {

		const next = vec3( dot( row0, n ), dot( row1, n ), dot( row2, n ) ).toVar();
		If( dot( next, next ).greaterThan( 1e-20 ), () => n.assign( normalize( next ) ) );

	}
	If( dot( n, radial ).lessThan( 0 ), () => n.assign( n.negate() ) );
	const worldNormal = normalize( modelNormalMatrix.mul( n ) ).toVar( 'lightWorldNormal' );
	const x = worldNormal.x, y = worldNormal.y, z = worldNormal.z;
	const sh = options.radianceSH.map( c => vec3( ...c ) );
	const irradiance = sh[ 0 ].mul( 0.886227 )
		.add( sh[ 1 ].mul( y ).mul( 1.023328 ) )
		.add( sh[ 2 ].mul( z ).mul( 1.023328 ) )
		.add( sh[ 3 ].mul( x ).mul( 1.023328 ) )
		.add( sh[ 4 ].mul( x.mul( y ) ).mul( 0.858086 ) )
		.add( sh[ 5 ].mul( y.mul( z ) ).mul( 0.858086 ) )
		.add( sh[ 6 ].mul( z.mul( z ).mul( 0.743125 ).sub( 0.247708 ) ) )
		.add( sh[ 7 ].mul( x.mul( z ) ).mul( 0.858086 ) )
		.add( sh[ 8 ].mul( x.mul( x ).sub( y.mul( y ) ) ).mul( 0.429043 ) );
	const totalIrradiance = max( irradiance, vec3( 0 ) ).toVar( 'totalIrradiance' );
	if ( options.pointLights.length > 0 ) {

		// Gaussian vertices are expanded in clip space: ordinary positionWorld is incorrect.
		const worldCenter = modelWorldMatrix.mul( vec4( center, 1 ) ).xyz.toVar( 'lightWorldCenter' );
		for ( const light of options.pointLights ) {

			const delta = light.position.sub( worldCenter ).toVar();
			const distanceSq = dot( delta, delta ).toVar();
			const distance = sqrt( distanceSq.add( options.pointLightSoftness ** 2 ) );
			const attenuation = getDistanceAttenuation( { lightDistance: distance, cutoffDistance: light.distance, decayExponent: light.decay } );
			const cosine = dot( worldNormal, delta.div( sqrt( max( distanceSq, 1e-12 ) ) ) );
			const facing = options.twoSided ? cosine.abs() : max( cosine, 0 );
			totalIrradiance.addAssign( light.color.mul( attenuation ).mul( facing ) );

		}

	}
	const albedo = options.inputColorSpace === 'srgb' ? sRGBTransferEOTF( rgb.clamp( 0, 1 ) ) : rgb;
	return albedo.mul( totalIrradiance.mul( options.diffuseWeight / Math.PI ).add( options.emissionWeight ) );

}
// GAMEABLE EDIT 13 END
// GAMEABLE EDIT 16 BEGIN
/**
 * Check a shadow receiver's options and build its uniforms. Shared by `setShadowReceiver` and by
 * any mesh that wants the same shadow (`gameable/splat`'s ground catcher).
 *
 * @param {Object} options - `{ map: ?DepthTexture (null: contact only), matrix: Matrix4 (world to
 * the light's clip space, depth 0..1, kept current by the owner), tiles: ?Matrix4[] (instead of
 * `matrix`: one to four light cameras sharing the map as an atlas; `params.tileCount` says how
 * many are live, 1 covering the whole map, 2 to 4 a 2 x 2 grid), size: the map's texels, taps:
 * flat [dx, dy, weight, ...] in texels (weights summing to 1), params: { strength, bias,
 * tileCount, contactStrength, contactCount, contactRadius } read every render, contacts:
 * ?Vector4[] (one to sixteen floor points: xyz, weight in w) read every render }`.
 * @return {Object} The receiver, for `shadowFactorAt`.
 */
function createShadowReceiver( options ) {

	const map = options.map ?? null;
	const tiles = options.tiles ?? ( options.matrix ? [ options.matrix ] : [] );
	if ( map !== null && ( ! map.isDepthTexture || tiles.length < 1 || tiles.length > 4 || tiles.some( m => ! m?.isMatrix4 ) ) ) throw new TypeError( 'Splat shadows need a DepthTexture and one to four Matrix4s' );
	if ( map !== null && ( ! Array.isArray( options.taps ) || options.taps.length < 3 || options.taps.length % 3 !== 0 || options.taps.some( v => ! Number.isFinite( v ) ) ) ) throw new RangeError( 'Splat shadow taps are finite [dx, dy, weight] triples' );
	if ( map !== null && ! ( options.size >= 1 ) ) throw new RangeError( 'Splat shadow map size must be at least 1' );
	const contacts = options.contacts ?? null;
	if ( contacts !== null && ( ! Array.isArray( contacts ) || contacts.length < 1 || contacts.length > 16 || contacts.some( c => ! c?.isVector4 ) ) ) throw new RangeError( 'Splat shadows take one to sixteen Vector4 contact points' );
	if ( map === null && contacts === null ) throw new RangeError( 'Splat shadows need a depth map, contact points or both' );
	const params = options.params;
	return {
		map,
		size: options.size ?? 1,
		taps: map === null ? [] : [ ...options.taps ],
		tiles: map === null ? [] : tiles.map( m => uniform( m ).onRenderUpdate( () => m ) ),
		tileCount: uniform( 1 ).onRenderUpdate( () => params.tileCount ?? 1 ),
		strength: uniform( 0 ).onRenderUpdate( () => params.strength ),
		bias: uniform( 0 ).onRenderUpdate( () => params.bias ),
		contacts: contacts === null ? null : shadowUniformArray( contacts, 'vec4' ),
		contactCount: uniform( 0, 'int' ).onRenderUpdate( () => params.contactCount ?? 0 ),
		contactStrength: uniform( 0 ).onRenderUpdate( () => params.contactStrength ?? 0 ),
		contactRadius: uniform( 0.18 ).onRenderUpdate( () => params.contactRadius ?? 0.18 )
	};

}

/**
 * How much of a colour stays at a world point: 1 in the key light, `1 - strength` where the depth
 * map says the light is blocked (a weighted box of taps softens the edge), times the contact
 * shadow of the nearest foot on the floor.
 *
 * @param {Node<vec3>} worldPosition - The point, world space.
 * @param {Object} s - From `createShadowReceiver`.
 * @return {Node<float>} The factor.
 */
function shadowFactorAt( worldPosition, s ) {

	const world = vec3( worldPosition ).toVar( 'shadowWorld' );
	const factor = float( 1 ).toVar( 'shadowFactor' );
	if ( s.map !== null ) {

		if ( s.tiles.length === 1 ) {

			const lightClip = s.tiles[ 0 ].mul( vec4( world, 1 ) ).toVar( 'shadowClip' );
			const ndc = lightClip.xyz.div( lightClip.w ).toVar( 'shadowNdc' );
			const texel = vec2( ndc.x.mul( 0.5 ).add( 0.5 ), ndc.y.mul( - 0.5 ).add( 0.5 ) ).mul( s.size ).toVar( 'shadowTexel' );
			const reference = ndc.z.sub( s.bias ).toVar( 'shadowReference' );
			const lit = float( 0 ).toVar( 'shadowLit' );
			for ( let t = 0; t < s.taps.length; t += 3 ) {

				const at = shadowIvec2( texel.add( vec2( s.taps[ t ], s.taps[ t + 1 ] ) ).clamp( 0, s.size - 1 ) );
				lit.addAssign( shadowSelect( reference.lessThanEqual( shadowTextureLoad( s.map, at ) ), float( s.taps[ t + 2 ] ), float( 0 ) ) );

			}

			If( texel.x.greaterThanEqual( 0 ).and( texel.y.greaterThanEqual( 0 ) ).and( texel.x.lessThan( s.size ) ).and( texel.y.lessThan( s.size ) ).and( ndc.z.lessThanEqual( 1 ) ), () => {

				factor.assign( float( 1 ).sub( s.strength.mul( float( 1 ).sub( lit ) ) ) );

			} );

		} else {

			// An atlas: one live tile covers the whole map exactly as above; two to four live tiles
			// sit in a 2 x 2 grid, each a light camera of its own, with a one-texel gutter so a
			// tap never reads a neighbour. The first live tile that holds the point answers.
			const half = Math.floor( s.size / 2 );
			const tiled = s.tileCount.greaterThan( 1.5 );
			const side = shadowSelect( tiled, float( half - 2 ), float( s.size ) ).toVar( 'shadowSide' );
			const texel = vec2( 0 ).toVar( 'shadowTexel' );
			const low = vec2( 0 ).toVar( 'shadowLow' );
			const reference = float( 0 ).toVar( 'shadowReference' );
			const found = float( 0 ).toVar( 'shadowFound' );
			for ( let t = 0; t < s.tiles.length; t ++ ) {

				const lightClip = s.tiles[ t ].mul( vec4( world, 1 ) ).toVar( 'shadowClip' + t );
				const ndc = lightClip.xyz.div( lightClip.w ).toVar( 'shadowNdc' + t );
				const local = vec2( ndc.x.mul( 0.5 ).add( 0.5 ), ndc.y.mul( - 0.5 ).add( 0.5 ) ).mul( side ).toVar( 'shadowLocal' + t );
				const origin = shadowSelect( tiled, vec2( ( t % 2 ) * half + 1, Math.floor( t / 2 ) * half + 1 ), vec2( 0 ) );
				If( found.equal( 0 ).and( s.tileCount.greaterThan( t + 0.5 ) ).and( local.x.greaterThanEqual( 0 ) ).and( local.y.greaterThanEqual( 0 ) ).and( local.x.lessThan( side ) ).and( local.y.lessThan( side ) ).and( ndc.z.lessThanEqual( 1 ) ), () => {

					found.assign( 1 );
					low.assign( origin );
					texel.assign( local.add( origin ) );
					reference.assign( ndc.z.sub( s.bias ) );

				} );

			}

			const high = low.add( side.sub( 1 ) ).toVar( 'shadowHigh' );
			const lit = float( 0 ).toVar( 'shadowLit' );
			for ( let t = 0; t < s.taps.length; t += 3 ) {

				const at = shadowIvec2( texel.add( vec2( s.taps[ t ], s.taps[ t + 1 ] ) ).clamp( low, high ) );
				lit.addAssign( shadowSelect( reference.lessThanEqual( shadowTextureLoad( s.map, at ) ), float( s.taps[ t + 2 ] ), float( 0 ) ) );

			}

			If( found.equal( 1 ), () => {

				factor.assign( float( 1 ).sub( s.strength.mul( float( 1 ).sub( lit ) ) ) );

			} );

		}

	}

	if ( s.contacts !== null ) {

		const occlusion = float( 0 ).toVar( 'contactOcclusion' );
		shadowLoop( { start: 0, end: s.contactCount, type: 'int' }, ( { i } ) => {

			const point = s.contacts.element( i );
			const across = shadowLength( world.xz.sub( point.xz ) ).div( s.contactRadius );
			const above = shadowAbs( world.y.sub( point.y ) );
			const fall = float( 1 ).sub( shadowSmoothstep( 0.25, 1, across ) ).mul( float( 1 ).sub( shadowSmoothstep( 0.04, 0.22, above ) ) ).mul( point.w );
			occlusion.assign( max( occlusion, fall ) );

		} );
		factor.mulAssign( float( 1 ).sub( s.contactStrength.mul( occlusion ) ) );

	}

	return factor;

}

export { createShadowReceiver, shadowFactorAt };
// GAMEABLE EDIT 16 END
