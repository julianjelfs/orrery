// Shared GLSL. Simplex noise is Ashima Arts / Stefan Gustavson (MIT).

export const noise = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum * 0.5 + 0.5;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;

export const planetVertex = /* glsl */ `
varying vec3 vPos;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vPos = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// One shader, six worlds. uStyle picks the surface; uStatus is 1 up, 0 down, 0.5 unknown.
export const planetFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uStatus;
uniform float uHover;
uniform float uFlash;
uniform float uSeed;
uniform int uStyle;
varying vec3 vPos;
varying vec3 vNormalW;
varying vec3 vWorldPos;
${noise}

float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, normalize(vec2(1.0, 1.732))), p.x);
}

vec4 hexCoords(vec2 uv) {
  vec2 r = vec2(1.0, 1.732);
  vec2 h = r * 0.5;
  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  return vec4(gv, uv - gv);
}

void main() {
  vec3 p = normalize(vPos) + uSeed;
  vec3 sp = normalize(vPos);
  vec3 n = normalize(vNormalW);
  vec3 lightDir = normalize(-vWorldPos);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float lambert = max(dot(n, lightDir), 0.0);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);

  vec3 base = vec3(0.0);
  vec3 glow = vec3(0.0);

  if (uStyle == 0) {
    // lava: dark crust, rivers of light
    float f = fbm(p * 2.4 + vec3(0.0, uTime * 0.04, 0.0));
    float rivers = 1.0 - smoothstep(0.0, 0.07, abs(snoise(p * 3.5 + vec3(uTime * 0.03))));
    base = mix(vec3(0.04, 0.015, 0.01), uColor * 0.3, f);
    glow = uColor * rivers * 2.6 + vec3(1.0, 0.85, 0.5) * pow(rivers, 6.0) * 1.5 + uColor * pow(f, 5.0) * 2.0;
  } else if (uStyle == 1) {
    // strings: a banded giant, bands drawn like strings across it
    float f = fbm(vec3(p.x * 1.5, p.y * 7.0, p.z * 1.5) + vec3(uTime * 0.05, 0.0, 0.0));
    float bands = sin(sp.y * 22.0 + f * 5.0) * 0.5 + 0.5;
    base = mix(uColor * 0.18, uColor * 1.0, bands) + vec3(0.12) * f;
    glow = uColor * pow(bands, 12.0) * 0.6;
  } else if (uStyle == 2) {
    // ice: pale shell, glowing fractures, a hard specular glint
    float f = fbm(p * 3.0);
    float veins = 1.0 - smoothstep(0.0, 0.035, abs(snoise(p * 5.5)));
    base = mix(vec3(0.55, 0.68, 0.8), vec3(0.95, 0.98, 1.0), f) * 0.75;
    glow = uColor * veins * 1.6;
    glow += vec3(1.0) * pow(max(dot(reflect(-lightDir, n), viewDir), 0.0), 48.0) * 2.0;
  } else if (uStyle == 3) {
    // honeycomb: cells filling and emptying with honey
    vec2 uv = vec2(atan(sp.z, sp.x) / 6.2831 * 16.0, acos(clamp(sp.y, -1.0, 1.0)) / 3.1416 * 8.0);
    vec4 hc = hexCoords(uv);
    float edge = smoothstep(0.42, 0.5, hexDist(hc.xy));
    float level = hash21(hc.zw);
    float fill = 0.5 + 0.5 * sin(uTime * 0.8 + level * 6.2831);
    base = mix(uColor * 0.08, uColor * 0.9, fill * (1.0 - edge));
    glow = uColor * edge * 1.4 + uColor * pow(fill, 8.0) * (1.0 - edge) * 1.2;
  } else if (uStyle == 4) {
    // moon: cratered rock with a faint green pulse
    float f = fbm(p * 4.5);
    float craters = smoothstep(0.55, 0.8, fbm(p * 9.0));
    base = vec3(0.32) * f + vec3(0.1) * craters + uColor * 0.06;
    glow = uColor * pow(f, 7.0) * 3.0 * (0.6 + 0.4 * sin(uTime * 2.0));
  } else if (uStyle == 6) {
    // waves: sound rippling out from a pole, interfering as it goes
    float f = fbm(p * 2.0);
    float r1 = acos(clamp(dot(sp, normalize(vec3(0.3, 1.0, 0.2))), -1.0, 1.0));
    float r2 = acos(clamp(dot(sp, normalize(vec3(-0.8, -0.3, 0.5))), -1.0, 1.0));
    float w = sin(r1 * 28.0 - uTime * 3.0) + sin(r2 * 22.0 - uTime * 2.3);
    float crest = smoothstep(1.2, 2.0, w);
    base = mix(uColor * 0.12, uColor * 0.55, f) + uColor * 0.25 * (w * 0.25 + 0.5);
    glow = uColor * crest * 1.8;
  } else {
    // values: a photograph flattened to a few tones, as Askance would see it
    float f = fbm(p * 2.2 + vec3(0.0, 0.0, uTime * 0.02));
    float steps = 4.0;
    float v = floor(f * steps * 1.4 - 0.2) / steps;
    base = vec3(clamp(v, 0.0, 1.0)) * uColor;
    float line = 1.0 - smoothstep(0.0, 0.02, abs(fract(f * steps * 1.4 - 0.2) - 0.5) - 0.48);
    glow = uColor * line * 0.25;
  }

  vec3 col = base * (0.06 + lambert * 1.15) + glow;
  col += uColor * fres * (0.3 + uHover * 1.3);
  col += uColor * uFlash * 1.8;

  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  if (uStatus < 0.25) {
    // down: drained of colour, cracked, flickering red
    col = vec3(lum) * 0.25;
    float crack = 1.0 - smoothstep(0.0, 0.03, abs(snoise(sp * 4.5 + uSeed)));
    float flick = step(0.45, fract(sin(floor(uTime * 11.0) + uSeed) * 43758.5453));
    col += vec3(1.0, 0.1, 0.08) * crack * (0.4 + flick * 1.8);
  } else if (uStatus < 0.75) {
    // unknown: a ghost of itself, scanned
    col = mix(vec3(lum) * 0.5, col, 0.12);
    col += uColor * 0.35 * step(0.96, fract(vWorldPos.y * 6.0 - uTime * 0.7));
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export const atmosphereVertex = /* glsl */ `
varying vec3 vNormalV;
void main() {
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const atmosphereFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vNormalV;
void main() {
  float i = pow(max(0.72 - dot(vNormalV, vec3(0.0, 0.0, 1.0)), 0.0), 2.4);
  gl_FragColor = vec4(uColor * i * uIntensity, 1.0);
}
`;

export const coreFragment = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform float uAlive;
varying vec3 vPos;
varying vec3 vNormalW;
varying vec3 vWorldPos;
${noise}
void main() {
  vec3 p = normalize(vPos);
  float f = fbm(p * 2.0 + vec3(uTime * 0.12, -uTime * 0.08, uTime * 0.05));
  float g = fbm(p * 5.0 - vec3(uTime * 0.2));
  vec3 deep = vec3(0.35, 0.0, 0.08);
  vec3 rasp = vec3(0.89, 0.07, 0.36);
  vec3 hot = vec3(1.0, 0.55, 0.75);
  vec3 col = mix(deep, rasp, smoothstep(0.3, 0.6, f));
  col = mix(col, hot, smoothstep(0.62, 0.85, f * 0.6 + g * 0.5));
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - max(dot(normalize(vNormalW), viewDir), 0.0), 2.0);
  col += rasp * fres * 1.5;
  col *= 0.85 + uBeat * 1.4;
  vec3 dead = vec3(dot(col, vec3(0.3, 0.59, 0.11))) * vec3(0.35, 0.45, 0.6) * 0.5;
  gl_FragColor = vec4(mix(dead, col, uAlive), 1.0);
}
`;

export const nebulaVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const nebulaFragment = /* glsl */ `
uniform float uTime;
varying vec3 vDir;
${noise}
void main() {
  vec3 d = vDir;
  float a = fbm(d * 1.6 + vec3(uTime * 0.004));
  float b = fbm(d * 3.1 - vec3(uTime * 0.006) + 7.0);
  vec3 indigo = vec3(0.05, 0.02, 0.14);
  vec3 magenta = vec3(0.26, 0.03, 0.2);
  vec3 teal = vec3(0.02, 0.15, 0.2);
  vec3 col = mix(vec3(0.005, 0.004, 0.012), indigo, smoothstep(0.35, 0.7, a));
  col = mix(col, magenta, smoothstep(0.55, 0.85, a * b * 1.6));
  col = mix(col, teal, smoothstep(0.6, 0.9, b) * 0.7);
  // A band across the sky, like a galaxy seen edge on.
  col += vec3(0.12, 0.08, 0.16) * exp(-pow(d.y * 3.0 + (a - 0.5), 2.0) * 4.0) * b;
  gl_FragColor = vec4(col * 0.7, 1.0);
}
`;

export const starVertex = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vTwinkle;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vTwinkle = 0.55 + 0.45 * sin(uTime * (0.6 + fract(aPhase) * 2.0) + aPhase * 10.0);
  vColor = aColor;
  gl_PointSize = aSize * uPixelRatio * (140.0 / -mv.z);
}
`;

export const starFragment = /* glsl */ `
varying vec3 vColor;
varying float vTwinkle;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * vTwinkle * core * core * 1.6, 1.0);
}
`;

export const trailVertex = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const trailFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor * vAlpha * vAlpha * uOpacity, 1.0);
}
`;

export const streakVertex = /* glsl */ `
attribute float aEnd;
uniform float uWarp;
varying float vEnd;
void main() {
  vEnd = aEnd;
  vec3 p = position;
  p.z += aEnd * uWarp * 26.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const streakFragment = /* glsl */ `
uniform float uWarp;
uniform vec3 uColor;
varying float vEnd;
void main() {
  gl_FragColor = vec4(mix(vec3(1.0), uColor, vEnd) * uWarp * (0.3 + vEnd * 1.4), 1.0);
}
`;

// Final pass: chromatic fringe, zoom blur while warping, vignette, film grain.
export const lensFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uWarp;
uniform vec2 uResolution;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c);
  float ab = (0.004 + uWarp * 0.05) * d;
  vec3 col = vec3(0.0);
  // One tap unless warping; eight for the zoom blur.
  int taps = uWarp > 0.001 ? 8 : 1;
  for (int i = 0; i < 8; i++) {
    if (i >= taps) break;
    float s = 1.0 - uWarp * 0.14 * float(i) / 8.0;
    vec2 uv = 0.5 + c * s;
    col.r += texture2D(tDiffuse, uv + c * ab).r;
    col.g += texture2D(tDiffuse, uv).g;
    col.b += texture2D(tDiffuse, uv - c * ab).b;
  }
  col /= float(taps);
  col *= smoothstep(1.05, 0.2, d * (1.0 + uWarp * 0.6));
  col += (hash(vUv * uResolution + fract(uTime) * 100.0) - 0.5) * 0.025;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const lensVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
