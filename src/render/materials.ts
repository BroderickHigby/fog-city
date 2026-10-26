// Shared materials, the San Francisco fog, and the day/night switch.
//
// Fog: three's fog chunks are replaced once, globally, with a height fog: density falls off
// exponentially with altitude (thick at street level and over the water, thin on hilltops)
// plus a distance term so everything past ~1.5 km dissolves (which also hides tile
// streaming). It tints toward the sun's colour when looking into the sun. Every material
// gets the extra uniforms through Material.prototype.onBeforeCompile; a material compiled
// without them (all zeros) degrades to plain exponential fog, never to an error.
//
// Night: one uniform (fcNight, 0..1) drives lit windows in the building shader; lamp and
// window materials read it too. Changing it never recompiles anything.

import * as THREE from "three";
import { WINDOW_PROFILE_GLSL } from "./building-window-profile.ts";

export interface FogSettings {
  /** Base density at ground level (1/m). */
  density: number;
  /** Height falloff (1/m): density halves every ln(2)/falloff metres up. */
  falloff: number;
  /** Altitude where density equals `density`. */
  baseY: number;
  /** Distance term: optical depth grows as (d * distK)^2. */
  distK: number;
}

/** Shared uniforms injected into every material (values are mutated, never replaced). */
export const fcUniforms = {
  /** x falloff, y baseY, z unused, w distK */
  fcFogParams: { value: new THREE.Vector4(0.012, 0, 0, 1 / 1500) },
  /** xyz direction towards the sun (world), w inscatter strength */
  fcSunDir: { value: new THREE.Vector4(-0.9, 0.12, -0.2, 0.75) },
  /** Display-space colour of fog lit by the sun. */
  fcSunFog: { value: new THREE.Vector3(1, 0.8, 0.6) },
  /** Composer targets are linear; direct screen rendering keeps legacy display-space tint. */
  fcLinearOutput: { value: 0 },
  fcNight: { value: 0 },
  fcTime: { value: 0 },
  /** Road and ground wetness 0..1 from the sim's rain (weather.ts). */
  fcWet: { value: 0 },
};

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFcFogRel;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  // World-space vector from the camera to this vertex (view rotation is orthonormal).
  vFcFogRel = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFcFogRel;
  uniform vec4 fcFogParams;
  uniform vec4 fcSunDir;
  uniform vec3 fcSunFog;
  uniform float fcLinearOutput;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  float fcFogAmount( vec3 rel, float camY ) {
    float dist = length( rel );
    #ifdef FOG_EXP2
      float b = fcFogParams.x;
      float h = camY - fcFogParams.y;
      float t = b * rel.y;
      float base = fogDensity * exp( - clamp( b * h, -20.0, 20.0 ) );
      float optical = abs( t ) > 1e-4 ? base * ( 1.0 - exp( - t ) ) / t * dist : base * dist;
      float dk = dist * fcFogParams.w;
      optical += dk * dk;
      return 1.0 - exp( - max( optical, 0.0 ) );
    #else
      return smoothstep( fogNear, fogFar, dist );
    #endif
  }
  vec3 fcFogTint( vec3 dir ) {
    float s = pow( max( dot( dir, fcSunDir.xyz ), 0.0 ), 6.0 ) * fcSunDir.w;
    vec3 tint = fcLinearOutput > 0.5 ? sRGBTransferEOTF( vec4( fcSunFog, 1.0 ) ).rgb : fcSunFog;
    return mix( fogColor, tint, clamp( s, 0.0, 1.0 ) );
  }
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  float fogFactor = fcFogAmount( vFcFogRel, cameraPosition.y );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fcFogTint( normalize( vFcFogRel ) ), fogFactor );
#endif
`;

let patched = false;

/** Replace three's fog chunks and give every material the shared uniforms. Idempotent. */
export function installFog(): void {
  if (patched) return;
  patched = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  THREE.Material.prototype.onBeforeCompile = function (shader: THREE.WebGLProgramParametersWithUniforms) {
    injectUniforms(shader);
  };
}

export function injectUniforms(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  Object.assign(shader.uniforms, fcUniforms);
}

export function setFog(f: FogSettings, fog: THREE.FogExp2): void {
  fog.density = f.density;
  fcUniforms.fcFogParams.value.set(f.falloff, f.baseY, 0, f.distK);
}

// ---------------------------------------------------------------------------------------
// Buildings: vertex colours, procedural windows from (uv, _facade), lit at night.
//
// _facade (vec4, normalized bytes): x storey height / 8 m, y glazing 0..1, z (year - 1840)
// / 190 or 0, w roof flag. fcGrid mirrors facadeGrid() in tile-geometry.ts (the offline
// builder snaps wall u to whole columns with it). A geometry without _facade reads
// (0, 0, 0, 1): no windows.

const BUILDING_VERTEX_PARS = /* glsl */ `
attribute vec4 _facade;
// Per-building identity/base/height/family supplied once when a tile loads.
// Keep identity bit-stable: interpolating even equal Float32 seeds can perturb the
// room hash by one ULP, producing speckled light/blind colors and relief normals.
attribute highp vec4 _building;
flat varying highp vec4 vFcBuilding;
varying vec2 vFcUv;
varying vec4 vFcFacade;
varying vec3 vFcBuildingWorld;
`;

const BUILDING_FRAGMENT_PARS = /* glsl */ `
flat varying highp vec4 vFcBuilding;
varying vec2 vFcUv;
varying vec4 vFcFacade;
varying vec3 vFcBuildingWorld;
uniform float fcNight;
float fcHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float fcNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( fcHash( i ), fcHash( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( fcHash( i + vec2( 0.0, 1.0 ) ), fcHash( i + 1.0 ), u.x ), u.y );
}
float fcBand( float lo, float hi, float x, float w ) {
  return smoothstep( lo - w, lo + w, x ) - smoothstep( hi - w, hi + w, x );
}
float fcLine( float centre, float x, float width, float filterWidth ) {
  return 1.0 - smoothstep( width, width + max( filterWidth, 0.0001 ), abs( x - centre ) );
}
// A shallow semicircular head inside the existing rectangular opening. Its radius is in
// metres, so a wide bay and a narrow sash do not acquire the same squashed arch.
float fcOpening( vec2 f, vec4 win, vec2 filterWidth, vec2 cell, float arch ) {
  float sides = fcBand( win.x, win.y, f.x, filterWidth.x );
  if ( arch < 0.5 ) return sides * fcBand( win.z, win.w, f.y, filterWidth.y );
  float rx = max( ( win.y - win.x ) * 0.5, 0.001 );
  float ry = min( ( win.w - win.z ) * 0.32, rx * cell.x / cell.y );
  float nx = clamp( ( f.x - ( win.x + win.y ) * 0.5 ) / rx, -1.0, 1.0 );
  float top = win.w - ry + ry * sqrt( max( 0.0, 1.0 - nx * nx ) );
  return sides * smoothstep( win.z - filterWidth.y, win.z + filterWidth.y, f.y )
               * ( 1.0 - smoothstep( top - filterWidth.y, top + filterWidth.y, f.y ) );
}
${WINDOW_PROFILE_GLSL}
// x colW, y floorH, z lit fraction, w shop band height; win = window rect in the cell.
vec4 fcGrid( float storeyM, float g, out vec4 win ) {
  float floorH = clamp( storeyM, 2.6, 8.0 );
  float colW = g < 0.2 ? 6.0 : mix( 3.2, 1.7, smoothstep( 0.2, 0.9, g ) );
  float ww = mix( 0.42, 0.9, g );
  float wh = mix( 0.42, 0.82, g );
  float y0 = 0.08 + 0.2 * ( 1.0 - g );
  win = vec4( 0.5 - ww * 0.5, 0.5 + ww * 0.5, y0, min( 0.96, y0 + wh ) );
  float shopH = g >= 0.8 ? 5.0 : ( g >= 0.35 ? max( floorH, 3.8 ) : 0.0 );
  return vec4( colW, floorH, mix( 0.36, 0.2, g ), shopH );
}
`;

/** Metre-scaled wall relief and window reveals, filtered before they become subpixel. */
const BUILDING_FRAGMENT = /* glsl */ `
  float fcWin = 0.0;
  float fcLit = 0.0;
  float fcRelief = 0.0;
  float fcGlassVariation = 0.5;
  float fcFrameMetal = 0.0;
  float fcSeed = clamp( vFcBuilding.x, 0.0, 1.0 );
  float fcCharacter = step( 0.0, vFcBuilding.x ) * step( 0.0, vFcBuilding.w );
  float fcFamily = vFcBuilding.w;
  float fcStone = fcCharacter * ( 1.0 - step( 0.5, fcFamily ) );
  float fcDeco = fcCharacter * step( 0.5, fcFamily ) * ( 1.0 - step( 1.5, fcFamily ) );
  float fcBrick = fcCharacter * step( 1.5, fcFamily ) * ( 1.0 - step( 2.5, fcFamily ) );
  float fcHome = fcCharacter * step( 2.5, fcFamily ) * ( 1.0 - step( 3.5, fcFamily ) );
  float fcModern = fcCharacter * step( 3.5, fcFamily );
  float fcPixelM = max( length( dFdx( vFcUv ) ), length( dFdy( vFcUv ) ) );
  float fcArchitectureDetail = 1.0 - smoothstep( 0.08, 0.32, fcPixelM );
  vec3 fcTrimColor = mix( diffuseColor.rgb * 1.14, vec3( 0.53, 0.49, 0.42 ), 0.12 );
  fcTrimColor = mix( fcTrimColor, mix( diffuseColor.rgb * 1.15, vec3( 0.68, 0.67, 0.60 ), 0.58 ), fcHome );
  fcTrimColor = mix( fcTrimColor, mix( vec3( 0.085, 0.105, 0.115 ), vec3( 0.17, 0.14, 0.10 ), fcSeed * 0.45 ), fcModern );
  vec4 fcBaseWin;
  vec4 fcBaseGrid = fcGrid( vFcFacade.x * 8.0, vFcFacade.y, fcBaseWin );
  vec3 fcLightCol = vec3( 1.0, 0.72, 0.42 );
  float fcGlaze = vFcFacade.y;
  float fcWallDetail = 1.0;
  // Keep the source facade palette and add a restrained, stable building-level patina.
  // Architectural families change openings and construction details, not SF massing.
  diffuseColor.rgb *= mix( 1.0, 0.965 + fcSeed * 0.07, fcCharacter );
  if ( vFcFacade.w < 0.5 ) {
    float historic = step( 0.01, vFcFacade.z ) * ( 1.0 - step( 0.62, vFcFacade.z ) );
    float brick = max( fcBrick, historic * step( diffuseColor.g * 1.14, diffuseColor.r ) );
    vec2 blockM = mix( vec2( 1.1, 0.44 ), vec2( 0.29, 0.095 ), brick );
    vec2 block = vFcUv / blockM;
    block.x += mod( floor( block.y ), 2.0 ) * 0.5;
    vec2 bf = fract( block ), bw = max( fwidth( block ), vec2( 0.0001 ) );
    vec2 edge = min( bf, 1.0 - bf );
    vec2 groutWidth = vec2( 0.006 ) / blockM;
    float mortar = 1.0 - smoothstep( groutWidth.x, groutWidth.x + bw.x, edge.x )
                         * smoothstep( groutWidth.y, groutWidth.y + bw.y, edge.y );
    fcWallDetail = 1.0 - smoothstep( 0.22, 0.75, max( bw.x, bw.y ) );
    float masonry = ( 1.0 - smoothstep( 0.45, 0.8, fcGlaze ) ) * fcWallDetail * ( 1.0 - fcHome );
    float stoneTone = ( fcHash( floor( block ) ) - 0.5 ) * 0.065;
    diffuseColor.rgb *= 1.0 + masonry * ( stoneTone - mortar * 0.14 );
    float lowerWall = 1.0 - smoothstep( 0.15, 2.3, max( vFcUv.y, 0.0 ) );
    float rain = fcNoise( vec2( vFcUv.x * 1.3, vFcUv.y * 0.08 ) );
    diffuseColor.rgb *= 1.0 - lowerWall * 0.075 - ( rain - 0.4 ) * 0.04;
    fcRelief = -mortar * masonry * 0.003;
  }
  if ( vFcFacade.w < 0.5 && fcGlaze > 0.04 ) {
    vec4 win = fcBaseWin;
    vec4 grid = fcBaseGrid;
    if ( vFcFacade.z > 0.01 && vFcFacade.z < 0.37 ) win = vec4( 0.5 + ( win.xy - 0.5 ) * 0.78, win.z * 0.8, min( 0.95, win.w + 0.06 ) );
    win = fcCharacterWindowRect( win, fcFamily, fcSeed );
    vec2 cell = grid.xy;
    bool shop = grid.w > 0.0 && vFcUv.y < grid.w && vFcUv.y > 0.0;
    if ( shop ) { cell = vec2( grid.x * 2.0, grid.w ); win = vec4( 0.08, 0.92, 0.12, 0.8 ); }
    vec2 g = vFcUv / cell;
    vec2 f = fract( g );
    vec2 id = floor( g );
    vec2 fw = max( fwidth( g ), vec2( 0.0001 ) );
    float arch = ( fcStone * step( 0.35, fcSeed ) + fcHome * step( 0.72, fcSeed ) ) * ( shop ? 0.0 : 1.0 );
    float w = fcOpening( f, win, fw * 0.75, cell, arch );
    float rx = ( win.y - win.x ) * 0.5;
    float ry = min( ( win.w - win.z ) * 0.32, rx * cell.x / cell.y );
    float avg = ( win.y - win.x ) * ( win.w - win.z ) - arch * 0.429204 * rx * ry;
    float far = smoothstep( 0.3, 0.75, max( fw.x, fw.y ) );
    w = mix( w, avg, far );
    float floorMask = ( !shop && vFcUv.y < max( grid.w, 0.8 ) ) || vFcUv.y < 0.0 ? 0.0 : 1.0;
    w *= floorMask;
    fcWin = w;
    float h = fcHash( id + vec2( floor( fcGlaze * 31.0 ) * 17.0 + fcSeed * 79.0, fcSeed * 137.0 ) );
    float cluster = fcHash( floor( id / vec2( 5.0, 3.0 ) ) + 7.3 + fcSeed * 43.0 );
    // Night offices: lit floors cluster, most rooms dark, and lit rooms differ in brightness.
    float litFrac = shop ? 0.75 : grid.z * ( 0.2 + 0.9 * cluster );
    float on = step( 1.0 - litFrac, h );
    fcLit = mix( on * mix( 0.4, 1.0, fract( h * 13.7 ) ), ( shop ? 0.6 : grid.z ) * 0.14, far ) * w;
    float tone = fcHash( id * 1.7 + 3.1 + fcSeed * 29.0 );
    fcGlassVariation = tone;
    fcLightCol = tone > 0.82 ? vec3( 0.75, 0.86, 1.0 ) : ( tone > 0.55 ? vec3( 1.0, 0.85, 0.6 ) : vec3( 1.0, 0.7, 0.4 ) );
    if ( shop ) fcLightCol = vec3( 1.0, 0.82, 0.55 );

    // Narrow frames and stone sills read at street distance, then fade to a smooth average.
    vec2 reveal = vec2( 0.065 ) / cell;
    float outer = fcOpening( f, win + vec4( -reveal.x, reveal.x, -reveal.y, reveal.y ), fw, cell, arch );
    float frame = max( outer - w, 0.0 ) * ( 1.0 - far ) * floorMask;
    float sill = fcBand( win.x - reveal.x * 1.7, win.y + reveal.x * 1.7, f.x, fw.x )
               * fcBand( win.z - reveal.y * 2.4, win.z - reveal.y * 0.5, f.y, fw.y )
               * ( 1.0 - far ) * floorMask * ( 1.0 - smoothstep( 0.7, 0.95, fcGlaze ) );
    vec3 frameColor = mix( diffuseColor.rgb * 0.54, fcTrimColor, fcCharacter );
    diffuseColor.rgb = mix( diffuseColor.rgb, frameColor, frame );
    diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb * 1.13, fcTrimColor * 1.08, fcCharacter ), sill );

    // View-dependent room depth from the existing facade UV frame. No new textures or meshes.
    vec3 px = dFdx( vFcBuildingWorld ), py = dFdy( vFcBuildingWorld );
    vec2 ux = dFdx( vFcUv ), uy = dFdy( vFcUv );
    float uvDet = ux.x * uy.y - ux.y * uy.x;
    vec3 tangent = abs( uvDet ) > 1e-9 ? normalize( ( px * uy.y - py * ux.y ) / uvDet ) : vec3( 1.0, 0.0, 0.0 );
    vec3 wallNormal = normalize( cross( px, py ) );
    vec3 eye = normalize( cameraPosition - vFcBuildingWorld );
    float facing = max( abs( dot( eye, wallNormal ) ), 0.28 );
    vec2 shift = clamp( vec2( dot( eye, tangent ), eye.y ) / facing, vec2( -1.5 ), vec2( 1.5 ) );
    vec2 roomUv = ( f - win.xz ) / max( win.yw - win.xz, vec2( 0.05 ) );
    roomUv -= shift * vec2( 0.09, 0.065 ) * ( 1.0 - far );
    float roomBack = smoothstep( 0.02, 0.18, roomUv.x ) * ( 1.0 - smoothstep( 0.82, 0.98, roomUv.x ) );
    float blindLevel = mix( 0.12, 0.9, h );
    float blind = smoothstep( blindLevel - 0.025, blindLevel + 0.025, roomUv.y ) * step( 0.62, tone );
    float blindLines = 0.92 + 0.08 * cos( roomUv.y * 95.0 );
    blindLines = mix( blindLines, 0.96, smoothstep( 0.02, 0.055, fw.y ) );
    vec3 glass = mix( vec3( 0.038, 0.052, 0.065 ), vec3( 0.074, 0.087, 0.092 ), tone );
    glass = mix( glass, mix( vec3( 0.040, 0.075, 0.085 ), vec3( 0.085, 0.12, 0.14 ), tone ), fcModern * 0.65 );
    glass *= mix( 0.65, 1.0, roomBack );
    vec3 blindColor = mix( vec3( 0.18, 0.17, 0.14 ), vec3( 0.25, 0.26, 0.25 ), h );
    glass = mix( glass, blindColor * blindLines, blind * ( 1.0 - far ) * 0.72 );
    // Inner top/side reveals stay dark; the central pane receives sky reflections through PBR.
    vec2 paneEdge = min( roomUv, 1.0 - roomUv );
    float revealShade = 1.0 - smoothstep( 0.0, 0.08, min( paneEdge.x, paneEdge.y ) );
    glass *= 1.0 - revealShade * ( 1.0 - far ) * 0.24;
    // Steel warehouse lights, painted double-hung sash, slender deco transoms and
    // contemporary curtain-wall divisions share the same source column/floor rhythm.
    vec2 pane = ( f - win.xz ) / max( win.yw - win.xz, vec2( 0.05 ) );
    vec2 paneFw = fw / max( win.yw - win.xz, vec2( 0.05 ) );
    float mullion = 0.0;
    if ( fcCharacter > 0.5 && far < 0.99 ) {
      float centre = fcLine( 0.5, pane.x, mix( 0.013, 0.035, fcHome ), paneFw.x );
      float transom = fcLine( mix( 0.74, 0.49, fcHome ), pane.y, mix( 0.014, 0.026, fcHome ), paneFw.y );
      mullion = max( centre, transom );
      if ( fcBrick > 0.5 ) {
        vec2 panes = vec2( 3.0 + step( 0.55, fcSeed ), 2.0 );
        vec2 edge = min( fract( pane * panes ), 1.0 - fract( pane * panes ) );
        vec2 filters = paneFw * panes;
        mullion = 1.0 - smoothstep( 0.025, 0.025 + filters.x, edge.x )
                        * smoothstep( 0.025, 0.025 + filters.y, edge.y );
      }
      mullion *= ( 1.0 - far ) * fcArchitectureDetail;
      glass = mix( glass, frameColor, mullion );
    }
    fcWin *= 1.0 - mullion;
    fcLit *= 1.0 - mullion;
    fcFrameMetal = fcModern * max( frame, mullion * w );
    diffuseColor.rgb = mix( diffuseColor.rgb, glass, w * 0.94 );
    fcRelief += ( -w * 0.035 + frame * 0.007 + sill * 0.014 + mullion * w * 0.006 ) * ( 1.0 - far );
  }
  if ( fcCharacter > 0.5 && fcArchitectureDetail > 0.001 ) {
    if ( vFcFacade.w < 0.5 ) {
      float localY = vFcBuildingWorld.y - vFcBuilding.y;
      float floorY = mod( max( localY, 0.0 ), fcBaseGrid.y );
      float course = fcBand( 0.0, mix( 0.10, 0.18, fcDeco ), floorY, fcPixelM );
      float grouped = fcBaseGrid.x * ( 2.0 + step( 0.55, fcSeed ) );
      float bayX = mod( vFcUv.x, grouped );
      float pier = fcBand( 0.0, 0.15 + fcDeco * 0.08, bayX, fcPixelM );
      float top = vFcBuilding.z - localY;
      float cornice = fcBand( 0.0, 0.38 + fcStone * 0.18, top, fcPixelM );
      float plinth = fcBand( 0.0, 0.65, localY, fcPixelM );
      float ornament = max( course * ( fcStone * 0.55 + fcDeco * 0.8 + fcHome * 0.25 ), pier * ( fcStone * 0.3 + fcDeco * 0.75 ) );
      ornament = max( ornament, cornice * ( fcStone + fcDeco + fcHome * 0.5 ) );
      ornament *= fcArchitectureDetail;
      diffuseColor.rgb = mix( diffuseColor.rgb, fcTrimColor, clamp( ornament, 0.0, 1.0 ) );
      diffuseColor.rgb *= 1.0 - plinth * fcArchitectureDetail * ( 0.10 + fcBrick * 0.1 );
      // Some low residential facades are clapboard; others retain smooth painted stucco.
      if ( fcHome > 0.5 && fcSeed > 0.55 ) {
        float lap = fcBand( 0.0, 0.014, mod( max( localY, 0.0 ), 0.20 ), fcPixelM );
        diffuseColor.rgb *= 1.0 - lap * fcArchitectureDetail * ( 1.0 - fcWin ) * 0.09;
        fcRelief -= lap * fcArchitectureDetail * ( 1.0 - fcWin ) * 0.002;
      }
      fcRelief += ornament * 0.012;
      fcWin *= 1.0 - clamp( ornament, 0.0, 1.0 );
      fcLit *= 1.0 - clamp( ornament, 0.0, 1.0 );
    } else {
      // Roof expansion joints and muted gravel patches complement the actual roof equipment.
      vec2 roof = ( vFcUv + fcSeed * 11.0 ) / 3.2;
      vec2 edge = min( fract( roof ), 1.0 - fract( roof ) );
      vec2 filterWidth = max( fwidth( roof ), vec2( 0.0001 ) );
      float joint = 1.0 - smoothstep( 0.003, 0.003 + filterWidth.x, edge.x )
                        * smoothstep( 0.003, 0.003 + filterWidth.y, edge.y );
      float fcRoofPatchTone = fcHash( floor( roof ) + fcSeed * 31.0 );
      diffuseColor.rgb *= 1.0 + fcArchitectureDetail * ( ( fcRoofPatchTone - 0.5 ) * 0.055 - joint * 0.08 );
      fcRelief -= joint * fcArchitectureDetail * 0.004;
    }
  }
`;

const RELIEF_NORMAL_PARS = /* glsl */ `
vec3 fcReliefNormal( vec3 positionView, vec3 surfaceNormal, float height ) {
  vec3 px = dFdx( positionView ), py = dFdy( positionView );
  vec3 n = normalize( surfaceNormal );
  vec3 rx = cross( py, n ), ry = cross( n, px );
  float determinant = dot( px, rx );
  if ( abs( determinant ) < 1e-12 ) return n;
  vec3 gradient = sign( determinant ) * ( dFdx( height ) * rx + dFdy( height ) * ry );
  return normalize( abs( determinant ) * n - gradient );
}
`;

const BUILDING_ROUGHNESS = /* glsl */ `
  roughnessFactor = mix( roughnessFactor, mix( 0.13, 0.25, fcGlassVariation ), fcWin );
  roughnessFactor = mix( roughnessFactor, 0.32, fcFrameMetal );
`;

const BUILDING_EMISSIVE = /* glsl */ `
  totalEmissiveRadiance += fcLightCol * fcLit * fcNight * 1.1;
`;

function patchBuildingShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  injectUniforms(shader);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${BUILDING_VERTEX_PARS}`)
    .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFcUv = uv;\n  vFcFacade = _facade;\n  vFcBuilding = _building;")
    .replace("#include <project_vertex>", "#include <project_vertex>\n  vFcBuildingWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${BUILDING_FRAGMENT_PARS}\n${RELIEF_NORMAL_PARS}`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${BUILDING_FRAGMENT}`)
    .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${BUILDING_ROUGHNESS}`)
    .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n  metalnessFactor = max( metalnessFactor, fcFrameMetal * 0.55 );")
    .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${BUILDING_EMISSIVE}`)
    .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n  normal = fcReliefNormal( -vViewPosition, normal, fcRelief );");
}

/** Metre-scaled surface detail. High frequencies fade before becoming shimmering pixels. */
const GRAIN_PARS = /* glsl */ `
varying vec3 vFcWorld;
uniform float fcWet;
float fcRand( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float fcN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( fcRand( i ), fcRand( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( fcRand( i + vec2( 0.0, 1.0 ) ), fcRand( i + 1.0 ), u.x ), u.y );
}
`;

/**
 * Rain on the ground (weather.ts sets fcWet): it darkens and turns glossy, patchily as it
 * dries. After every roughness patch (scanned surfaces included), before the lighting reads it.
 */
const WET_FRAGMENT = /* glsl */ `
  {
    float fcWetAmt = fcWet * mix( 0.7, 1.0, fcN( fcP * 0.23 ) );
    diffuseColor.rgb *= 1.0 - 0.32 * fcWetAmt;
    roughnessFactor = mix( roughnessFactor, 0.14, 0.85 * fcWetAmt );
  }
  #include <lights_physical_fragment>`;

function patchGrainShader(amount: number, scale: number, road = false) {
  const detail = road ? /* glsl */ `
  // Aggregate, old repairs and sparse hairline cracks; painted lines remain clean and legible.
  float fcAsphalt = 1.0 - smoothstep( 0.22, 0.5, max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) ) );
  vec2 warped = ( fcP + vec2( fcN( fcP * 0.21 ), fcN( fcP * 0.21 + 31.7 ) ) * 1.7 ) * 0.19;
  vec2 wf = fract( warped ), wa = max( fwidth( warped ), vec2( 0.0001 ) );
  vec2 we = min( wf, 1.0 - wf );
  float crack = ( 1.0 - smoothstep( 0.001, 0.0025 + max( wa.x, wa.y ), min( we.x, we.y ) ) )
              * step( 0.7, fcRand( floor( warped ) ) ) * smoothstep( 0.28, 0.65, fcN( fcP * 0.7 ) );
  crack *= 1.0 - smoothstep( 0.035, 0.12, max( wa.x, wa.y ) );
  diffuseColor.rgb *= 1.0 + fcAsphalt * ( fcFine * 0.12 * fcFineVisible - crack * 0.24 );
  fcRelief += fcAsphalt * ( fcFine * 0.0012 * fcFineVisible - crack * 0.002 );
  fcSurfaceRoughness = mix( 0.78, 0.92, fcN( fcP * 0.32 ) );
  ` : /* glsl */ `
  // Paving joints only on neutral pavement. Park and dirt vertex colours keep their own surface.
  float fcRange = max( diffuseColor.r, max( diffuseColor.g, diffuseColor.b ) ) - min( diffuseColor.r, min( diffuseColor.g, diffuseColor.b ) );
  float fcPaved = 1.0 - smoothstep( 0.035, 0.12, fcRange );
  vec2 slab = fcP / vec2( 1.5, 2.0 );
  slab.x += mod( floor( slab.y ), 2.0 ) * 0.5;
  vec2 sf = fract( slab ), sa = max( fwidth( slab ), vec2( 0.0001 ) );
  vec2 se = min( sf, 1.0 - sf );
  float joint = 1.0 - smoothstep( 0.002, 0.004 + sa.x, se.x ) * smoothstep( 0.002, 0.004 + sa.y, se.y );
  float slabVisible = 1.0 - smoothstep( 0.15, 0.6, max( sa.x, sa.y ) );
  float slabTone = ( fcRand( floor( slab ) ) - 0.5 ) * 0.055;
  diffuseColor.rgb *= 1.0 + fcPaved * slabVisible * ( slabTone - joint * 0.12 ) + fcFine * 0.065 * fcFineVisible;
  fcRelief += fcPaved * slabVisible * ( fcFine * 0.0007 - joint * 0.003 );
  fcSurfaceRoughness = mix( 0.87, 0.98, fcN( fcP * 0.75 ) );
  `;
  return (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    injectUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFcWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n  vFcWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GRAIN_PARS}\n${RELIEF_NORMAL_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
  vec2 fcP = vFcWorld.xz;
  float fcPixelM = max( length( dFdx( fcP ) ), length( dFdy( fcP ) ) );
  float fcFineVisible = 1.0 - smoothstep( 0.012, 0.055, fcPixelM );
  float fcFine = fcN( fcP * 48.0 ) - 0.5;
  float fcG = fcN( fcP * ${scale.toFixed(3)} ) * 0.6 + fcN( fcP * ${(scale * 7.3).toFixed(3)} ) * 0.4;
  diffuseColor.rgb *= 1.0 + ( fcG - 0.5 ) * ${amount.toFixed(3)};
  float fcRelief = 0.0;
  float fcSurfaceRoughness = roughness;
  ${detail}`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = min( roughnessFactor, fcSurfaceRoughness );")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n  normal = fcReliefNormal( -vViewPosition, normal, fcRelief );")
      .replace("#include <lights_physical_fragment>", WET_FRAGMENT);
  };
}

// Road ribbons that carry TEXCOORD_0 = (0 at the left kerb .. 1 at the right kerb, metres
// along the edge), as the pipeline writes them: kerb strips and dashed lines are drawn from
// the UVs, since such tiles have no marking geometry.
const ROAD_UV_FRAGMENT = (freeway: boolean): string => /* glsl */ `
  {
    vec2 ruv = vFcRoadUv;
    // Metres per unit of u (the ribbon's width) from screen-space derivatives: solve
    // dP = P_u du + P_v dv for P_u. Clamped, since it is noisy at grazing angles.
    vec3 dpx = dFdx( vFcWorld );
    vec3 dpy = dFdy( vFcWorld );
    vec2 dux = dFdx( ruv );
    vec2 duy = dFdy( ruv );
    float det = dux.x * duy.y - duy.x * dux.y;
    float widthM = abs( det ) > 1e-9 ? length( ( dpx * duy.y - dpy * dux.y ) / det ) : 12.0;
    widthM = clamp( widthM, 4.0, 60.0 );
    float fu = fwidth( ruv.x ) * 0.8 + 1e-4;
    float kerbU = 0.35 / widthM;
    float kerb = 1.0 - smoothstep( kerbU - fu, kerbU + fu, min( ruv.x, 1.0 - ruv.x ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.25, 0.245, 0.235 ), kerb * 0.85 );
    float dash = step( fract( ruv.y / ${freeway ? "12.0" : "9.0"} ), 0.42 );
    float halfU = 0.07 / widthM;
    float line = 0.0;
    ${
      freeway
        ? "for ( int k = 1; k < 3; k++ ) { float c = float( k ) / 3.0; line = max( line, 1.0 - smoothstep( halfU, halfU + fu, abs( ruv.x - c ) ) ); }"
        : "line = widthM > 7.0 ? 1.0 - smoothstep( halfU, halfU + fu, abs( ruv.x - 0.5 ) ) : 0.0;"
    }
    float far = smoothstep( 0.02, 0.06, fu );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.72, 0.71, 0.66 ), line * dash * ( 1.0 - far ) );
  }
`;

function patchRoadUvShader(freeway: boolean) {
  const grain = patchGrainShader(0.10, 0.35, true);
  return (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    grain(shader);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFcRoadUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFcRoadUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFcRoadUv;")
      .replace("#include <color_fragment>", `#include <color_fragment>\n${ROAD_UV_FRAGMENT(freeway)}`);
  };
}

export interface SharedMaterials {
  building: THREE.MeshStandardMaterial;
  /** For building meshes shipped without normals (flat shading from screen derivatives). */
  buildingFlat: THREE.MeshStandardMaterial;
  ground: THREE.MeshStandardMaterial;
  road: THREE.MeshStandardMaterial;
  /** Road and freeway ribbons with kerb-to-kerb UVs (pipeline tiles). */
  roadUv: THREE.MeshStandardMaterial;
  freewayUv: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  lampPole: THREE.MeshStandardMaterial;
  lampHead: THREE.MeshStandardMaterial;
  /** Every shared material, for disposal. */
  all: THREE.Material[];
}

function roadMaterial(name: string, patch: (s: THREE.WebGLProgramParametersWithUniforms) => void): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name });
  m.onBeforeCompile = patch;
  m.customProgramCacheKey = () => `${name}:v2`;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
  return m;
}

export function createSharedMaterials(): SharedMaterials {
  installFog();
  const building = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, name: "fc:building" });
  Object.assign(building, { defaultAttributeValues: { _facade: [0, 0, 0, 1], _building: [-1, 0, 0, -1] } });
  building.onBeforeCompile = patchBuildingShader;
  building.customProgramCacheKey = () => "fc:building:v5";
  const buildingFlat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, flatShading: true, name: "fc:building-flat" });
  Object.assign(buildingFlat, { defaultAttributeValues: { _facade: [0, 0, 0, 1], _building: [-1, 0, 0, -1] } });
  buildingFlat.onBeforeCompile = patchBuildingShader;
  buildingFlat.customProgramCacheKey = () => "fc:building:v5";

  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, name: "fc:ground" });
  ground.onBeforeCompile = patchGrainShader(0.12, 0.16);
  ground.customProgramCacheKey = () => "fc:ground:v2";

  const road = roadMaterial("fc:road", patchGrainShader(0.10, 0.35, true));
  const roadUv = roadMaterial("fc:road-uv", patchRoadUvShader(false));
  const freewayUv = roadMaterial("fc:freeway-uv", patchRoadUvShader(true));

  const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, name: "fc:foliage" });
  const lampPole = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.6, metalness: 0.5, name: "fc:lamp-pole" });
  const lampHead = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.4, metalness: 0.1, emissive: 0xffb466, emissiveIntensity: 0, name: "fc:lamp-head" });
  return {
    building,
    buildingFlat,
    ground,
    road,
    roadUv,
    freewayUv,
    foliage,
    lampPole,
    lampHead,
    all: [building, buildingFlat, ground, road, roadUv, freewayUv, foliage, lampPole, lampHead],
  };
}

export type TileLayer = "building" | "ground" | "road" | "freeway" | "foliage";

/**
 * Which layer a mesh in a tile glb belongs to, from its material name or its node name
 * ("buildings", "ground"/"terrain", "roads"/"streets", "freeways", "foliage"/"trees").
 * Tiles from this repo's dev-city builder and from the pipeline both use these names.
 */
export function tileLayer(materialName: string, nodeName: string): TileLayer | null {
  for (const n of [materialName.toLowerCase(), nodeName.toLowerCase()]) {
    if (/^buildings?(?![a-z])/.test(n)) return "building";
    if (/^(ground|terrain)(?![a-z])/.test(n)) return "ground";
    if (/^(freeways?|ramps?)(?![a-z])/.test(n)) return "freeway";
    if (/^(roads?|streets?)(?![a-z])/.test(n)) return "road";
    if (/^(foliage|trees?)(?![a-z])/.test(n)) return "foliage";
  }
  return null;
}

/** The shared material for a tile mesh of a given layer, chosen by what its geometry carries. */
export function materialFor(m: SharedMaterials, layer: TileLayer, geo: { hasNormals: boolean; hasUv: boolean }): THREE.Material {
  switch (layer) {
    case "building":
      return geo.hasNormals ? m.building : m.buildingFlat;
    case "ground":
      return m.ground;
    case "road":
      return geo.hasUv ? m.roadUv : m.road;
    case "freeway":
      return geo.hasUv ? m.freewayUv : m.road;
    case "foliage":
      return m.foliage;
  }
}
