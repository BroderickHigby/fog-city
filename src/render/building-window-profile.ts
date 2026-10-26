// The packed UVs already fit whole facadeGrid() columns. Architectural profiles change
// the opening inside that cell, never its spacing. Physical sills/hoods and GLSL use this
// same table so their edges stay together on shipped and fallback building geometry.
type WindowRect = readonly [number, number, number, number];
// Width scale + seed variation, minimum width, lower edge offset, upper edge offset.
const PROFILES = [
  [0.88, 0.12, 0, -0.015, 0.035], // historic stone: tall, deep openings
  [0.76, 0.12, 0, -0.025, 0.065], // deco office: slender vertical bays
  [1.06, 0, 0, 0, 0.035],        // brick industry: steel-framed multi-pane lights
  [0.90, 0, 0, -0.025, 0.055],   // residential: painted wood sash
  [1, 0, 0.92, -0.05, 0.05],    // contemporary: broad curtain-wall panes
] as const;

/** Apply after the existing historic-year adjustment to facadeGrid().win. */
export function windowProfileRect(baseWin: WindowRect, family: number, seed: number): [number, number, number, number] {
  const profile = Number.isInteger(family) ? PROFILES[family] : undefined;
  if (!profile) return [...baseWin];
  const s = Number.isFinite(seed) ? Math.max(0, Math.min(1, seed)) : 0;
  const width = Math.max(0.12, Math.min(0.98, Math.max(profile[2], (baseWin[1] - baseWin[0]) * (profile[0] + profile[1] * s))));
  const lower = Math.max(0.035, Math.min(0.45, baseWin[2] + profile[3]));
  const upper = Math.max(lower + 0.12, Math.min(0.98, baseWin[3] + profile[4]));
  return [0.5 - width * 0.5, 0.5 + width * 0.5, lower, upper];
}

/** Generated from the CPU table above: no second hand-maintained profile specification. */
export const WINDOW_PROFILE_GLSL = /* glsl */ `
vec4 fcCharacterWindowRect( vec4 win, float family, float seed ) {
  if ( family < -0.5 || family > 4.5 ) return win;
  vec4 profile = vec4( 1.0, 0.0, 0.0, 0.0 );
  float high = 0.0;
  ${PROFILES.map((p, i) => `${i === 0 ? "if" : "else if"} ( family < ${(i + 0.5).toFixed(1)} ) { profile = vec4( ${p.slice(0, 4).map(v => v.toFixed(4)).join(", ")} ); high = ${p[4].toFixed(4)}; }`).join("\n  ")}
  float width = clamp( max( profile.z, ( win.y - win.x ) * ( profile.x + profile.y * clamp( seed, 0.0, 1.0 ) ) ), 0.12, 0.98 );
  float low = clamp( win.z + profile.w, 0.035, 0.45 );
  return vec4( 0.5 - width * 0.5, 0.5 + width * 0.5, low, max( low + 0.12, min( 0.98, win.w + high ) ) );
}
`;
