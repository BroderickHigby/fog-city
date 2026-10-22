// The building facade shader (house kit K1, K2, K4, K5 shader half, K7 door, K8 bands, K9;
// owner priority 2026-10-22: textured facades). Everything is procedural, drawn at real-world
// scale from the wall's own metres, so it costs no texture memory and no tile bytes:
//
//   materials  painted wood clapboard (Victorian and Edwardian), channel siding (shiplap),
//              shingle (fish-scale in a Queen Anne's top storey, brown shingle whole walls),
//              stucco (1916-1960 rows, the Marina and the avenues), brick (older commercial and
//              warehouses, running bond, per-brick tone, recessed mortar), stone and terracotta
//              (ashlar blocks, a rusticated ground storey), concrete (storey and panel joints,
//              form-tie holes, weathering streaks) and curtain wall (mullions, transoms and
//              opaque spandrels). Each gives an albedo and a height the normal is bumped with.
//   openings   windows with casings, double-hung sashes (meeting rail, muntins by era), sills and
//              hoods; panelled front doors with a transom; sectional garage doors (K4); shop
//              glazing with bulkhead, mullions, transom and an empty sign band (K5); small
//              basement windows under a raised first floor (K7).
//   walls      front walls carry the full kit; party walls are blank stucco; side and rear walls
//              get fewer, smaller windows (K1). Windows are laid out from each wall's ends (K9: no
//              corner splits a window) on the storey grid from the street (K2), and stop below
//              the roofline (K9).
//   distance   every pattern fades to its own average as it shrinks under a few pixels, so the
//              far tiles show flat, correct colour with no shimmer.
//
// Inputs: vertex colour = the body colour (K3, house-colours.ts); uv = (metres along the
// footprint ring, metres above the street); _facade (storey / 8 m, glazing, year, wall class);
// _wall and _kit (house-kit.ts prepareFacades, through `flat` varyings from each wall triangle's
// provoking vertex). A geometry without _wall/_kit (never shipped, but harmless) is drawn from
// the ring's metres with materials chosen by glazing and year.

export const FACADE_VERTEX_PARS = /* glsl */ `
attribute vec4 _facade;
attribute vec4 _wall;
attribute vec4 _kit;
varying vec2 vFcUv;
varying vec4 vFcFacade;
flat varying vec4 vFcWall;
flat varying vec4 vFcKit;
flat varying float vFcU0;
`;

export const FACADE_VERTEX = /* glsl */ `
  vFcUv = uv;
  vFcFacade = _facade;
  vFcWall = _wall;
  vFcKit = _kit;
  vFcU0 = uv.x;
`;

export const FACADE_FRAGMENT_PARS = /* glsl */ `
varying vec2 vFcUv;
varying vec4 vFcFacade;
flat varying vec4 vFcWall;
flat varying vec4 vFcKit;
flat varying float vFcU0;
uniform float fcNight;

float fcHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float fcNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p );
  float a = fcHash( i ), b = fcHash( i + vec2( 1.0, 0.0 ) ), c = fcHash( i + vec2( 0.0, 1.0 ) ), d = fcHash( i + vec2( 1.0, 1.0 ) );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
float fcFbm( vec2 p ) {
  return 0.55 * fcNoise( p ) + 0.3 * fcNoise( p * 2.13 + 7.1 ) + 0.15 * fcNoise( p * 4.37 + 3.3 );
}
vec3 fcLin( vec3 c ) { return pow( c, vec3( 2.2 ) ); }
vec3 fc565( float v ) {
  float r = floor( v / 2048.0 );
  float g = mod( floor( v / 32.0 ), 64.0 );
  float b = mod( v, 32.0 );
  return fcLin( vec3( r / 31.0, g / 63.0, b / 31.0 ) );
}
// Smoothed 1D box: 1 inside [lo, hi], antialiased by w.
float fcIn( float lo, float hi, float x, float w ) {
  return clamp( ( x - lo ) / w + 0.5, 0.0, 1.0 ) * clamp( ( hi - x ) / w + 0.5, 0.0, 1.0 );
}
float fcRect( vec2 p, vec4 r, float w ) { return fcIn( r.x, r.y, p.x, w ) * fcIn( r.z, r.w, p.y, w ); }
// A thin line at the start of each period (a joint, groove or mortar course): 1 on the line.
float fcLines( float x, float period, float width, float w ) {
  float f = fract( x / period ) * period;
  return 1.0 - fcIn( width, period, f, w );
}
// Bump: three's derivative bump (perturbNormalArb) with unnormalised screen tangents, so the
// tilt is the height's slope in metres per metre at any distance.
vec3 fcPerturb( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sx = dFdx( surfPos );
  vec3 sy = dFdy( surfPos );
  vec3 r1 = cross( sy, surfNorm );
  vec3 r2 = cross( surfNorm, sx );
  float det = dot( sx, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}
`;

/**
 * Runs after <color_fragment>: diffuseColor.rgb holds the body colour. Declares fcH (bump
 * height, m), fcWin (glass share), fcRough (roughness override, < 0 none), fcLit and fcLightCol
 * (night windows) for the later chunks.
 */
export const FACADE_FRAGMENT = /* glsl */ `
  float fcH = 0.0;
  float fcWin = 0.0;
  float fcRough = -1.0;
  float fcLit = 0.0;
  vec3 fcLightCol = vec3( 1.0, 0.72, 0.42 );
  {
    float cls = vFcFacade.w * 255.0;
    vec2 fcAa = max( fwidth( vFcUv ), vec2( 1e-4 ) );
    float lod = max( fcAa.x, fcAa.y );
    float aw = lod * 0.9;
    bool prepared = vFcWall.x > 0.5;
    float meta = prepared ? vFcKit.w : 0.0;
    float glaze = vFcFacade.y;
    float year = vFcFacade.z > 0.005 ? 1840.0 + vFcFacade.z * 190.0 : 0.0;
    float mat = mod( meta, 8.0 );
    float seed = mod( floor( meta / 8.0 ), 32.0 );
    float bflags = floor( meta / 256.0 );
    if ( !prepared ) {
      mat = glaze >= 0.7 ? 7.0 : glaze >= 0.52 ? 6.0 : glaze < 0.2 ? 4.0 : ( glaze < 0.42 && glaze >= 0.3 ) ? 5.0 : glaze >= 0.42 ? 6.0 : ( year > 0.0 && year < 1916.0 ? 0.0 : 3.0 );
      seed = floor( fcHash( vec2( floor( vFcFacade.x * 255.0 ), floor( glaze * 255.0 ) ) ) * 31.0 );
    }
    bool landmark = mod( bflags, 2.0 ) > 0.5;
    bool redTile = mod( floor( bflags / 2.0 ), 2.0 ) > 0.5;
    vec3 trim = prepared ? fc565( vFcKit.x ) : vec3( 0.8, 0.78, 0.72 );
    vec3 doorCol = prepared ? fc565( vFcKit.y ) : vec3( 0.06, 0.04, 0.035 );
    float topV = prepared && vFcKit.z > 0.5 ? vFcKit.z * 0.1 : 1e4;
    float sd = seed / 31.0;
    vec3 body = diffuseColor.rgb;

    if ( cls > 212.0 ) {
      // Roof: tar and gravel, a little lighter where the gravel is thick.
      vec2 rp = vFcUv;
      float fade = 1.0 - smoothstep( 0.02, 0.08, lod );
      float g = fcNoise( rp * 7.0 ) * 0.6 + fcNoise( rp * 29.0 ) * 0.4;
      float blot = fcFbm( rp * 0.35 + sd * 9.0 );
      diffuseColor.rgb *= 0.9 + 0.2 * ( blot - 0.5 ) + 0.22 * ( g - 0.5 ) * fade;
      fcH = 0.004 * g * fade;
      fcRough = 0.95;
    } else {
      bool front = cls > 127.5;
      bool party = cls > 42.5 && cls < 127.5;
      float L = prepared ? vFcWall.x * 0.1 : 1e4;
      float x = prepared ? vFcUv.x - vFcU0 : vFcUv.x;
      float y = vFcUv.y;
      vec2 p = vec2( x, y );
      float wflags = prepared ? mod( vFcWall.y, 64.0 ) : 0.0;
      float floorM = prepared ? floor( vFcWall.y / 64.0 ) * 0.1 : 0.0;
      bool hasGarage = mod( wflags, 2.0 ) > 0.5;
      bool hasDoor = mod( floor( wflags / 2.0 ), 2.0 ) > 0.5;
      bool shop = mod( floor( wflags / 4.0 ), 2.0 ) > 0.5;
      bool stoop = mod( floor( wflags / 8.0 ), 2.0 ) > 0.5;
      float garageX = vFcWall.z * 0.1;
      float doorX = vFcWall.w * 0.1;
      float S = clamp( vFcFacade.x * 8.0, 2.6, 8.0 );
      bool house = mat < 2.5 || ( mat > 2.5 && mat < 3.5 && glaze < 0.3 );
      bool woodHouse = mat < 2.5;
      bool curtain = mat > 6.5;
      if ( party ) { mat = 3.0; body = mix( body, vec3( dot( body, vec3( 0.3, 0.59, 0.11 ) ) ) * vec3( 1.0, 0.97, 0.92 ), 0.45 ) * 0.9; }

      // ---------------------------------------------------------------- material
      vec3 col = body;
      float h = 0.0;
      float rough = 0.85;
      float grain = 1.0 - smoothstep( 0.012, 0.04, lod );
      float weather = fcFbm( p * vec2( 0.9, 0.6 ) + sd * 13.0 );
      if ( mat < 0.5 || ( mat > 1.5 && mat < 2.5 && sd < 0.5 && y < topV - S ) ) {
        // Clapboard: lapped boards, thick at the foot, each casting a shadow line on the next.
        float e = 0.12 + 0.04 * fract( sd * 3.7 );
        float t = fract( y / e );
        float fade = 1.0 - smoothstep( e * 0.12, e * 0.45, lod );
        float shadow = smoothstep( 0.72, 1.0, t );
        float k = floor( y / e );
        float butt = fcLines( x + fcHash( vec2( k, sd ) ) * 3.7, 3.7, 0.006, aw );
        col *= 1.0 - fade * ( 0.2 * shadow * shadow + 0.12 * butt ) + 0.05 * fade * ( fcNoise( vec2( x * 1.3, y * 37.0 ) ) - 0.5 );
        col *= mix( 0.935, 1.0, fade ); // the shadow lines' average when they blur together
        h = fade * 0.012 * ( 1.0 - t ) * smoothstep( 0.0, 0.08, t );
        rough = 0.7;
      } else if ( mat < 1.5 ) {
        // Channel siding: flat boards with a dark groove at each joint.
        float e = 0.17 + 0.05 * fract( sd * 5.3 );
        float fade = 1.0 - smoothstep( e * 0.12, e * 0.45, lod );
        float groove = fcLines( y, e, 0.022, aw );
        col *= 1.0 - fade * ( 0.42 * groove ) + 0.04 * fade * ( fcNoise( vec2( x * 1.1, y * 31.0 ) ) - 0.5 );
        col *= mix( 0.95, 1.0, fade );
        h = -0.007 * groove * fade;
        rough = 0.72;
      } else if ( mat < 2.5 ) {
        // Shingle: fish-scale courses (a Queen Anne's top storey) or brown shingle, staggered.
        float rowH = 0.14;
        float r = floor( y / rowH );
        float fade = 1.0 - smoothstep( 0.012, 0.05, lod );
        float fy = fract( y / rowH );
        float edge;
        if ( sd >= 0.5 || y >= topV - S ) {
          float w = 0.16;
          float fx = fract( x / w + 0.5 * mod( r, 2.0 ) ) - 0.5;
          float curve = 0.55 - sqrt( max( 0.0, 0.25 - fx * fx ) ) * 1.1;
          edge = 1.0 - smoothstep( 0.0, 0.12, fy - curve );
        } else {
          float w = 0.16 + 0.12 * fcHash( vec2( r, 3.0 ) );
          float fx = fract( x / w + fcHash( vec2( r, 7.0 ) ) );
          edge = max( 1.0 - smoothstep( 0.0, 0.1, fy ), 1.0 - fcIn( 0.03, 0.97, fx, aw / w ) );
          col *= 0.9 + 0.2 * fcHash( vec2( floor( x / w + fcHash( vec2( r, 7.0 ) ) ), r ) );
        }
        col *= 1.0 - fade * 0.3 * edge;
        col *= mix( 0.92, 1.0, fade );
        h = fade * 0.008 * ( 1.0 - edge );
        rough = 0.8;
      } else if ( mat < 3.5 ) {
        // Stucco: a sand-float finish, uneven trowel patches, grime at the foot.
        float fade = 1.0 - smoothstep( 0.01, 0.05, lod );
        float fine = fcNoise( p * 19.0 + sd * 31.0 );
        float trowel = fcFbm( p * 1.7 + sd * 7.0 );
        col *= 1.0 + 0.1 * ( trowel - 0.5 ) + 0.09 * fade * ( fine - 0.5 );
        h = 0.0025 * fine * fade + 0.004 * trowel;
        rough = 0.93;
      } else if ( mat < 4.5 ) {
        // Brick: running bond, 8 x 3 in with 3/8 in mortar, tone by brick, mortar recessed.
        float ch = 0.086;
        float bl = 0.213;
        float r = floor( y / ch );
        float bx = x / bl + 0.5 * mod( r, 2.0 );
        float fade = 1.0 - smoothstep( 0.008, 0.03, lod );
        float mortar = 1.0 - fcIn( 0.05, 0.95, fract( bx ), aw / bl ) * fcIn( 0.11, 1.0, fract( y / ch ), aw / ch );
        float tone = fcHash( vec2( floor( bx ), r ) + sd * 17.0 );
        vec3 brick = body * ( 0.8 + 0.38 * tone ) * ( 1.0 + 0.08 * ( fcNoise( p * 40.0 ) - 0.5 ) );
        vec3 mortarCol = mix( body, vec3( 0.42, 0.4, 0.36 ), 0.75 );
        col = mix( mix( brick, mortarCol, mortar ), mix( body * 0.99, mortarCol, 0.16 ), 1.0 - fade );
        h = -0.006 * mortar * fade;
        rough = 0.9;
      } else if ( mat < 5.5 ) {
        // Stone and terracotta: ashlar blocks; the ground storey rusticated with deep joints.
        bool rust = y < S && y > -S;
        float bh = rust ? 0.5 : 0.42;
        float bw = rust ? 1.1 : 0.85;
        float r = floor( y / bh );
        float bx = x / bw + 0.5 * mod( r, 2.0 );
        float fade = 1.0 - smoothstep( 0.015, 0.06, lod );
        float jw = rust ? 0.06 : 0.012;
        float joint = 1.0 - fcIn( jw / bw, 1.0, fract( bx ), aw / bw ) * fcIn( jw / bh, 1.0, fract( y / bh ), aw / bh );
        float tone = fcHash( vec2( floor( bx ), r ) + sd * 5.0 );
        col *= 1.0 + fade * ( 0.07 * ( tone - 0.5 ) - ( rust ? 0.35 : 0.18 ) * joint ) + 0.05 * ( fcNoise( p * 13.0 ) - 0.5 ) * fade;
        h = -( rust ? 0.03 : 0.004 ) * joint * fade;
        rough = sd > 0.6 ? 0.55 : 0.85; // glazed terracotta has a sheen
      } else if ( mat < 6.5 ) {
        // Concrete: storey and panel joints, form-tie holes on board-formed walls, rain streaks.
        float fade = 1.0 - smoothstep( 0.01, 0.05, lod );
        float joints = max( fcLines( y, S, 0.025, aw ), fcLines( x, 3.0, 0.02, aw ) );
        vec2 tie = fract( p / 0.6 ) - 0.5;
        float holes = sd > 0.45 ? 1.0 - smoothstep( 0.015, 0.015 + aw, length( tie * 0.6 ) ) : 0.0;
        float streak = fcNoise( vec2( x * 4.0, y * 0.25 + sd * 9.0 ) );
        col *= 1.0 - fade * ( 0.3 * joints + 0.35 * holes ) - 0.12 * smoothstep( 0.45, 0.9, streak ) + 0.06 * ( fcNoise( p * 9.0 ) - 0.5 );
        h = -0.008 * joints * fade - 0.01 * holes * fade + 0.002 * fcNoise( p * 25.0 ) * fade;
        rough = 0.9;
      }
      // Weathering on everything: a slow blotchy variation.
      col *= 0.96 + 0.08 * weather;

      // ---------------------------------------------------------------- trim bands (front)
      bool wood = woodHouse && !party;
      if ( front && prepared && !landmark ) {
        // Corner boards on wood houses; a coping or cornice band at the roofline.
        if ( wood ) {
          float cb = max( 1.0 - fcIn( 0.14, L - 0.14, x, aw ), 0.0 );
          col = mix( col, trim, cb );
          h += 0.015 * cb;
        }
        float bandH = wood ? 0.55 : ( mat > 3.5 && mat < 5.5 ? 0.7 : 0.28 );
        float band = fcIn( topV - bandH, topV + 1.0, y, aw );
        vec3 bandCol = redTile ? mix( vec3( 0.36, 0.08, 0.04 ), vec3( 0.48, 0.13, 0.06 ), fcHash( vec2( floor( x / 0.22 ), 1.0 ) ) ) : ( mat > 3.5 && mat < 5.5 ? body * 1.18 : trim );
        if ( redTile ) bandCol *= 0.8 + 0.25 * smoothstep( 0.0, 0.5, abs( fract( x / 0.22 ) - 0.5 ) * 2.0 );
        col = mix( col, bandCol, band );
        // Dentils under a wood cornice.
        if ( wood ) {
          float dent = fcIn( topV - bandH - 0.16, topV - bandH, y, aw ) * fcIn( 0.0, 0.5, fract( x / 0.24 ) * 1.0, aw / 0.24 );
          col = mix( col, trim * 0.92, dent );
          h += 0.02 * band + 0.012 * dent;
        }
        // Belt courses at the storey lines of a wood house.
        if ( wood ) {
          float yb = y - floorM;
          float belt = yb > 0.5 && y < topV - bandH - 0.3 ? 1.0 - fcIn( 0.12, S, fract( yb / S ) * S, aw ) : 0.0;
          col = mix( col, trim, belt );
          h += 0.01 * belt;
        }
      }

      // ---------------------------------------------------------------- openings
      // Style by material and era: column width, window width, height and sill.
      float colW, ww, wh, sill;
      if ( woodHouse ) { colW = 2.05; ww = 0.82; wh = clamp( S * 0.6, 1.5, 2.4 ); sill = 0.72; }
      else if ( house ) { colW = year > 1989.0 ? 2.5 : 2.7; ww = year > 1989.0 ? 1.9 : 1.55; wh = year > 1989.0 ? 1.85 : 1.4; sill = year > 1989.0 ? 0.5 : 0.85; }
      else if ( mat > 3.5 && mat < 5.5 ) { colW = 2.1; ww = 1.15; wh = clamp( S * 0.55, 1.5, 2.7 ); sill = 0.85; }
      else if ( curtain ) { colW = 1.5; ww = 1.42; wh = S - 1.0; sill = 1.0; }
      else { colW = 3.0; ww = 2.3; wh = clamp( S * 0.48, 1.4, 2.2 ); sill = 0.95; }
      bool rear = !front && !party;
      if ( rear && !curtain ) { colW *= 1.45; ww *= 0.85; wh *= 0.85; }
      if ( !prepared ) colW = mix( 3.2, 1.7, smoothstep( 0.2, 0.9, glaze ) );

      float n = floor( ( L - 0.5 ) / colW );
      if ( n < 1.0 && L > ww + 0.5 ) n = 1.0;
      float margin = ( L - n * colW ) * 0.5;
      float c = floor( ( x - margin ) / colW );
      float cx = margin + ( c + 0.5 ) * colW;
      bool inCols = prepared ? ( c >= 0.0 && c < n ) : true;
      if ( !prepared ) { c = floor( x / colW ); cx = ( c + 0.5 ) * colW; }
      // Rows: from the first floor (raised over a stoop) on fronts; from the street elsewhere.
      float base = front ? floorM : 0.0;
      float yr = y - base;
      float row = floor( yr / S );
      float ry = yr - row * S;
      bool groundRow = front && row < 0.5 && row > -0.5;
      vec4 win = vec4( cx - ww * 0.5, cx + ww * 0.5, base + row * S + sill, base + row * S + sill + wh );
      bool rowOk = win.w <= topV - ( front ? 0.45 : 0.3 ) && ( front ? yr >= 0.0 : true ) && !party && !landmark && glaze > 0.04;
      if ( rear && !curtain && fcHash( vec2( c, row ) + sd * 3.0 ) < 0.3 ) rowOk = false;
      if ( shop && groundRow ) rowOk = false;
      // Doors and the garage take their part of the ground storey.
      float doorTop = floorM + 2.35;
      if ( hasDoor && groundRow && win.x < doorX + DOOR_HALF + 0.35 && win.y > doorX - DOOR_HALF - 0.35 ) rowOk = false;
      if ( hasGarage && y < 2.9 && win.z < GARAGE_HT + 0.3 && win.x < garageX + GARAGE_HALF + 0.3 && win.y > garageX - GARAGE_HALF - 0.3 ) rowOk = false;
      if ( hasGarage && front && floorM < 1.0 && row < 0.5 && row > -0.5 && win.x < garageX + GARAGE_HALF + 0.6 && win.y > garageX - GARAGE_HALF - 0.6 ) rowOk = false;
      float winMask = inCols && rowOk ? fcRect( p, win, aw ) : 0.0;
      float farW = smoothstep( 0.18, 0.5, lod );

      if ( inCols && rowOk && farW < 0.999 ) {
        vec2 q = p - vec2( win.x, win.z );
        float W = win.y - win.x, H = win.w - win.z;
        if ( curtain ) {
          // Curtain wall: vision glass between mullions; spandrel panels at each floor slab.
          float mull = 1.0 - fcIn( 0.04, W - 0.04, q.x, aw );
          winMask = fcIn( win.z, win.w, y, aw ) * ( 1.0 - mull );
          col = mix( col, mix( vec3( 0.14 ), vec3( 0.55, 0.56, 0.58 ), step( 0.5, sd ) ), mull * fcIn( win.z - 0.6, win.w + 0.4, y, aw ) );
        } else {
          // Casing (trim colour) around the opening; a hood over and a sill under on fronts.
          float cas = woodHouse ? 0.11 : ( house ? 0.07 : 0.06 );
          float outer = fcRect( p, vec4( win.x - cas, win.y + cas, win.z - cas, win.w + cas ), aw );
          vec3 frameCol = house || woodHouse ? trim : mix( body * 0.6, vec3( 0.12 ), 0.5 );
          col = mix( col, frameCol, outer * ( 1.0 - winMask ) );
          h += 0.02 * outer;
          if ( front && woodHouse ) {
            float hood = fcRect( p, vec4( win.x - cas - 0.09, win.y + cas + 0.09, win.w + cas, win.w + cas + 0.2 ), aw );
            col = mix( col, trim, hood );
            col *= 1.0 - 0.35 * fcRect( p, vec4( win.x - cas - 0.09, win.y + cas + 0.09, win.w + cas - 0.06, win.w + cas ), aw ) * ( 1.0 - winMask );
            h += 0.035 * hood;
          }
          float sillB = fcRect( p, vec4( win.x - cas - 0.06, win.y + cas + 0.06, win.z - cas - 0.07, win.z - cas + 0.01 ), aw );
          col = mix( col, mat > 3.5 && mat < 5.5 ? body * 1.25 : trim, sillB );
          h += 0.03 * sillB;
          // Shadow under the sill.
          col *= 1.0 - 0.3 * fcRect( p, vec4( win.x - cas - 0.06, win.y + cas + 0.06, win.z - cas - 0.16, win.z - cas - 0.07 ), aw );
        }
        fcWin = winMask;
      }
      // Glass: dark, a little sky at the top, blinds or curtains in some windows.
      float tone = fcHash( vec2( c, row ) + sd * 11.0 );
      vec2 wq = p - vec2( win.x, win.z );
      float Wd = win.y - win.x, Hd = win.w - win.z;
      vec3 glass = mix( vec3( 0.028, 0.036, 0.045 ), vec3( 0.07, 0.085, 0.1 ), clamp( wq.y / max( Hd, 0.1 ), 0.0, 1.0 ) );
      if ( curtain ) glass = mix( glass, body * 0.35, 0.5 );
      float blind = tone > 0.62 && !curtain ? fcIn( Hd * ( 1.0 - 0.25 - 0.5 * fract( tone * 7.0 ) ), Hd + 1.0, wq.y, aw ) : 0.0;
      glass = mix( glass, vec3( 0.55, 0.5, 0.42 ) * ( 0.75 + 0.25 * fcHash( vec2( row, c ) ) ), blind * 0.8 );
      // Sashes: a meeting rail at mid-height on double-hung windows; muntins by era.
      if ( !curtain && winMask > 0.0 ) {
        float sash = 0.045;
        float rail = 0.0;
        if ( woodHouse || ( house && year < 1960.0 ) || ( mat > 3.5 && mat < 5.5 ) ) rail = fcIn( Hd * 0.5 - sash, Hd * 0.5 + sash, wq.y, aw );
        float frame = 1.0 - fcIn( sash, Wd - sash, wq.x, aw ) * fcIn( sash, Hd - sash, wq.y, aw );
        float munt = 0.0;
        if ( woodHouse && sd > 0.55 ) munt = fcIn( Wd * 0.5 - 0.02, Wd * 0.5 + 0.02, wq.x, aw ); // two-over-two
        if ( house && year >= 1916.0 && year < 1945.0 ) munt = max( fcLines( wq.x + 0.015, Wd / 3.0, 0.03, aw ), fcLines( wq.y + 0.015, Hd / 4.0, 0.03, aw ) ) ; // steel casements
        if ( house && year >= 1945.0 && year < 1990.0 ) munt = fcIn( Wd * 0.3 - 0.03, Wd * 0.3 + 0.03, wq.x, aw ) + fcIn( Wd * 0.7 - 0.03, Wd * 0.7 + 0.03, wq.x, aw );
        float sashMask = clamp( max( max( rail, frame ), munt ), 0.0, 1.0 );
        vec3 sashCol = house || woodHouse ? ( year >= 1916.0 && year < 1945.0 && house && !woodHouse ? vec3( 0.06 ) : trim ) : vec3( 0.09 );
        glass = mix( glass, sashCol, sashMask );
        h += 0.01 * sashMask;
        h -= 0.05 * ( 1.0 - sashMask );
        // Reveal shadow along the top and one side of the opening.
        glass *= 1.0 - 0.45 * ( 1.0 - fcIn( 0.0, Hd - 0.09, wq.y, aw ) ) * ( 1.0 - sashMask );
        fcWin = winMask * ( 1.0 - sashMask );
      }
      col = mix( col, glass, winMask );

      // Front door: panelled, in the door colour, with a casing and (old houses) a transom.
      if ( front && hasDoor && !shop ) {
        vec4 dr = vec4( doorX - DOOR_HALF, doorX + DOOR_HALF, floorM, doorTop );
        float dm = fcRect( p, dr, aw );
        float casing = fcRect( p, vec4( dr.x - 0.12, dr.y + 0.12, dr.z, dr.w + ( woodHouse ? 0.62 : 0.12 ) ), aw ) * ( 1.0 - dm );
        col = mix( col, trim, casing );
        h += 0.025 * casing;
        vec2 dq = p - dr.xz;
        float panels = fcRect( vec2( fract( dq.x / ( DOOR_HALF ) ), fract( dq.y / 0.78 ) ), vec4( 0.16, 0.84, 0.12, 0.88 ), aw / DOOR_HALF );
        vec3 dc = doorCol * ( 1.0 - 0.18 * panels );
        float lite = woodHouse ? fcRect( dq, vec4( 0.2, 2.0 * DOOR_HALF - 0.2, 1.55, 2.15 ), aw ) : 0.0;
        dc = mix( dc, vec3( 0.04, 0.05, 0.06 ), lite );
        col = mix( col, dc, dm );
        h -= 0.06 * dm - 0.01 * panels * dm;
        if ( woodHouse ) {
          float transom = fcRect( p, vec4( dr.x, dr.y, dr.w + 0.08, dr.w + 0.5 ), aw );
          col = mix( col, vec3( 0.04, 0.05, 0.065 ), transom );
          fcWin = max( fcWin, transom );
        }
        fcLit = max( fcLit, 0.0 );
      }
      // Garage door (K4): sectional panels, painted trim or a wood tone, sometimes a row of lights.
      if ( front && hasGarage ) {
        vec4 gr = vec4( garageX - GARAGE_HALF, garageX + GARAGE_HALF, 0.0, GARAGE_HT );
        float gm = fcRect( p, gr, aw );
        float frameG = fcRect( p, vec4( gr.x - 0.12, gr.y + 0.12, gr.z, gr.w + 0.14 ), aw ) * ( 1.0 - gm );
        col = mix( col, trim * 0.95, frameG );
        h += 0.02 * frameG;
        vec2 gq = p - gr.xz;
        float sec = fcLines( gq.y, GARAGE_HT / 4.0, 0.025, aw );
        float pan = sd > 0.4 ? fcLines( gq.x, 2.0 * GARAGE_HALF / 4.0, 0.03, aw ) : 0.0;
        vec3 gc = sd > 0.75 ? vec3( 0.32, 0.2, 0.11 ) : ( sd > 0.3 ? trim * 0.92 : mix( trim, body, 0.5 ) * 0.9 );
        gc *= 1.0 - 0.3 * max( sec, pan * 0.6 );
        float lights = sd > 0.6 ? fcRect( gq, vec4( 0.2, 2.0 * GARAGE_HALF - 0.2, GARAGE_HT * 0.75 + 0.1, GARAGE_HT - 0.12 ), aw ) * ( 1.0 - pan ) : 0.0;
        gc = mix( gc, vec3( 0.05, 0.06, 0.07 ), lights );
        col = mix( col, gc, gm );
        h -= 0.04 * gm;
        h -= 0.01 * max( sec, pan ) * gm;
      }
      // Basement windows under a raised first floor (K7): small, barred-looking, low.
      if ( front && floorM >= 1.1 && y < floorM - 0.2 && inCols && !shop ) {
        vec4 bw = vec4( cx - ww * 0.45, cx + ww * 0.45, floorM - 0.8, floorM - 0.3 );
        bool clear = !( hasDoor && abs( cx - doorX ) < DOOR_HALF + 0.9 ) && !( hasGarage && abs( cx - garageX ) < GARAGE_HALF + 0.9 );
        float bm = clear ? fcRect( p, bw, aw ) : 0.0;
        col = mix( col, mix( vec3( 0.03 ), trim * 0.5, fcLines( p.x - bw.x, 0.12, 0.02, aw ) ), bm );
        h -= 0.04 * bm;
      }
      // Shopfront (K5, the shader's half): bulkhead, glass with mullions, door recesses,
      // transom, and a blank fascia (the empty sign slot: no names, ever).
      if ( shop && front && y < max( S, 3.4 ) && y > -0.5 ) {
        float sh = max( S, 3.4 );
        vec3 fr = mix( doorCol, vec3( 0.08 ), 0.4 );
        float bx = mod( x - margin * 0.0, 5.0 );
        float doorBay = fcIn( 3.85, 4.85, bx, aw ) * fcIn( -1.0, 2.4, y, aw );
        float bulk = fcIn( -1.0, 0.6, y, aw ) * ( 1.0 - doorBay );
        float glassM = fcIn( 0.66, sh - 0.95, y, aw ) * ( 1.0 - fcLines( bx + 0.03, 1.66, 0.06, aw ) );
        float transom = fcIn( sh - 0.85, sh - 0.6, y, aw ) * ( 1.0 - fcLines( bx + 0.02, 0.8, 0.04, aw ) );
        float fascia = fcIn( sh - 0.55, sh, y, aw );
        vec3 sc = fr;
        sc = mix( sc, vec3( 0.03, 0.04, 0.05 ) + 0.03 * fcHash( vec2( floor( x / 5.0 ), 9.0 ) ), max( glassM, transom ) );
        sc = mix( sc, vec3( 0.015 ), doorBay * fcIn( 0.0, 2.3, y, aw ) );
        float slot = fcIn( sh - 0.5, sh - 0.06, y, aw ) * fcIn( 1.0, 4.0, bx, aw );
        sc = mix( sc, mix( fr, vec3( 0.75, 0.73, 0.68 ), 0.55 ), slot * fascia );
        float m = max( max( bulk, glassM ), max( transom, max( fascia, doorBay ) ) );
        col = mix( col, sc, clamp( m, 0.0, 1.0 ) );
        float g2 = max( glassM, transom );
        fcWin = max( fcWin, g2 );
        h += -0.08 * g2 + 0.02 * fascia;
        float shopLit = fcHash( vec2( floor( x / 5.0 ), sd ) ) < 0.8 ? 1.0 : 0.0;
        fcLit = max( fcLit, g2 * shopLit * mix( 0.9, 0.45, farW ) );
        fcLightCol = vec3( 1.0, 0.84, 0.6 );
      }

      // Far away, the openings average out instead of shimmering.
      if ( farW > 0.0 && !landmark && !party ) {
        float share = prepared ? clamp( ww * wh / ( colW * S ), 0.05, 0.75 ) : 0.3;
        if ( !inCols || !( y > base + 0.5 && y < topV - 0.6 ) ) share = 0.0;
        if ( rear ) share *= 0.65;
        vec3 avg = mix( col, vec3( 0.045, 0.055, 0.065 ), share * 0.8 );
        col = mix( col, avg, farW );
        fcWin = mix( fcWin, share * 0.6, farW );
      }

      // Night: lit windows come in clusters (a flat, an office floor); houses are well lived in.
      if ( fcWin > 0.0 ) {
        float cluster = fcHash( floor( vec2( c, row ) / vec2( 3.0, 2.0 ) ) + sd * 3.3 + 7.3 );
        float litFrac = curtain ? 0.25 : ( house ? 0.42 : 0.3 );
        float on = step( 1.0 - litFrac * ( 0.35 + 1.3 * cluster ), tone );
        float lit = mix( on * ( 1.0 - blind * 0.3 ), litFrac * 0.5, farW ) * fcWin;
        fcLit = max( fcLit, lit );
        if ( !shop || !groundRow ) fcLightCol = tone > 0.86 ? vec3( 0.75, 0.86, 1.0 ) : ( tone > 0.6 ? vec3( 1.0, 0.85, 0.6 ) : vec3( 1.0, 0.7, 0.4 ) );
      }
      // Grime at the foot of every wall.
      col *= 1.0 - 0.14 * ( 1.0 - smoothstep( 0.0, 0.7, y - min( 0.0, base ) ) ) * ( 1.0 - fcWin );
      diffuseColor.rgb = col;
      fcH = h * ( 1.0 - smoothstep( 0.04, 0.12, lod ) );
      fcRough = mix( rough, 0.1, clamp( fcWin, 0.0, 1.0 ) );
    }
  }
`;

export const FACADE_ROUGHNESS = /* glsl */ `
  if ( fcRough >= 0.0 ) roughnessFactor = fcRough;
`;

export const FACADE_NORMAL = /* glsl */ `
  normal = fcPerturb( - vViewPosition, normal, vec2( dFdx( fcH ), dFdy( fcH ) ), faceDirection );
`;

export const FACADE_EMISSIVE = /* glsl */ `
  totalEmissiveRadiance += fcLightCol * fcLit * fcNight * 1.7;
`;

/** Shader constants shared with house-kit.ts (GARAGE_W, GARAGE_H, DOOR_W). */
export function facadeDefines(garageW: number, garageH: number, doorW: number): string {
  return `#define GARAGE_HALF ${(garageW / 2).toFixed(3)}\n#define GARAGE_HT ${garageH.toFixed(3)}\n#define DOOR_HALF ${(doorW / 2).toFixed(3)}\n`;
}
