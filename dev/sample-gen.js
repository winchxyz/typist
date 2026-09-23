// DEV ONLY: procedural stand-ins for the four sample photographs. dev/samples.html renders them
// and bakes img/samples/<id>.jpg (+ -thumb.jpg); the app only ever loads those JPEGs (see
// js/samples.js), so nothing here ships or compiles on a user's device.
//
//   portrait  raymarched plaster bust, soft key light from the upper left + occlusion
//   pet       raymarched tabby-and-white cat head; whiskers drawn in 2D on top
//   landmark  a striped lighthouse on a rocky headland at sunset, painted in 2D
//   logo      a black-and-white roundel emblem: peaks, sun and waves inside a double ring
//
// Adapted from Spiralist's sample runner. Compile time is the budget on D3D (ANGLE inlines every
// call and unrolls every loop it can): each raymarcher calls its SDF from exactly ONE place and
// every loop bound goes through the uZero uniform. They are judged as small text art (28-40
// Braille columns), so every one is large, separated tonal masses first and detail second.
// Deterministic: no Math.random, fixed seeds.

// ------------------------------------------------------------------------------ GLSL chunks
const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;      // render target size, px
uniform int uZero;      // always 0
uniform vec4 uView;     // dev overrides (yaw, pitch, roll, spare); zero = the shipped framing
out vec4 outColor;

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float vnoise1(float x) { float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }
float vnoise2(vec2 x) {
  vec2 i = floor(x), f = fract(x); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float vnoise3(vec3 x) {
  vec3 i = floor(x), f = fract(x); vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = uZero; i < 5; i++) { s += a * vnoise2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1; a *= 0.5; }
  return s / 0.96875;
}

mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / k1; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float smax(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
// 1 below a, 0 above b (a < b): the falling edge without reversed smoothstep edges (undefined in GLSL)
float fall(float a, float b, float x) { return 1.0 - smoothstep(a, b, x); }

// Ray vs axis-aligned box (centre c, half size h): (tnear, tfar).
vec2 boxHit(vec3 ro, vec3 rd, vec3 c, vec3 h) {
  vec3 m = 1.0 / rd, n = m * (ro - c), k = abs(m) * h;
  vec3 t1 = -n - k, t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}
// Tetrahedral offsets for 4-tap normals.
vec3 tet(int i) { return 0.5773 * (2.0 * vec3(float(((i + 3) >> 1) & 1), float((i >> 1) & 1), float(i & 1)) - 1.0); }

vec3 acesFilm(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
// Photographic finish: sRGB encode + a whisper of sensor grain (it also hides banding).
vec4 finish(vec3 lin) {
  vec3 c = toSRGB(lin);
  c += (hash12(gl_FragCoord.xy * 1.37 + 11.0) - 0.5) * (1.6 / 255.0);
  return vec4(c, 1.0);
}
`;

// Shared driver for the raymarchers: MAP(p) is called from one place only. Phases: 0 march,
// 1 four normal taps, 2 six occlusion taps, 3 soft shadow toward the key light, 4 done.
// Leaves: hit, pos, nrm, occ (raw occlusion sum), res (shadow 0..1), mat (MAP(p).y at the hit),
// dmin / pmin (closest approach of a ray that missed: soft silhouettes).
const MARCH = (MAP, { eps, stepK, maxSteps, nEps, aoStep, aoBase, aoFall, shK, shMin, shMax, shFar, onHit = '' }) => `
    int phase = 0, k = 0, steps = 0;
    float t = 0.0, occ = 0.0, sca = 1.0, res = 1.0, ts = ${shMin}, mat = 0.0, dmin = 1e3;
    vec3 P = o, pos = o, nrm = vec3(0.0), sp = o, pmin = o;
    for (int i = uZero; i < ${maxSteps + 90}; i++) {
      vec2 hm = ${MAP}(P);
      float h = hm.x;
      if (phase == 0) {
        if (h < ${eps}) { phase = 1; pos = P; mat = hm.y; k = 0; ${onHit} }
        else {
          if (h < dmin) { dmin = h; pmin = P; }
          t += h * ${stepK}; steps++;
          if (t > tmax || steps > ${maxSteps}) break;
          P = o + lrd * t;
          continue;
        }
      } else if (phase == 1) {
        nrm += tet(k) * h; k++;
        if (k == 4) { nrm = normalize(nrm); phase = 2; k = 0; }
      } else if (phase == 2) {
        occ += (${aoBase} + ${aoStep} * float(k) - h) * sca; sca *= ${aoFall}; k++;
        if (k == 6) { phase = 3; k = 0; sp = pos + nrm * ${nEps * 3}; }
      } else {
        res = min(res, ${shK} * h / ts);
        ts += clamp(h * 0.8, ${shMin}, ${shMax}); k++;
        if (res < 0.002 || ts > ${shFar} || k > 64) { phase = 4; break; }
      }
      if (phase == 1) P = pos + ${nEps} * tet(k);
      else if (phase == 2) P = pos + nrm * (${aoBase} + ${aoStep} * float(k));
      else P = sp + lk * ts;
    }
    bool hit = phase >= 3;
    res = clamp(res, 0.0, 1.0);
    res = res * res * (3.0 - 2.0 * res);
`;

// ---------------------------------------------------------------------------------- bust
// Units: centimetres, head space y up, z out of the face, origin between the eyes.
const BUST = HEAD + `
const float HALF = 17.5;   // half the frame height at the subject, cm
const float CAMD = 175.0;  // camera distance (a long portrait lens)
const float CY = -1.9;     // world height at the frame centre
const float CX = -2.2;     // the turned face sits left of the neck axis: centre on the nose bridge

const vec3 CAPC = vec3(0.0, 3.0, -0.9), CAPR = vec3(7.8, 9.3, 10.2);
float hairCapSd(vec3 p) { return sdEllipsoid(p - CAPC, CAPR); }
// Region above the hairline (negative inside): low at the temples, lower still behind the ears.
float hairlineSd(vec3 p) { return (4.3 - 0.045 * p.x * p.x + 0.46 * (p.z - 9.0)) - p.y; }

// Sculpted hair: broad locks combed out from a whorl at the crown, each with its own gentle
// S-wave and a few chiselled strands; the lock ends scallop the hairline.
float hairSd(vec3 p, float cap) {
  vec3 r = p - CAPC;
  vec3 w = normalize(vec3(0.0, 1.0, -0.5));          // whorl axis: up and back
  vec3 u = normalize(vec3(0.0, 0.0, 1.0) - w * dot(vec3(0.0, 0.0, 1.0), w));   // forward: seam at the back
  vec3 v = cross(w, u);
  float th = acos(clamp(dot(normalize(r), w), -1.0, 1.0));   // 0 at the crown
  float ph = atan(dot(r, v), dot(r, u));
  // Every lock waves in the same phase (combed hair moves together) and the whole mass sweeps a
  // little round the whorl. A random phase per lock made neighbours pinch and swell against
  // each other, which read as wavy banding.
  float s0 = ph * (24.0 / 6.2831853);
  float s = s0 + 0.8 * th + 0.25 * sin(th * 4.5);
  float f = fract(s) * 2.0 - 1.0;
  float lock = 1.0 - pow(abs(f), 2.4);               // flat-topped lock, V groove between locks
  lock -= 0.16 * (0.5 + 0.5 * cos(f * 12.566)) * lock;   // chiselled strands
  float amp = 0.55 * smoothstep(0.12, 0.45, th) * (0.6 + 0.8 * hash11(floor(s) + 7.0));
  float hair = cap + 0.2 - amp * lock;
  float cut = hairlineSd(p) - 0.6 * lock;            // rounded lock ends along the hairline
  return smax(hair, cut, 0.35) * 0.6;
}

// The broad forms are data, iterated by one loop each, so the compiler sees each primitive
// once (inlining ~25 primitives separately doubled the compile time).
// Ellipsoids blended in: (centre, blend k), (radii, mirrored in x).
const vec4 EC[8] = vec4[8](
  vec4(0.0, 2.2, -1.2, 0.01), vec4(0.0, 3.8, 4.8, 2.0),      // cranium, forehead
  vec4(0.0, -4.0, 3.6, 2.5), vec4(4.5, -1.2, 4.8, 2.2),      // face, cheekbones
  vec4(3.0, -2.3, 6.8, 1.6), vec4(0.0, -10.2, 8.0, 1.4),     // under the eye, chin
  vec4(0.0, -7.2, 7.0, 2.4), vec4(0.0, -30.0, -1.0, 3.0));   // mouth barrel, chest
const vec4 ER[8] = vec4[8](
  vec4(7.0, 8.8, 9.4, 0.0), vec4(5.4, 4.4, 4.5, 0.0),
  vec4(6.0, 6.2, 5.8, 0.0), vec4(1.9, 1.45, 2.4, 1.0),
  vec4(1.9, 1.5, 1.7, 1.0), vec4(2.1, 1.8, 1.9, 0.0),
  vec4(3.2, 2.7, 3.0, 0.0), vec4(17.5, 11.0, 9.5, 0.0));
// Capsules blended in, mirrored: (end a, radius), (end b, blend k).
const vec4 CA[8] = vec4[8](
  vec4(4.8, -1.3, 4.4, 0.7), vec4(5.4, -2.5, 0.0, 1.3),      // zygomatic arch, ramus
  vec4(4.9, -7.4, -0.6, 1.15), vec4(0.0, 1.5, 9.2, 0.95),    // jaw, brow ridge
  vec4(0.0, -22.0, 0.3, 5.5), vec4(4.8, -5.5, -3.0, 1.3),    // neck, neck muscle
  vec4(4.0, -18.5, -2.0, 4.6), vec4(1.8, -20.2, 4.6, 0.8));  // shoulder, clavicle
const vec4 CB[8] = vec4[8](
  vec4(6.4, -1.4, 0.6, 1.5), vec4(4.9, -7.4, -0.6, 2.0),
  vec4(0.0, -10.5, 7.2, 2.8), vec4(4.6, 1.9, 7.7, 1.4),
  vec4(0.0, -7.5, -2.4, 1.6), vec4(1.3, -19.5, 3.8, 1.5),
  vec4(16.0, -23.5, -1.5, 3.0), vec4(11.5, -19.0, 1.5, 1.2));

vec2 mapBust(vec3 p) {
  vec3 q = vec3(abs(p.x), p.yz);
  float d = 1e3;
  for (int i = uZero; i < 8; i++) {
    vec4 c = EC[i], r = ER[i];
    d = smin(d, sdEllipsoid((r.w > 0.5 ? q : p) - c.xyz, r.xyz), c.w);
  }
  for (int i = uZero; i < 8; i++) d = smin(d, sdCapsule(q, CA[i].xyz, CB[i].xyz, CA[i].w), CB[i].w);

  // eyes: a shallow socket, the eyeball, and lids = eyeball shells cut by two planes through
  // its centre (the planes meet at the corners: the almond), melted into brow and cheek
  d = smax(d, -sdEllipsoid(q - vec3(3.15, 0.3, 9.3), vec3(1.95, 1.2, 1.3)), 0.9);
  vec3 e = q - vec3(3.15, 0.0, 7.55);
  float le = length(e);
  float lidU = smax(le - 1.48, -dot(e, vec3(0.0, 0.96, -0.28)), 0.12);
  float lidL = smax(le - 1.36, -dot(e, vec3(0.0, -0.9, -0.44)), 0.1);
  d = smin(d, min(lidU, lidL), 0.6);
  float eye = le - 1.25;
  // drilled pupils (Roman style), turned a little toward the camera
  vec3 ec = p - vec3(sign(p.x) * 3.15, 0.0, 7.55);
  eye = smax(eye, -(length(ec - normalize(vec3(0.24, 0.02, 1.0)) * 1.28) - 0.3), 0.1);
  d = min(d, eye);

  // nose: a straight Greek bridge, the tip, the wings, the nostrils
  float nose = sdCapsule(p, vec3(0.0, 0.5, 9.2), vec3(0.0, -3.7, 11.3), 0.58);
  nose = smin(nose, sdEllipsoid(p - vec3(0.0, -4.0, 11.15), vec3(0.85, 0.75, 0.8)), 0.8);
  nose = smin(nose, sdEllipsoid(q - vec3(1.12, -4.3, 10.3), vec3(0.8, 0.7, 0.85)), 0.9);
  d = smin(d, nose, 0.9);
  d = smax(d, -sdEllipsoid(q - vec3(0.55, -4.95, 10.7), vec3(0.4, 0.24, 0.5)), 0.25);

  // lips on a bent axis (the mouth wraps round the teeth): an upper lip of two lobes under a
  // cupid's bow, a fuller lower lip, a parting line and small dimples at the corners
  vec3 m = p - vec3(0.0, -7.1, 9.9); m.z += 0.13 * m.x * m.x;
  vec3 mq = vec3(abs(m.x), m.yz);
  float ul = sdEllipsoid(mq - vec3(0.5, 0.04, 0.15), vec3(1.55, 0.66, 0.85));
  float ll = sdEllipsoid(m - vec3(0.0, -1.18, 0.05), vec3(1.7, 0.85, 1.05));
  d = smin(d, smin(ul, ll, 0.3), 0.3);
  // the parting ends inside the corners (an ellipsoid tapers to nothing at its ends), where a
  // small pit takes over; wider, it ran on across the cheeks as a knife cut
  d = smax(d, -sdEllipsoid(m - vec3(0.0, -0.6, 0.45), vec3(1.62, 0.07, 1.3)), 0.1);   // parting
  d = smax(d, -(length(mq - vec3(1.68, -0.62, -0.3)) - 0.22), 0.2);                   // corners
  d = smax(d, -sdEllipsoid(p - vec3(0.0, -5.95, 10.6), vec3(0.32, 0.55, 0.22)), 0.3);  // philtrum

  // ears: a flat shell with a hollow bowl, tipped back
  vec3 ea = q - vec3(7.05, -1.9, -0.8);
  ea.xz = rot2(0.3) * ea.xz;
  float ear = sdEllipsoid(ea, vec3(0.75, 3.0, 1.75));
  ear = smax(ear, -sdEllipsoid(ea - vec3(0.6, 0.35, 0.1), vec3(0.5, 2.2, 1.3)), 0.25);
  d = smin(d, ear, 0.6);

  // hair (bounded by its cap: the expensive lock pattern only runs near it)
  float cap = hairCapSd(p);
  float hairMat = 0.0;
  if (cap < 1.5) {
    float hair = hairSd(p, cap);
    hairMat = 1.0 - smoothstep(-0.2, 0.3, hair - d);
    d = smin(d, hair, 0.3);
  } else {
    // locks stand at most 0.2 - 0.55 * 1.4 = -0.57 from the cap surface: a safe bound far away
    d = min(d, cap - 0.6);
  }
  return vec2(d, hairMat);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 ro = vec3(CX, CY, CAMD);
  vec3 rd = normalize(vec3(uv * HALF, 0.0) + vec3(CX, CY, 0.0) - ro);
  float yaw = -0.33 + uView.x, pitch = 0.05 + uView.y, roll = 0.03 + uView.z;
  mat3 M = rotY(yaw) * rotX(pitch) * rotZ(roll);
  mat3 Mt = transpose(M);

  // Lights (world): soft key up and to the left but near the lens, so the nose shadow stays
  // short (a long one read as a moustache at 28 columns) while the eye sockets, nostrils, mouth
  // and chin still shade; dim fill right, a cool rim from behind to lift the shadow-side edge.
  vec3 kP = vec3(-24.0, 42.0, 100.0) + vec3(CX, CY, 0.0);   // key: a large soft box ~1 m away
  vec3 kL = normalize(kP - vec3(CX, CY, 0.0));
  vec3 fL = normalize(vec3(0.85, 0.05, 0.55));
  vec3 rL = normalize(vec3(0.75, 0.35, -0.55));

  // studio backdrop: dark charcoal, near uniform, so the pale bust is one clear light shape
  // (a mid grey backdrop dithered into noise round the head as small text art)
  float pool = exp(-dot(uv - vec2(0.55, 0.2), uv - vec2(0.55, 0.2)) * 1.3);
  vec3 col = vec3(0.045, 0.044, 0.046) * (0.8 + 0.2 * smoothstep(-1.0, 1.0, uv.x) + 0.35 * pool);
  col *= (0.9 + 0.1 * uv.y) * (1.0 - 0.1 * dot(uv, uv));

  vec3 lro = Mt * ro, lrd = Mt * rd;
  vec3 lk = Mt * kL, lf = Mt * fL, lr = Mt * rL, lkP = Mt * kP;
  vec2 tb = boxHit(lro, lrd, vec3(0.0, -14.0, 0.0), vec3(22.0, 28.0, 15.0));
  if (tb.x < tb.y && tb.y > 0.0) {
    float t0 = max(tb.x, 0.0);
    vec3 o = lro + lrd * t0;
    float tmax = tb.y - t0;
${MARCH('mapBust', { eps: '0.004', stepK: '0.75', maxSteps: 230, nEps: 0.012, aoStep: '0.55', aoBase: '0.12', aoFall: '0.72', shK: '9.0', shMin: '0.06', shMax: '2.5', shFar: '60.0', onHit: 'lk = normalize(lkP - P);' })}
    if (hit) {
      float ao = clamp(1.0 - 0.28 * occ, 0.0, 1.0);
      vec3 n = nrm;
      // matte plaster; inverse-square falloff from the soft box keeps the chest and chin a
      // little darker than the brow
      float fallK = pow(length(kP) / length(lkP - pos), 2.0);
      float dif = clamp(dot(n, lk), 0.0, 1.0) * res * fallK;
      float fill = clamp(0.5 + 0.5 * dot(n, lf), 0.0, 1.0);
      float sky = clamp(0.5 + 0.5 * dot(n, Mt * vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
      float bounce = 1.0 - sky;
      float rim = pow(clamp(1.0 + dot(n, lrd), 0.0, 1.0), 3.0) * clamp(dot(n, lr) + 0.3, 0.0, 1.0);
      vec3 alb = vec3(0.80, 0.775, 0.735) * (0.965 + 0.07 * vnoise3(pos * 3.1));
      alb *= 1.0 - 0.16 * mat;      // old cast: dust has settled among the locks
      vec3 lin = vec3(1.0, 0.97, 0.92) * dif * 0.74
               + vec3(0.62, 0.66, 0.72) * sky * 0.16 * ao
               + vec3(0.75, 0.75, 0.78) * fill * 0.3 * ao
               + vec3(0.9, 0.82, 0.72) * bounce * 0.04 * ao;
      col = alb * lin * mix(1.0, ao, 0.7) + vec3(0.55, 0.6, 0.7) * rim * 0.5 * ao;
    }
  }
  col = acesFilm(col * 1.3);
  outColor = finish(col);
}
`;

// ---------------------------------------------------------------------------------- cat
// Units: centimetres, head space y up, z out of the face, origin between the eyes.
const CAT = HEAD + `
const float HALF = 10.8;
const float CAMD = 95.0;
const float CY = -1.7;
const vec3 EYE = vec3(1.8, 0.3, 1.85);   // right eye centre (mirrored)
const float EYER = 1.2;

// Head, neck and shoulders as data (one loop: the compiler sees one ellipsoid).
// (centre, blend k), (radii, mirrored in x)
const vec4 KC[10] = vec4[10](
  vec4(0.0, 0.9, -0.7, 0.01), vec4(2.45, -1.35, 0.7, 1.6),   // cranium, cheeks
  vec4(3.5, -1.9, -0.3, 1.3), vec4(0.0, -0.8, 2.2, 1.2),     // cheek ruff, nose bridge
  vec4(0.95, -2.35, 3.15, 0.7), vec4(0.0, -3.2, 2.55, 0.6),  // whisker pads, chin
  vec4(0.0, -5.0, -0.8, 2.2), vec4(0.0, -11.8, -3.0, 2.8),   // neck ruff, shoulders
  vec4(0.0, -8.2, 0.3, 2.2), vec4(2.3, -14.0, 1.2, 1.2));    // chest, forelegs
const vec4 KR[10] = vec4[10](
  vec4(4.0, 3.5, 3.9, 0.0), vec4(2.75, 2.25, 2.6, 1.0),
  vec4(1.5, 1.9, 2.1, 1.0), vec4(1.5, 2.0, 1.8, 0.0),
  vec4(1.1, 0.95, 1.05, 1.0), vec4(0.95, 0.72, 0.9, 0.0),
  vec4(4.8, 3.5, 3.8, 0.0), vec4(7.0, 6.5, 5.0, 0.0),
  vec4(4.3, 4.2, 3.4, 0.0), vec4(1.5, 4.5, 1.5, 1.0));

// ear: a cone thinned along the direction it faces; only a shell of its back half is kept, so
// the hollow faces the camera. Returns (distance, 1 inside the hollow).
const vec3 EAR_B = vec3(2.55, 3.0, -0.5), EAR_T = vec3(3.9, 7.0, -1.0);
const vec3 EAR_F = vec3(0.2873, 0.0958, 0.9530);        // facing: forward and a little out
// Tapered capsule: cheaper than an exact round cone (no branches); scaled to stay a bound.
float sdTaper(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return (length(pa - ba * h) - mix(r1, r2, h)) * 0.9;
}
vec2 ears(vec3 q) {
  // one cone: keep a shell of its surface, then cut the front half away so the hollow shows
  vec3 v = q - EAR_B;
  float cone = sdTaper(EAR_B + v + EAR_F * dot(v, EAR_F) * 0.6, EAR_B, EAR_T, 1.75, 0.16) / 1.6;
  float front = dot(v, EAR_F) - 0.05;
  float ear = smax(abs(cone + 0.14) - 0.14, front, 0.12);
  return vec2(ear, step(cone, -0.05) * step(front, 0.2));
}

float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
// Philtrum and mouth, as lines on the muzzle seen from the front: distance in x/y. mapCat keeps
// the last value in gLip; the march saves it at the hit, so coat() inks the lines without a
// second inlined copy (compile time).
float gLip = 1.0;
float mouthLine(vec3 p) {
  vec2 q = vec2(abs(p.x), p.y);
  return min(sdSeg(q, vec2(0.0, -1.95), vec2(0.0, -2.58)),
             min(sdSeg(q, vec2(0.0, -2.58), vec2(0.4, -2.83)), sdSeg(q, vec2(0.4, -2.83), vec2(0.78, -2.76))));
}

// .x distance, .y material (0 fur, 1 eye, 2 inside of the ear)
vec2 mapCat(vec3 p) {
  vec3 q = vec3(abs(p.x), p.yz);
  float d = 1e3;
  for (int i = uZero; i < 10; i++) {
    vec4 c = KC[i], r = KR[i];
    d = smin(d, sdEllipsoid((r.w > 0.5 ? q : p) - c.xyz, r.xyz), c.w);
  }
  vec2 ea = ears(q);
  d = smin(d, ea.x, 0.6);
  // eye sockets, slanted up at the outer corner
  vec3 s = q - vec3(1.8, 0.35, 2.95);
  s.xy = rot2(-0.22) * s.xy;
  d = smax(d, -sdEllipsoid(s, vec3(1.2, 0.86, 1.0)), 0.4);
  // nose leather, nostrils, philtrum and mouth
  vec3 n = p - vec3(0.0, -1.6, 4.05);
  n.x *= 1.0 + 1.1 * clamp(-n.y, 0.0, 1.0);
  d = smin(d, sdEllipsoid(n, vec3(0.62, 0.42, 0.45)), 0.35);
  d = smax(d, -(length(q - vec3(0.3, -1.72, 4.42)) - 0.12), 0.08);
  // philtrum and mouth: a crease cut straight back into the muzzle along the drawn lines (3D
  // capsules only met the curved muzzle in two places and read as two pits); coat() inks it
  gLip = mouthLine(p);
  d = smax(d, -max(gLip - 0.02, 3.4 - p.z), 0.03);
  // fur: soft clumps roughen the surface; the short fur of the muzzle lies flat, so the mouth
  // and philtrum grooves stay one clean line
  float sleek = fall(0.9, 1.5, length((p.xy - vec2(0.0, -2.3)) * vec2(0.8, 1.0))) * step(2.8, p.z);
  if (d < 0.5) d -= 0.08 * (vnoise3(p * 2.6) - 0.5) * (1.0 - 0.85 * sleek);
  float eye = length(q - EYE) - EYER;
  float m = ea.y * step(abs(ea.x - d), 0.3) * 2.0;
  return eye < d ? vec2(eye, 1.0) : vec2(d, m);
}

// Tabby-and-white coat: dark mackerel stripes on a brown-grey ground, white muzzle, chin and
// bib, a light rim round the eyes and dark eyeliner.
vec3 coat(vec3 p, float earIn, float lipD) {
  vec3 q = vec3(abs(p.x), p.yz);
  vec3 ground = vec3(0.07, 0.055, 0.04);   // a dark brown tabby: the coat must read as ink against the pale backdrop
  vec3 stripe = vec3(0.016, 0.013, 0.011);
  vec3 white = vec3(0.80, 0.76, 0.69);
  // fur: fine streaks that run away from the nose (one anisotropic noise)
  vec3 fl = normalize(p - vec3(0.0, -1.2, 5.0));
  vec3 ps = p * 13.0; ps -= fl * dot(ps, fl) * 0.85;
  float strands = vnoise3(ps);
  float warp = (strands - 0.5) * 0.35;
  float st = 0.0;
  // forehead: the tabby M of vertical bars
  st = max(st, smoothstep(1.2, 2.0, p.y) * fall(2.4, 3.2, q.x) * smoothstep(0.25, 0.75, sin(p.x * 3.4 + 0.5 * sin(p.y * 1.7) + warp)));
  // crown and back of the head: broad bars
  st = max(st, smoothstep(3.2, 4.2, p.y + 0.3 * q.x) * smoothstep(0.1, 0.7, sin(p.x * 2.2 + 1.0 + warp)));
  // cheeks: lines sweeping back from the outer eye corner
  st = max(st, smoothstep(2.3, 3.2, q.x) * fall(0.3, 1.2, p.y - 0.3) * smoothstep(0.35, 0.85, sin((p.y - 0.42 * q.x) * 4.2 + 0.8 + warp)));
  // mackerel bars down the shoulders
  st = max(st, fall(-5.2, -4.2, p.y) * smoothstep(1.2, 3.0, q.x + 0.35 * (p.y + 6.0)) * smoothstep(0.3, 0.8, sin(p.y * 2.1 + 0.6 * sin(p.x * 1.3) + warp * 2.0)));
  vec3 c = mix(ground, stripe, st * 0.92) * (0.72 + 0.56 * strands);
  // white: muzzle, chin, whisker pads, a blaze up the nose, a bib down the chest
  float muz = fall(0.9, 1.6, length((p.xy - vec2(0.0, -2.5)) * vec2(0.62, 1.0)));
  float blaze = fall(0.35, 0.75, abs(p.x) - 0.25 * (p.y + 1.0)) * fall(0.4, 1.6, p.y) * step(-2.0, p.y);
  // the bib stops mid-chest: run to the frame edge, it split the dark coat into two columns
  float bib = fall(-4.2, -3.2, p.y) * fall(0.8, 1.9, q.x - 0.06 * (p.y + 4.0) + warp * 2.0)
            * smoothstep(-10.2, -8.2, p.y + 0.25 * q.x * q.x + warp * 3.0);
  float w = clamp(max(max(muz, blaze * 0.9), bib) + warp * 0.6, 0.0, 1.0);
  c = mix(c, white * (0.72 + 0.4 * strands), w);
  // inside of the ears: pale pink skin behind light tufts
  c = mix(c, mix(vec3(0.34, 0.2, 0.18), white * 0.8, 0.3 * strands), earIn);
  // light rim above and below each eye, dark eyeliner right at the edge
  float ed = length(q - EYE) - EYER;
  c = mix(c, white * 0.7, fall(0.12, 0.42, ed) * 0.4);
  c = mix(c, stripe, fall(0.03, 0.13, ed));
  // dark lip skin along the mouth, fading up the philtrum
  float lip = fall(0.015, 0.08, lipD) * step(3.3, p.z) * mix(0.3, 0.9, smoothstep(-2.3, -2.6, p.y));
  c = mix(c, vec3(0.08, 0.055, 0.05), lip * (1.0 - 0.5 * smoothstep(0.35, 0.8, q.x)));
  return c;
}

vec3 irisColor(vec3 e) {
  // e: unit vector from the eye centre; the eye looks along +z
  vec2 t = e.xy;
  float r = length(t);
  float ang = atan(t.y, t.x);
  vec3 c = mix(vec3(0.6, 0.42, 0.08), vec3(0.3, 0.36, 0.09), smoothstep(0.15, 0.6, r));
  c *= 0.7 + 0.6 * vnoise2(vec2(ang * 16.0, r * 7.0));      // radial fibres
  c *= 0.5 + 0.5 * fall(0.1, 0.7, t.y);                     // the upper lid shades the iris
  c *= 1.0 - 0.8 * smoothstep(0.62, 0.76, r);             // dark limbal ring
  return mix(c, vec3(0.005), fall(0.9, 1.05, length(t / vec2(0.12, 0.46))));   // slit pupil
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 ro = vec3(0.0, CY, CAMD);
  vec3 rd = normalize(vec3(uv * HALF, 0.0) + vec3(0.0, CY, 0.0) - ro);
  mat3 M = rotY(-0.14 + uView.x) * rotX(0.06 + uView.y) * rotZ(0.08 + uView.z);
  mat3 Mt = transpose(M);
  vec3 kL = normalize(vec3(-0.6, 0.6, 0.6));
  vec3 rL = normalize(vec3(0.7, 0.45, -0.6));

  // clean, softly lit backdrop
  vec3 col = mix(vec3(0.60, 0.58, 0.54), vec3(0.78, 0.76, 0.72), smoothstep(-1.0, 1.0, uv.y - 0.4 * uv.x));
  col *= 1.0 - 0.12 * dot(uv, uv);

  vec3 lro = Mt * ro, lrd = Mt * rd;
  vec3 lk = Mt * kL, lr = Mt * rL;
  vec2 tb = boxHit(lro, lrd, vec3(0.0, -4.5, -1.0), vec3(9.5, 12.5, 7.5));
  if (tb.x < tb.y && tb.y > 0.0) {
    float t0 = max(tb.x, 0.0);
    vec3 o = lro + lrd * t0;
    float tmax = tb.y - t0;
    float hitLip = 1.0;
${MARCH('mapCat', { eps: '0.002', stepK: '0.7', maxSteps: 200, nEps: 0.01, aoStep: '0.3', aoBase: '0.06', aoFall: '0.75', shK: '7.0', shMin: '0.04', shMax: '1.2', shFar: '25.0', onHit: 'hitLip = gLip;' })}
    if (hit) {
      float ao = clamp(1.0 - 0.5 * occ, 0.0, 1.0);
      vec3 n = nrm;
      float sky = clamp(0.5 + 0.5 * n.y, 0.0, 1.0);
      if (mat > 0.5 && mat < 1.5) {
        // eye: iris under a glossy cornea, shaded by the upper lid
        vec3 q = vec3(abs(pos.x), pos.yz);
        vec3 alb = irisColor(normalize(q - EYE));
        float dif = clamp(dot(n, lk), 0.0, 1.0) * res;
        vec3 lin = vec3(1.0, 0.97, 0.9) * dif * 1.1 + vec3(0.7, 0.75, 0.8) * 0.45 * ao;
        col = alb * lin * 0.95 * mix(0.35, 1.0, ao);
        vec3 rf = reflect(lrd, n);
        float spec = pow(clamp(dot(rf, lk), 0.0, 1.0), 220.0) * 5.0 * res + pow(clamp(dot(rf, lk), 0.0, 1.0), 12.0) * 0.08;
        float fres = 0.04 + 0.5 * pow(1.0 - clamp(-dot(lrd, n), 0.0, 1.0), 5.0);
        col += vec3(spec) + fres * vec3(0.6, 0.62, 0.65) * ao;
      } else {
        vec3 alb = coat(pos, step(1.5, mat), hitLip);
        // nose leather: dusty pink
        vec3 nq = pos - vec3(0.0, -1.6, 4.05);
        nq.x *= 1.0 + 1.1 * clamp(-nq.y, 0.0, 1.0);
        alb = mix(alb, vec3(0.40, 0.19, 0.18), fall(0.35, 0.55, length(nq.xy / vec2(0.62, 0.5))) * step(3.9, pos.z));
        // fur: wrapped diffuse (light scatters through the coat) and a bright backlit rim
        float dif = clamp((dot(n, lk) + 0.35) / 1.35, 0.0, 1.0) * mix(0.25, 1.0, res);
        float rim = pow(clamp(1.0 + dot(n, lrd), 0.0, 1.0), 2.5) * clamp(dot(n, lr) + 0.5, 0.0, 1.0);
        vec3 lin = vec3(1.0, 0.96, 0.9) * dif * 1.8 + vec3(0.62, 0.68, 0.76) * sky * 0.45 * ao + vec3(0.4) * 0.12 * ao;
        col = alb * lin * mix(0.6, 1.0, ao) + vec3(0.9, 0.85, 0.75) * rim * 0.25 * (0.4 + alb.r * 2.0);
      }
    } else if (dmin < 0.35) {
      // a ray that grazed the coat: loose guard hairs catch the light, so the outline is soft —
      // a thin fringe round the ears, which are only a shell (a wide one read as smoke)
      vec3 dir = normalize(pmin - vec3(0.0, -1.0, 0.0));
      float hairs = vnoise2(vec2(atan(dir.y, dir.x) * 70.0, dmin * 6.0)) * 0.7 + 0.3;
      float band = mix(0.35, 0.08, smoothstep(3.0, 4.2, pmin.y));
      float a = fall(0.0, band, dmin) * hairs;
      col = mix(col, vec3(0.30, 0.26, 0.21), a * 0.85);
    }
  }
  col = acesFilm(col * 1.25);
  outColor = finish(col);
}
`;

// ------------------------------------------------------------------------------ landmark
const LANDMARK = HEAD + `
// A striped lighthouse on a rocky headland at sunset, painted in display space (tone is what the
// text art keeps) and linearised once at the end. Tonal plan for 28-40 columns: the tower is the
// one tall shape, banded light / dark so it reads as a lighthouse even as dots; the sky darkens
// upward behind the lantern, the headland is the dark mass it stands on, and the sun and its
// glitter path are the brightest shapes, kept well right of the tower so they never merge.
const float HZ = 0.37;                     // horizon
const vec2 SUN = vec2(0.765, 0.455);
const float SUNR = 0.068;
const float TX = 0.40;                     // tower axis
const float TB = 0.40, TT = 0.765;         // tower base, top of the shaft
const vec2 LAMP = vec2(0.40, 0.81);

float cov(float d, float px) { return clamp(0.5 - d / px, 0.0, 1.0); }
float sdBox2(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

// Upper edge of the headland: a gentle rise from the left, the plateau under the tower, then a
// ragged cliff down into the sea on the right.
float landTop(float x) {
  float plateau = 0.405 + 0.014 * (fbm2(vec2(x * 7.0, 1.3)) - 0.5);
  float h = mix(0.335, plateau, smoothstep(-0.1, 0.22, x));
  float jag = 0.05 * (fbm2(vec2(x * 11.0, 4.0)) - 0.5);
  float cliff = smoothstep(0.53, 0.74, x + jag);
  return mix(h, -0.15, cliff) + 0.02 * (fbm2(vec2(x * 30.0, 9.0)) - 0.5) * cliff;
}

vec3 skyCol(vec2 uv, float px) {
  float y = uv.y - HZ;
  // light overall (a dark sky filled half the frame with dots): pale gold at the horizon to a
  // mid violet overhead, so the red bands and the iron top read dark and the white bands light
  vec3 c = mix(vec3(1.0, 0.87, 0.68), vec3(0.97, 0.75, 0.62), smoothstep(0.0, 0.18, y));
  c = mix(c, vec3(0.86, 0.68, 0.7), smoothstep(0.12, 0.38, y));
  c = mix(c, vec3(0.76, 0.7, 0.82), smoothstep(0.3, 0.62, y));
  float ds = length(uv - SUN);
  c = mix(c, vec3(1.0, 0.82, 0.58), exp(-max(ds - SUNR, 0.0) * 16.0) * 0.55);
  // long thin clouds, dark violet, their undersides lit near the sun
  float cl = fbm2(vec2(uv.x * 1.8 + 3.0, uv.y * 18.0));
  float band = smoothstep(0.08, 0.14, y) * fall(0.3, 0.4, y);
  float cloud = smoothstep(0.55, 0.7, cl) * band;
  vec3 cc = mix(vec3(0.66, 0.5, 0.6), vec3(1.0, 0.7, 0.5), exp(-abs(uv.x - SUN.x) * 5.0) * 0.8);
  c = mix(c, cc, cloud * 0.5);
  // the sun: a pale disc, its lower edge on the horizon
  vec3 sunCol = vec3(1.0, 0.97, 0.85);
  c = mix(c, sunCol, fall(SUNR - px, SUNR + px, ds));
  // the lamp is lit: a soft halo round the lantern and a faint beam sweeping left
  vec2 dl = uv - LAMP;
  c += vec3(1.0, 0.85, 0.55) * exp(-length(dl) * 22.0) * 0.35;
  float beam = exp(-abs(dl.y + 0.12 * dl.x) / (0.004 + 0.07 * max(-dl.x, 0.0))) * step(dl.x, 0.0) * exp(dl.x * 2.5);
  c += vec3(1.0, 0.88, 0.6) * beam * 0.22;
  return c;
}

vec3 seaCol(vec2 uv) {
  float d = max(HZ - uv.y, 0.0);                  // below the horizon
  float Z = 1.0 / (d + 0.004);                    // distance on the water plane
  vec2 w = vec2((uv.x - 0.5) * Z * 0.9, Z * 0.35);
  float waves = fbm2(w * vec2(1.0, 3.0) + vec2(0.0, 2.0));
  // the sea mirrors the bright sky: mid tones, so the dark headland stands clear of it
  vec3 c = mix(vec3(0.88, 0.72, 0.64), vec3(0.64, 0.55, 0.62), smoothstep(0.0, 0.12, d));
  c = mix(c, vec3(0.44, 0.41, 0.52), smoothstep(0.12, 0.37, d));
  c *= 0.85 + 0.3 * waves;
  // glitter path under the sun, widening toward the viewer
  float path = exp(-pow((uv.x - SUN.x) / (0.03 + 0.55 * d), 2.0));
  float glint = smoothstep(0.52, 0.8, waves) * path;
  c = mix(c, vec3(1.0, 0.86, 0.62), clamp(glint * 1.6 + path * 0.25 * fall(0.0, 0.05, d), 0.0, 1.0));
  return c;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;       // 0..1, y up
  float px = 1.0 / uRes.y;
  vec3 col = uv.y > HZ ? skyCol(uv, px) : seaCol(uv);
  // soften the horizon line by a pixel
  col = mix(col, mix(skyCol(uv, px), seaCol(uv), 0.5), fall(0.0, px, abs(uv.y - HZ)) * 0.5);

  // keeper's cottage behind the tower: pale walls in shade, a dark slate roof, one lit window
  vec2 hc = uv - vec2(0.305, 0.43);
  float wall = sdBox2(hc, vec2(0.06, 0.028));
  float roof = max(max(hc.y - 0.028 - 0.042 + abs(hc.x) * 0.62, 0.028 - hc.y), abs(hc.x) - 0.066);
  float chim = sdBox2(hc - vec2(-0.03, 0.07), vec2(0.007, 0.014));
  col = mix(col, vec3(0.56, 0.5, 0.52) * (0.9 + 0.1 * fbm2(uv * 200.0)), cov(wall, px));
  col = mix(col, vec3(1.0, 0.78, 0.4), cov(sdBox2(hc - vec2(-0.03, -0.004), vec2(0.008, 0.01)), px));
  col = mix(col, vec3(0.11, 0.1, 0.12), cov(min(roof, chim), px));

  // the tower: a tapered cylinder in red and white bands
  float x = uv.x - TX, y = uv.y;
  float t = clamp((y - TB) / (TT - TB), 0.0, 1.0);
  float hw = mix(0.07, 0.05, t);
  float shaft = max(abs(x) - hw, max(TB - 0.03 - y, y - TT));
  float nx = clamp(x / hw, -1.0, 1.0);
  vec3 n = vec3(nx, 0.0, sqrt(1.0 - nx * nx));
  // backlit by the low sun: the face toward us is in sky light (so the whole tower is a dark
  // column against the bright sky, its bands still two clear tones) with a warm rim on the right
  vec3 L = normalize(vec3(0.95, 0.1, -0.3));
  float dif = pow(max(dot(n, L), 0.0), 1.5);
  float band = floor((y - TB) / ((TT - TB) / 5.0));
  float red = 1.0 - mod(band, 2.0);   // red at the foot, where the sky behind is palest
  vec3 paint = mix(vec3(0.96, 0.93, 0.87), vec3(0.6, 0.1, 0.08), red);
  paint *= 0.95 + 0.08 * (vnoise2(uv * vec2(300.0, 60.0)) - 0.5);
  vec3 tc = paint * (vec3(0.52, 0.47, 0.56) * (0.62 + 0.18 * n.z) + vec3(1.0, 0.78, 0.55) * dif * 1.1);
  // windows up the shaft and a door at the foot
  float win = sdBox2(vec2(x + 0.012, fract((y - TB) / 0.146 + 0.3) * 0.146 - 0.073), vec2(0.0055, 0.011));
  win = max(win, TB + 0.08 - y);
  float door = sdBox2(vec2(x + 0.01, y - TB - 0.005), vec2(0.013, 0.03));
  tc = mix(tc, vec3(0.05, 0.04, 0.05), cov(min(win, door), px));
  col = mix(col, tc, cov(shaft, px));

  // gallery (a black iron balcony), the railing, the glowing lantern room, the dome, the vane
  vec2 g = vec2(x, y);
  float gallery = sdBox2(g - vec2(0.0, 0.771), vec2(0.074, 0.008));
  float rail = min(sdBox2(g - vec2(0.0, 0.805), vec2(0.067, 0.0024)),
                   max(abs(fract(x / 0.0145) - 0.5) * 0.0145 - 0.0014, max(abs(x) - 0.067, abs(y - 0.792) - 0.014)));
  float lantern = sdBox2(g - vec2(0.0, 0.808), vec2(0.04, 0.03));
  float mull = max(abs(fract(x / 0.0175 + 0.5) - 0.5) * 0.0175 - 0.0016, lantern);
  float dome = max(length((g - vec2(0.0, 0.838)) / vec2(0.047, 0.038)) - 1.0, 0.838 - y);
  float vane = min(length(g - vec2(0.0, 0.88)) - 0.007, sdBox2(g - vec2(0.0, 0.891), vec2(0.0014, 0.016)));
  vec3 glass = mix(vec3(1.0, 0.93, 0.7), vec3(1.0, 0.74, 0.38), smoothstep(0.0, 0.04, abs(x)));
  col = mix(col, glass, cov(lantern, px));
  col = mix(col, vec3(0.08, 0.06, 0.06), cov(mull, px));
  vec3 iron = vec3(0.06, 0.05, 0.05) + vec3(0.35, 0.22, 0.14) * clamp(x / 0.06, 0.0, 1.0);
  col = mix(col, iron, cov(min(min(gallery, rail), vane), px));
  float dn = clamp(x / 0.047, -1.0, 1.0);
  vec3 domeC = vec3(0.32, 0.07, 0.06) * (0.35 + 0.9 * max(dn, 0.0) + 0.25 * sqrt(1.0 - dn * dn));
  col = mix(col, domeC, cov(dome * 0.04, px));

  // headland, drawn last so its edge hides the foot of the tower and the cottage: dark rock with
  // strata, turf on top, foam where the cliff meets the sea
  float top = landTop(uv.x);
  float land = fall(top - px, top + px, uv.y);
  if (land > 0.0) {
    float strata = fbm2(vec2(uv.x * 9.0, uv.y * 55.0 + 3.0 * fbm2(uv * 6.0)));
    vec3 rock = vec3(0.12, 0.095, 0.09) * (0.7 + 0.6 * strata);
    float below = top - uv.y;
    float turf = fall(0.004, 0.02 + 0.01 * strata, below) * fall(0.62, 0.7, uv.x);
    rock = mix(rock, vec3(0.16, 0.17, 0.09) * (0.8 + 0.4 * strata), turf);
    // the sun catches the seaward lip of the cliff: a thin rim, broken by the strata
    float lip = smoothstep(0.0, 0.012, uv.y - landTop(uv.x + 0.012)) * smoothstep(0.5, 0.56, uv.x);
    rock = mix(rock, vec3(0.62, 0.36, 0.22) * (0.5 + 0.8 * strata), lip * smoothstep(0.35, 0.6, strata));
    rock *= 0.75 + 0.25 * smoothstep(-0.2, 0.3, uv.y);
    col = mix(col, rock, land);
  }
  float foam = fall(0.0, 0.012, uv.y - top) * step(0.0, uv.y - top) * smoothstep(0.62, 0.7, uv.x) * fall(0.18, 0.28, uv.y);
  col = mix(col, vec3(0.92, 0.88, 0.82), foam * smoothstep(0.35, 0.65, fbm2(uv * vec2(120.0, 60.0))));


  col *= 1.0 - 0.16 * pow(length(uv - vec2(0.5, 0.55)) * 1.25, 2.0);
  outColor = finish(pow(clamp(col, 0.0, 1.0), vec3(2.2)));
}
`;

// ---------------------------------------------------------------------------------- logo
const LOGO = HEAD + `
// A roundel emblem in pure black and white: two peaks with a zig-zag snow line under a sun, two
// waves below, inside a double ring. Analytic shapes with one pixel of anti-aliasing and nothing
// else (no grain): the high-contrast sample, the one threshold and blocks modes do best with.
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
// zig-zag: a triangle wave of the given period and amplitude
float zig(float x, float period, float amp) { return amp * (abs(fract(x / period) * 2.0 - 1.0) * 2.0 - 1.0); }

void main() {
  vec2 p = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  float px = 2.0 / uRes.x;
  float r = length(p);
  const float RIN = 0.70;
  // white motifs inside the black disc
  float big = sdTri(p, vec2(-0.66, -0.2), vec2(0.36, -0.2), vec2(-0.15, 0.47));
  float small = sdTri(p, vec2(-0.02, -0.2), vec2(0.68, -0.2), vec2(0.33, 0.17));
  // a black gap keeps the two peaks apart where they overlap
  float edge = dot(p - vec2(0.36, -0.2), normalize(vec2(0.67, 0.51)));   // right of the big peak's flank
  float smallCut = max(small, 0.045 - edge);
  float peaks = min(big, smallCut);
  // snow lines: a black zig-zag band across each peak, the white cap above it
  float snowB = abs(p.y - 0.2 - zig(p.x + 0.02, 0.13, 0.035)) - 0.028;
  float snowS = abs(p.y - 0.01 - zig(p.x - 0.03, 0.11, 0.028)) - 0.024;
  float snow = min(max(snowB, big), max(snowS, smallCut));
  peaks = max(peaks, -snow);
  float sun = length(p - vec2(0.33, 0.43)) - 0.13;
  float wave1 = abs(p.y + 0.34 - 0.035 * sin(p.x * 13.0)) - 0.034;
  float wave2 = abs(p.y + 0.49 - 0.035 * sin(p.x * 13.0 + 1.6)) - 0.034;
  float white = min(min(peaks, sun), min(wave1, wave2));
  // black = the inner disc minus the motifs, plus the outer band
  float disc = max(r - RIN, -white);
  float band = abs(r - 0.845) - 0.075;
  float ink = clamp(0.5 - min(disc, band) / px, 0.0, 1.0);
  outColor = vec4(vec3(1.0 - ink), 1.0);
}
`;

const SHADERS = { portrait: BUST, pet: CAT, landmark: LANDMARK, logo: LOGO };
// Supersampling before the browser's downsample: 2x cleans the raymarched edges and the fine
// strands; the flat 2D subjects get 2x too (cheap).
const SUPERSAMPLE = { portrait: 2, pet: 2, landmark: 2, logo: 2 };

// ------------------------------------------------------------------------------ GL runtime
// Main thread only (dev page): one WebGL2 context, programs compiled once and kept.
let st = null;
export const timings = {};   // id -> { compileMs, drawMs, N }

function context() {
  if (st && !st.gl.isContextLost()) return st;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('The sample generator needs WebGL2.');
  st = { canvas, gl, vao: gl.createVertexArray(), programs: new Map(),
    parallel: gl.getExtension('KHR_parallel_shader_compile'),
    maxN: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], 4096) };
  return st;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function program(s, id) {
  if (s.programs.has(id)) return s.programs.get(id);
  const { gl } = s;
  const t0 = performance.now();
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
  const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, SHADERS[id]);
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (s.parallel) while (!gl.getProgramParameter(p, s.parallel.COMPLETION_STATUS_KHR)) await sleep(2);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Sample shader '${id}' failed: ${gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(p)}`);
  }
  const prog = { p, uRes: gl.getUniformLocation(p, 'uRes'), uZero: gl.getUniformLocation(p, 'uZero'),
    uView: gl.getUniformLocation(p, 'uView'), compileMs: performance.now() - t0 };
  s.programs.set(id, prog);
  return prog;
}

// Draw at N x N in horizontal strips flushed one by one (no single giant draw for the driver's
// watchdog), then read one pixel back so the timing includes the GPU work.
function draw(s, prog, N, view, id) {
  const { gl, canvas } = s;
  if (canvas.width !== N || canvas.height !== N) { canvas.width = N; canvas.height = N; }
  gl.viewport(0, 0, N, N);
  gl.useProgram(prog.p);
  gl.bindVertexArray(s.vao);
  gl.uniform2f(prog.uRes, N, N);
  gl.uniform1i(prog.uZero, 0);
  gl.uniform4f(prog.uView, view[0] || 0, view[1] || 0, view[2] || 0, view[3] || 0);
  gl.enable(gl.SCISSOR_TEST);
  for (let y = 0; y < N; y += 256) {
    gl.scissor(0, y, N, Math.min(256, N - y));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
  }
  gl.disable(gl.SCISSOR_TEST);
  const px = new Uint8Array(4);
  gl.readPixels(N >> 1, N >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (gl.isContextLost() || px[3] !== 255) throw new Error(`The GPU context was lost while drawing '${id}'.`);
}

export const IDS = Object.keys(SHADERS);

/** Render sample `id` into a new size x size 2D canvas (supersampled, then downsampled). */
export async function renderSample(id, size = 1024, { view = [], ss } = {}) {
  if (!SHADERS[id]) throw new Error(`Unknown sample '${id}'`);
  const s = context();
  const prog = await program(s, id);
  const N = Math.min(s.maxN, Math.round(size * (ss || SUPERSAMPLE[id])));
  const t0 = performance.now();
  draw(s, prog, N, view, id);
  const drawMs = performance.now() - t0;
  const out = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s.canvas, 0, 0, N, N, 0, 0, size, size);
  if (id === 'pet') catWhiskers(ctx, size, view);
  timings[id] = { compileMs: Math.round(prog.compileMs), drawMs: Math.round(drawMs), N };
  return out;
}

// ------------------------------------------------------------------------------ 2D overlays
// Cat whiskers: 3D curves from the whisker pads, projected with the shader's camera.
function catWhiskers(ctx, size, view = []) {
  const HALF = 10.8, CAMD = 95, CY = -1.7;
  const yaw = -0.14 + (view[0] || 0), pitch = 0.06 + (view[1] || 0), roll = 0.08 + (view[2] || 0);
  const rot = ([x, y, z]) => {
    // M = rotY(yaw) * rotX(pitch) * rotZ(roll), applied right to left
    let c = Math.cos(roll), s = Math.sin(roll);
    [x, y] = [c * x - s * y, s * x + c * y];
    c = Math.cos(pitch); s = Math.sin(pitch);
    [y, z] = [c * y - s * z, s * y + c * z];
    c = Math.cos(yaw); s = Math.sin(yaw);
    [x, z] = [c * x + s * z, -s * x + c * z];
    return [x, y, z];
  };
  const project = p => {
    const [x, y, z] = rot(p);
    const k = CAMD / (CAMD - z) / HALF;
    return [(x * k + 1) * 0.5 * size, (1 - (y - CY) * k) * 0.5 * size];
  };
  const px = size / 1024;
  ctx.lineCap = 'round';
  const draw = (root, ctrl, tip, width, alpha) => {
    const a = project(root), b = project(ctrl), c = project(tip);
    // taper: three passes, each shorter and thicker toward the root
    for (const [f, w] of [[1, 0.55], [0.7, 0.8], [0.4, 1.0]]) {
      const bx = a[0] + (b[0] - a[0]) * f, by = a[1] + (b[1] - a[1]) * f;
      const cx = a[0] + 2 * (b[0] - a[0]) * f + (c[0] - 2 * b[0] + a[0]) * f * f;
      const cy = a[1] + 2 * (b[1] - a[1]) * f + (c[1] - 2 * b[1] + a[1]) * f * f;
      ctx.strokeStyle = `rgba(246, 242, 232, ${alpha})`;
      ctx.lineWidth = width * w * px;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(bx, by, cx, cy); ctx.stroke();
    }
  };
  for (const side of [-1, 1]) {
    // muzzle whiskers: rows fanning out, drooping with length
    for (let i = 0; i < 6; i++) {
      const row = i / 5;
      const root = [side * (0.85 + 0.35 * row), -2.05 - 0.55 * row, 3.95 - 0.35 * row];
      const spread = -0.25 + 0.5 * row;               // upper rows rise, lower rows fall
      const len = 5.4 + 1.2 * Math.sin(i * 1.7);
      const tip = [side * (root[0] * side + len * 0.95), root[1] - spread * len * 0.6 - 0.9, root[2] + 0.8];
      const ctrl = [side * (root[0] * side + len * 0.5), root[1] - spread * len * 0.2 + 0.35, root[2] + 1.0];
      draw(root, ctrl, tip, 1.8, 0.85 - 0.15 * row);
    }
    // brow whiskers
    for (let i = 0; i < 3; i++) {
      const root = [side * (1.3 + 0.35 * i), 1.75 + 0.1 * i, 2.9 - 0.2 * i];
      const tip = [side * (2.6 + 0.9 * i), 4.2 + 0.3 * i, 3.2];
      const ctrl = [side * (1.8 + 0.6 * i), 3.4 + 0.2 * i, 3.4];
      draw(root, ctrl, tip, 1.6, 0.7);
    }
  }
}
