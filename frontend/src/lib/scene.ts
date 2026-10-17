import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as G from './glsl';
import type { AppSpec, Status } from './apps';

export interface SceneEvents {
  onHover(id: string | null): void;
  onSelect(id: string | null): void;
  /** Called every frame per planet with its screen position, for the DOM labels. */
  onLabel(id: string, x: number, y: number, visible: boolean): void;
}

export interface OrreryScene {
  setStatus(status: Record<string, Status>, piReachable: boolean | null): void;
  /** Per app: CPU % (spins the planet) and whether anything needs looking at (amber flare). */
  setVitals(vitals: Record<string, { cpu: number; warn: boolean }>): void;
  highlight(id: string | null): void;
  pulse(): void;
  launch(id: string): Promise<void>;
  ping(id: string): void;
  reset(): void;
  dispose(): void;
}

const STYLES: Record<string, number> = { lava: 0, strings: 1, ice: 2, honeycomb: 3, moon: 4, values: 5, waves: 6 };
const STATUS_VALUE: Record<Status, number> = { up: 1, down: 0, unknown: 0.5 };
const DOWN = new THREE.Color('#ff2a2a');
const UNKNOWN = new THREE.Color('#6f6a86');
const WARN = new THREE.Color('#ffb020');

// Pi apps orbit close in; the belt marks the edge of the house; apps hosted elsewhere
// swing round outside it on tilted orbits of their own.
const INNER = [3.3, 4.5, 5.7, 6.9, 7.9];
const OUTER = [10.8, 12.4, 13.8];
const TRAIL_POINTS = 90;

interface Planet {
  spec: AppSpec;
  pivot: THREE.Object3D;
  body: THREE.Mesh;
  bodyHolder: THREE.Object3D;
  atmo: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  atmoUniforms: Record<string, THREE.IUniform>;
  orbitMaterial: THREE.LineBasicMaterial;
  trail: { geometry: THREE.BufferGeometry; positions: Float32Array; uniforms: Record<string, THREE.IUniform> };
  extras: THREE.Object3D[];
  radius: number;
  speed: number;
  angle: number;
  hover: number;
  flash: number;
  status: Status;
  intro: number;
  cpu: number;
  warn: boolean;
}

interface Packet {
  sprite: THREE.Sprite;
  target: Planet | null;
  t: number;
}

const easeInCubic = (t: number) => t * t * t;
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createScene(canvas: HTMLCanvasElement, specs: AppSpec[], events: SceneEvents): OrreryScene {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  // Phones get fewer pixels: the bloom and lens passes cost per pixel.
  const pixelRatio = Math.min(window.devicePixelRatio, coarse ? 1.25 : 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  const glow = glowTexture();

  // The rig holds the camera so dragging can tilt the view without fighting lookAt.
  const rig = new THREE.Object3D();
  scene.add(rig);
  rig.add(camera);
  const system = new THREE.Group();
  scene.add(system);

  // ---- sky
  const nebulaUniforms = { uTime: { value: 0 } };
  const nebula = new THREE.Mesh(
    new THREE.SphereGeometry(900, 48, 32),
    new THREE.ShaderMaterial({
      vertexShader: G.nebulaVertex,
      fragmentShader: G.nebulaFragment,
      uniforms: nebulaUniforms,
      side: THREE.BackSide,
      depthWrite: false
    })
  );
  scene.add(nebula);

  const starCount = coarse ? 3500 : 7000;
  const starGeo = new THREE.BufferGeometry();
  const sPos = new Float32Array(starCount * 3);
  const sSize = new Float32Array(starCount);
  const sPhase = new Float32Array(starCount);
  const sColor = new Float32Array(starCount * 3);
  const tints = [new THREE.Color('#ffffff'), new THREE.Color('#ffd6e7'), new THREE.Color('#c7e3ff'), new THREE.Color('#fff1c7')];
  for (let i = 0; i < starCount; i++) {
    const r = 120 + Math.random() * 500;
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    sPos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
    sSize[i] = Math.pow(Math.random(), 4) * 9 + 1.2;
    sPhase[i] = Math.random() * 100;
    const t = tints[Math.floor(Math.random() * tints.length)];
    sColor.set([t.r, t.g, t.b], i * 3);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(sPhase, 1));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(sColor, 3));
  const starUniforms = { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio } };
  const stars = new THREE.Points(
    starGeo,
    new THREE.ShaderMaterial({
      vertexShader: G.starVertex,
      fragmentShader: G.starFragment,
      uniforms: starUniforms,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    })
  );
  scene.add(stars);

  // ---- warp streaks, fixed to the camera, invisible until a launch
  const streakCount = 900;
  const streakPos = new Float32Array(streakCount * 6);
  const streakEnd = new Float32Array(streakCount * 2);
  for (let i = 0; i < streakCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.5 + Math.random() * 14;
    const z = -10 - Math.random() * 140;
    streakPos.set([Math.cos(a) * r, Math.sin(a) * r, z, Math.cos(a) * r, Math.sin(a) * r, z], i * 6);
    streakEnd[i * 2] = 0;
    streakEnd[i * 2 + 1] = 1;
  }
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute('position', new THREE.BufferAttribute(streakPos, 3));
  streakGeo.setAttribute('aEnd', new THREE.BufferAttribute(streakEnd, 1));
  const streakUniforms = { uWarp: { value: 0 }, uColor: { value: new THREE.Color('#ffffff') } };
  const streaks = new THREE.LineSegments(
    streakGeo,
    new THREE.ShaderMaterial({
      vertexShader: G.streakVertex,
      fragmentShader: G.streakFragment,
      uniforms: streakUniforms,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    })
  );
  streaks.frustumCulled = false;
  camera.add(streaks);

  // ---- the core: the Pi itself
  const coreUniforms = { uTime: { value: 0 }, uBeat: { value: 0 }, uAlive: { value: 1 } };
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.ShaderMaterial({ vertexShader: G.planetVertex, fragmentShader: G.coreFragment, uniforms: coreUniforms })
  );
  system.add(core);

  const shellMat = new THREE.LineBasicMaterial({ color: '#ff3d7f', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending });
  const shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.5, 1)), shellMat);
  system.add(shell);
  const shell2Mat = new THREE.LineBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending });
  const shell2 = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(2.1, 0)), shell2Mat);
  system.add(shell2);
  const coronaMat = new THREE.SpriteMaterial({ map: glow, color: '#ff2a6d', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 });
  const corona = new THREE.Sprite(coronaMat);
  corona.scale.setScalar(7);
  system.add(corona);

  const light = new THREE.PointLight('#ff6fa3', 60, 0, 1.6);
  system.add(light);
  scene.add(new THREE.AmbientLight('#3a2a5a', 0.6));

  // ---- the belt: the edge of the house
  const beltCount = coarse ? 700 : 1600;
  const belt = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.045, 0),
    new THREE.MeshStandardMaterial({ color: '#b9b0cc', roughness: 0.85, metalness: 0.1, flatShading: true }),
    beltCount
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < beltCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 8.7 + Math.random() * 1.0 + (Math.random() - 0.5) * 0.4;
    const pos = new THREE.Vector3(Math.cos(a) * r, (Math.random() - 0.5) * 0.35, Math.sin(a) * r);
    q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    const s = 0.4 + Math.pow(Math.random(), 3) * 2.2;
    m.compose(pos, q, new THREE.Vector3(s, s * (0.6 + Math.random() * 0.8), s));
    belt.setMatrixAt(i, m);
  }
  system.add(belt);

  // ---- planets
  const planets = new Map<string, Planet>();
  const hitTargets: THREE.Object3D[] = [];
  let inner = 0;
  let outer = 0;
  specs.forEach((spec, index) => {
    const away = spec.host !== 'pi';
    const orbitR = away ? OUTER[outer++ % OUTER.length] : INNER[inner++ % INNER.length];
    const radius = spec.style === 'moon' ? 0.3 : spec.style === 'strings' ? 0.62 : 0.5 + ((index * 37) % 10) / 100;
    const color = new THREE.Color(spec.color);

    const plane = new THREE.Object3D();
    plane.rotation.x = away ? (outer % 2 ? 0.42 : -0.3) : (Math.sin(index * 2.1) * 0.07);
    plane.rotation.z = away ? (outer % 2 ? -0.18 : 0.25) : (Math.cos(index * 1.7) * 0.05);
    system.add(plane);

    const pivot = new THREE.Object3D();
    plane.add(pivot);

    const orbitPts = new THREE.EllipseCurve(0, 0, orbitR, orbitR).getPoints(180).map((p) => new THREE.Vector3(p.x, 0, p.y));
    const orbitMaterial = new THREE.LineBasicMaterial({
      color: away ? '#a8a3ff' : '#ffffff',
      transparent: true,
      opacity: away ? 0.1 : 0.07,
      blending: THREE.AdditiveBlending
    });
    const orbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(orbitPts), orbitMaterial);
    plane.add(orbit);

    const bodyHolder = new THREE.Object3D();
    bodyHolder.position.x = orbitR;
    pivot.add(bodyHolder);

    const uniforms = {
      uColor: { value: color },
      uTime: { value: 0 },
      uStatus: { value: 0.5 },
      uHover: { value: 0 },
      uFlash: { value: 0 },
      uSeed: { value: index * 3.17 },
      uStyle: { value: STYLES[spec.style] ?? 4 }
    };
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 96, 64),
      new THREE.ShaderMaterial({ vertexShader: G.planetVertex, fragmentShader: G.planetFragment, uniforms })
    );
    body.rotation.z = 0.3;
    bodyHolder.add(body);

    const atmoUniforms = { uColor: { value: color.clone() }, uIntensity: { value: 0.75 } };
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.28, 48, 32),
      new THREE.ShaderMaterial({
        vertexShader: G.atmosphereVertex,
        fragmentShader: G.atmosphereFragment,
        uniforms: atmoUniforms,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false
      })
    );
    bodyHolder.add(atmo);

    // Bigger than the planet so a thumb can find it.
    const hit = new THREE.Mesh(new THREE.SphereGeometry(Math.max(radius * 2, 0.95), 12, 8), new THREE.MeshBasicMaterial());
    hit.visible = false;
    hit.userData.id = spec.id;
    bodyHolder.add(hit);
    hitTargets.push(hit);

    const extras: THREE.Object3D[] = [];
    if (spec.style === 'strings') {
      // Six rings, one per string. They shiver when you hover.
      const ringGroup = new THREE.Group();
      ringGroup.rotation.set(1.2, 0.2, 0.3);
      for (let s = 0; s < 6; s++) {
        const inner = radius * 1.55 + s * 0.085;
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(inner, inner + 0.012 + s * 0.003, 160),
          new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        ringGroup.add(ring);
      }
      bodyHolder.add(ringGroup);
      extras.push(ringGroup);
    }
    if (spec.style === 'moon') {
      // A tiny satellite with solar panels, orbiting the moon.
      const sat = new THREE.Group();
      const boxMat = new THREE.MeshStandardMaterial({ color: '#d1fae5', emissive: color, emissiveIntensity: 0.6 });
      sat.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), boxMat));
      const panelMat = new THREE.MeshStandardMaterial({ color: '#1e3a8a', emissive: '#2563eb', emissiveIntensity: 0.8, side: THREE.DoubleSide });
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.06), panelMat);
      sat.add(panel);
      const satPivot = new THREE.Object3D();
      sat.position.x = radius * 2.1;
      satPivot.add(sat);
      satPivot.rotation.x = 0.6;
      bodyHolder.add(satPivot);
      extras.push(satPivot);
    }
    if (spec.style === 'ice') {
      const shard = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(radius * 1.45, 0)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending })
      );
      bodyHolder.add(shard);
      extras.push(shard);
    }

    const trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailAlpha = new Float32Array(TRAIL_POINTS);
    for (let i = 0; i < TRAIL_POINTS; i++) trailAlpha[i] = 1 - i / (TRAIL_POINTS - 1);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    trailGeo.setAttribute('aAlpha', new THREE.BufferAttribute(trailAlpha, 1));
    const trailUniforms = { uColor: { value: color }, uOpacity: { value: 0 } };
    const trail = new THREE.Line(
      trailGeo,
      new THREE.ShaderMaterial({
        vertexShader: G.trailVertex,
        fragmentShader: G.trailFragment,
        uniforms: trailUniforms,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false
      })
    );
    trail.frustumCulled = false;
    system.add(trail);

    planets.set(spec.id, {
      spec,
      pivot,
      body,
      bodyHolder,
      atmo,
      uniforms,
      atmoUniforms,
      orbitMaterial,
      trail: { geometry: trailGeo, positions: trailPositions, uniforms: trailUniforms },
      extras,
      radius,
      // Kepler-ish: further out, slower.
      speed: 0.9 / Math.pow(orbitR, 1.5),
      angle: index * 2.399 + Math.random() * 0.3,
      hover: 0,
      flash: 0,
      status: 'unknown',
      intro: 0,
      cpu: 0,
      warn: false
    });
  });

  // ---- packets: each status check fires one from the core to every planet
  const packets: Packet[] = [];
  for (let i = 0; i < 24; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, color: '#ffffff', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
    );
    sprite.scale.setScalar(0.45);
    sprite.visible = false;
    system.add(sprite);
    packets.push({ sprite, target: null, t: 0 });
  }

  // ---- post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.55, 0.32);
  composer.addPass(bloom);
  const lens = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uWarp: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) }
    },
    vertexShader: G.lensVertex,
    fragmentShader: G.lensFragment
  });
  composer.addPass(lens);
  composer.addPass(new OutputPass());

  // ---- camera state
  const view = {
    yaw: 0,
    yawVelocity: 0,
    tilt: 0.38,
    targetTilt: 0.38,
    distance: 20,
    targetDistance: 20,
    fov: 45
  };
  let intro = reducedMotion ? 1 : 0;
  let hovered: string | null = null;
  let highlighted: string | null = null;
  let timeScale = 1;
  let piAlive: boolean | null = null;
  let launchState: { planet: Planet; t: number; from: THREE.Vector3; resolve: () => void } | null = null;
  const mouse = new THREE.Vector2(0, 0);
  const parallax = new THREE.Vector2(0, 0);

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    // Portrait: the app list covers the bottom half, so frame the system in the top half
    // by moving the projection centre down, and widen the lens to fit the inner orbits.
    const portrait = camera.aspect < 0.8;
    view.fov = portrait ? 58 : 45;
    camera.fov = view.fov;
    if (portrait) camera.setViewOffset(w, h, 0, h * 0.24, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    lens.uniforms.uResolution.value.set(w * pixelRatio, h * pixelRatio);
    // Portrait screens need to stand further back to see the outer orbits.
    view.targetDistance = camera.aspect < 0.8 ? 23 : camera.aspect < 1.2 ? 27 : 21;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  view.distance = reducedMotion ? view.targetDistance : 110;

  // ---- input
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let drag: { x: number; y: number; moved: number; lastX: number; lastY: number } | null = null;

  function pick(clientX: number, clientY: number): string | null {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(hitTargets, false)[0];
    return hit ? (hit.object.userData.id as string) : null;
  }

  function setHovered(id: string | null) {
    if (id === hovered) return;
    hovered = id;
    events.onHover(id);
  }

  const onPointerDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0, lastX: e.clientX, lastY: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    mouse.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    if (drag) {
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      view.yawVelocity = dx * 0.004;
      view.yaw += dx * 0.004;
      view.targetTilt = THREE.MathUtils.clamp(view.targetTilt + dy * 0.003, -0.1, 1.2);
    }
    if (e.pointerType === 'mouse' && !launchState) {
      const id = pick(e.clientX, e.clientY);
      setHovered(id);
      canvas.style.cursor = id ? 'pointer' : drag ? 'grabbing' : 'grab';
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (drag && drag.moved < 8 && !launchState) {
      const id = pick(e.clientX, e.clientY);
      events.onSelect(id);
    }
    drag = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const base = camera.aspect < 0.8 ? 23 : camera.aspect < 1.2 ? 27 : 21;
    view.targetDistance = THREE.MathUtils.clamp(view.targetDistance * (1 + e.deltaY * 0.001), base * 0.55, base * 1.6);
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ---- loop
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const look = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const lookGoal = new THREE.Vector3();
  let focusAmount = 0;
  let elapsed = 0;
  let raf = 0;

  function planetWorld(p: Planet, out: THREE.Vector3) {
    return p.body.getWorldPosition(out);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    // Time slows while you look at something, so it holds still for you.
    const focus = hovered ?? highlighted;
    timeScale = damp(timeScale, focus ? 0.12 : reducedMotion ? 0.15 : 1, 4, dt);
    const t = elapsed;

    if (intro < 1) intro = Math.min(1, intro + dt / 2.8);

    nebulaUniforms.uTime.value = t;
    starUniforms.uTime.value = t;
    coreUniforms.uTime.value = t;
    coreUniforms.uBeat.value = damp(coreUniforms.uBeat.value, 0, 2.5, dt);
    coreUniforms.uAlive.value = damp(coreUniforms.uAlive.value, piAlive === false ? 0 : 1, 2, dt);
    lens.uniforms.uTime.value = t;

    const beat = coreUniforms.uBeat.value;
    shell.rotation.y += dt * 0.25 * timeScale;
    shell.rotation.x += dt * 0.11 * timeScale;
    shell.scale.setScalar(1 + beat * 0.18);
    shell2.rotation.y -= dt * 0.12 * timeScale;
    shell2.rotation.z += dt * 0.07 * timeScale;
    shellMat.opacity = piAlive === false ? 0.15 + (Math.random() < 0.1 ? 0.4 : 0) : 0.45 + beat * 0.5;
    coronaMat.opacity = (piAlive === false ? 0.15 : 0.45) + beat * 0.5;
    corona.scale.setScalar(7 + beat * 2.5 + Math.sin(t * 1.3) * 0.3);
    belt.rotation.y += dt * 0.02 * timeScale;

    planets.forEach((p, id) => {
      const target = id === focus ? 1 : 0;
      p.hover = damp(p.hover, target, 6, dt);
      p.flash = damp(p.flash, 0, 3, dt);
      p.angle += p.speed * dt * timeScale;
      p.pivot.rotation.y = p.angle;
      // A busy app spins faster: 0.15 rad/s at rest, up to about 3 at a full core.
      const spin = 0.15 + Math.min(p.cpu, 100) * 0.03;
      p.body.rotation.y += dt * spin * (0.3 + timeScale * 0.7);
      p.uniforms.uTime.value = t;
      p.uniforms.uHover.value = p.hover;
      p.uniforms.uFlash.value = p.flash;
      p.uniforms.uStatus.value = damp(p.uniforms.uStatus.value, STATUS_VALUE[p.status], 3, dt);
      // The halo says the status too: the app's colour when up, red when down, grey unknown.
      // A running app with something to look at (failed backup, errors, restarts, a dying
      // cert) breathes amber in and out of its own colour.
      const flare = p.status === 'up' && p.warn ? 0.5 + 0.5 * Math.sin(t * 3) : 0;
      const halo = p.status === 'up' ? p.uniforms.uColor.value : p.status === 'down' ? DOWN : UNKNOWN;
      tmpColor.copy(halo).lerp(WARN, flare);
      p.atmoUniforms.uColor.value.lerp(tmpColor, 1 - Math.exp(-6 * dt));
      p.atmoUniforms.uIntensity.value = (p.status === 'down' ? 0.2 : p.status === 'unknown' ? 0.4 : 0.75) + p.hover * (camera.aspect < 0.8 ? 0.5 : 1.4) + p.flash * 2;

      // Planets arrive one by one during the intro.
      const order = specs.findIndex((s) => s.id === id);
      const arrive = easeOutExpo(THREE.MathUtils.clamp((intro - 0.15 - order * 0.07) / 0.5, 0, 1));
      const scale = arrive * (1 + p.hover * 0.38);
      p.bodyHolder.scale.setScalar(Math.max(scale, 0.0001));

      p.orbitMaterial.opacity = (p.spec.host === 'pi' ? 0.07 : 0.1) + p.hover * 0.35;
      p.orbitMaterial.color.lerpColors(new THREE.Color('#ffffff'), p.uniforms.uColor.value, p.hover);

      for (const extra of p.extras) {
        if (p.spec.style === 'strings') {
          extra.children.forEach((ring, i) => {
            const shiver = 1 + Math.sin(t * 55 + i * 1.7) * 0.012 * p.hover;
            ring.scale.setScalar(shiver);
          });
          extra.rotation.z += dt * 0.1;
        } else if (p.spec.style === 'moon') {
          extra.rotation.y += dt * 1.4;
        } else {
          extra.rotation.y -= dt * 0.3;
          extra.rotation.x += dt * 0.2;
        }
      }

      // Trail: shift history along and put the newest position at the front.
      planetWorld(p, tmp);
      system.worldToLocal(tmp);
      const pos = p.trail.positions;
      if (pos[0] === 0 && pos[1] === 0 && pos[2] === 0) {
        for (let i = 0; i < TRAIL_POINTS; i++) pos.set([tmp.x, tmp.y, tmp.z], i * 3);
      }
      pos.copyWithin(3, 0, (TRAIL_POINTS - 1) * 3);
      pos[0] = tmp.x;
      pos[1] = tmp.y;
      pos[2] = tmp.z;
      p.trail.geometry.attributes.position.needsUpdate = true;
      p.trail.uniforms.uOpacity.value = arrive * (p.status === 'up' ? 0.9 : 0.3) * (0.6 + p.hover);

      // Labels.
      planetWorld(p, tmp);
      tmp2.copy(tmp).project(camera);
      const visible = tmp2.z < 1 && arrive > 0.6 && !launchState;
      events.onLabel(id, (tmp2.x * 0.5 + 0.5) * canvas.clientWidth, (-tmp2.y * 0.5 + 0.5) * canvas.clientHeight, visible);
    });

    // Packets.
    for (const pk of packets) {
      if (!pk.target) continue;
      pk.t += dt / 0.9;
      planetWorld(pk.target, tmp);
      system.worldToLocal(tmp);
      const mid = tmp2.copy(tmp).multiplyScalar(0.5);
      mid.y += 1.2 + tmp.length() * 0.12;
      pk.sprite.visible = pk.t > 0;
      const u = THREE.MathUtils.clamp(pk.t, 0, 1);
      // Quadratic bezier from the core (the origin, so its term drops out), arcing up.
      const b = 2 * (1 - u) * u;
      const c = u * u;
      pk.sprite.position.set(b * mid.x + c * tmp.x, b * mid.y + c * tmp.y, b * mid.z + c * tmp.z);
      pk.sprite.material.opacity = Math.sin(u * Math.PI) * 0.9 + 0.1;
      if (pk.t >= 1) {
        if (pk.target.status === 'up') pk.target.flash = 1;
        pk.target = null;
        pk.sprite.visible = false;
      }
    }

    // Camera.
    parallax.x = damp(parallax.x, mouse.x, 2, dt);
    parallax.y = damp(parallax.y, mouse.y, 2, dt);
    if (!drag) {
      view.yawVelocity = damp(view.yawVelocity, 0, 2, dt);
      view.yaw += view.yawVelocity + dt * 0.015 * timeScale;
    }
    view.tilt = damp(view.tilt, view.targetTilt, 4, dt);
    const introDistance = THREE.MathUtils.lerp(110, view.targetDistance, easeOutExpo(intro));
    view.distance = intro < 1 ? introDistance : damp(view.distance, view.targetDistance, 3, dt);
    system.rotation.y = view.yaw;

    if (launchState) {
      const ls = launchState;
      ls.t = Math.min(1, ls.t + dt / 1.15);
      const e = easeInCubic(ls.t);
      planetWorld(ls.planet, tmp);
      // Fly at the planet, stopping just short of its surface.
      const toward = tmp2.copy(ls.from).sub(tmp).normalize().multiplyScalar(ls.planet.radius * 1.6);
      const dest = tmp.clone().add(toward);
      camera.position.lerpVectors(ls.from, dest, e);
      look.lerp(tmp, Math.min(1, dt * 8));
      camera.lookAt(look);
      camera.fov = THREE.MathUtils.lerp(view.fov, 115, e);
      streakUniforms.uWarp.value = Math.min(1, ls.t * 1.6);
      streakUniforms.uColor.value.copy(ls.planet.uniforms.uColor.value);
      lens.uniforms.uWarp.value = e;
      bloom.strength = 0.8 + e * 2.8;
      camera.updateProjectionMatrix();
      if (ls.t >= 1) {
        launchState = null;
        ls.resolve();
      }
    } else {
      // Lean in towards whatever you're looking at.
      const focused = focus ? planets.get(focus) : undefined;
      // Gently on a phone, where the system is small and a lean crops it.
      const portrait = camera.aspect < 0.8;
      focusAmount = damp(focusAmount, focused ? 1 : 0, 2.5, dt);
      lookGoal.set(0, -0.6, 0);
      if (focused) lookGoal.lerp(planetWorld(focused, tmp), portrait ? 0.15 : 0.4);
      const d = view.distance * (1 - (portrait ? 0.04 : 0.14) * focusAmount);
      rig.position.set(0, 0, 0);
      camera.position.set(
        Math.sin(parallax.x * 0.06) * d * 0.2,
        Math.sin(view.tilt) * d - parallax.y * 0.6,
        Math.cos(view.tilt) * d
      );
      look.lerp(lookGoal, 1 - Math.exp(-3 * dt));
      camera.lookAt(look);
      if (camera.fov !== view.fov) {
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
      }
    }

    // Warp streaks race past the camera.
    if (streakUniforms.uWarp.value > 0) {
      const arr = streakGeo.attributes.position.array as Float32Array;
      const speed = 160 * streakUniforms.uWarp.value * dt;
      for (let i = 0; i < streakCount; i++) {
        let z = arr[i * 6 + 2] + speed;
        if (z > 0) z = -150;
        arr[i * 6 + 2] = z;
        arr[i * 6 + 5] = z;
      }
      streakGeo.attributes.position.needsUpdate = true;
    }

    composer.render();
  }
  frame();

  function resetLaunch() {
    launchState = null;
    streakUniforms.uWarp.value = 0;
    lens.uniforms.uWarp.value = 0;
    bloom.strength = 0.8;
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
  }

  return {
    setStatus(status, reachable) {
      piAlive = reachable;
      planets.forEach((p, id) => {
        p.status = status[id] ?? 'unknown';
      });
    },
    setVitals(vitals) {
      planets.forEach((p, id) => {
        p.cpu = vitals[id]?.cpu ?? 0;
        p.warn = vitals[id]?.warn ?? false;
      });
    },
    highlight(id) {
      highlighted = id;
    },
    pulse() {
      coreUniforms.uBeat.value = 1;
      let i = 0;
      planets.forEach((p) => {
        const pk = packets[i++ % packets.length];
        pk.target = p;
        pk.t = -i * 0.06; // a ripple, not a volley
        pk.sprite.visible = true;
        pk.sprite.position.set(0, 0, 0);
        pk.sprite.material.color.copy(p.uniforms.uColor.value);
      });
    },
    launch(id) {
      const planet = planets.get(id);
      if (!planet || reducedMotion) return Promise.resolve();
      setHovered(null);
      return new Promise<void>((resolve) => {
        launchState = { planet, t: 0, from: camera.position.clone(), resolve };
      });
    },
    ping(id) {
      const p = planets.get(id);
      if (p) p.flash = 1.5;
      coreUniforms.uBeat.value = 0.6;
    },
    reset: resetLaunch,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      renderer.dispose();
    }
  };
}
