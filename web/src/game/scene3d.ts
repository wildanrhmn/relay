/**
 * The apparatus as a corridor of breaker gates.
 *
 * Gates recede into depth and the camera flies forward as each one opens, so how
 * far the current got — which is exactly what the round pays on — is read as
 * distance travelled rather than as a number. Materials follow the platform's
 * instrument palette: gunmetal frames, brass-lit edges, warm current.
 */
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ExtrudeGeometry,
  Float32BufferAttribute,
  FogExp2,
  Group,
  Mesh,
  MeshStandardMaterial,
  Path,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { StageEvent, StageLike } from './stage-api';

const GATE_SPACING = 3.15;
const LANE_H = 0.28;
const LANE_GAP = 0.24;
const GATE_W = 2.5;
const MAX_STACK = 4;
/** Every gate gets the same outer frame; only the wires inside differ. */
const INNER_H = MAX_STACK * LANE_H + (MAX_STACK - 1) * LANE_GAP;
const OUTER_H = INNER_H + 0.62;
const FRAME_W = GATE_W + 0.62;
const FLOOR_Y = -OUTER_H / 2 - 0.42;

/** Off-axis so the corridor is seen down its length. */
const CAM_BACK = 5.9;
const CAM_OFF_X = 3.0;
const CAM_OFF_Y = 1.05;

const GATE_MS = 165;
const LANE_MS = 58;
const END_MS = 900;

const C = {
  bg: 0x08080b,
  frame: 0x2a2c34,
  edgeIdle: 0x8a7a48,
  edgeLive: 0xffe068,
  edgeFail: 0xff3838,
  wireIdle: 0x23252c,
  wireLive: 0xfff2b8,
  wireDead: 0x4a1616,
  current: 0xfff6c8,
  floor: 0x07070a,
};

function roundedRect(w: number, h: number, r: number): Shape {
  const shape = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  const radius = Math.min(r, w / 2, h / 2);
  shape.moveTo(x + radius, y);
  shape.lineTo(x + w - radius, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + radius);
  shape.lineTo(x + w, y + h - radius);
  shape.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  shape.lineTo(x + radius, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

type GateParts = { group: Group; frame: Mesh; ring: Mesh; wires: Mesh[]; z: number };

export class Scene3D implements StageLike {
  private renderer: WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private root = new Group();
  private gates: GateParts[] = [];
  private lanes: number[] = [];
  private raf = 0;
  private hover = -1;

  private spark: Mesh;
  private sparkLight: PointLight;
  private motes: Points;
  private railGroup: Group | null = null;

  private labelLayer: HTMLElement | null;
  private labels: HTMLElement[] = [];
  private labelText: string[] = [];

  private cameraZ = CAM_BACK;
  private shake = 0;
  private lastFrame = 0;

  private anim: { trace: boolean[][]; emitted: Set<string>; start: number } | null = null;
  private emit: (event: StageEvent) => void;
  private reduceMotion: boolean;

  constructor(private canvas: HTMLCanvasElement, emit: (event: StageEvent) => void, labelLayer?: HTMLElement) {
    this.emit = emit;
    this.labelLayer = labelLayer ?? null;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(C.bg, 1);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = SRGBColorSpace;

    // A neutral room gives the metal something to reflect; without it PBR
    // surfaces read as flat plastic.
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.7;
    pmrem.dispose();

    this.scene.fog = new FogExp2(C.bg, 0.046);
    this.scene.add(this.root);

    this.camera = new PerspectiveCamera(50, 1, 0.1, 120);
    this.camera.position.set(CAM_OFF_X, CAM_OFF_Y, this.cameraZ);

    const key = new PointLight(0xfff1d0, 30, 30, 2);
    key.position.set(3, 4, 4);
    const fill = new PointLight(0x9fb4ff, 10, 26, 2);
    fill.position.set(-4, -1, -3);
    this.scene.add(key, fill);

    this.spark = new Mesh(
      new SphereGeometry(0.12, 20, 20),
      new MeshStandardMaterial({ color: C.current, emissive: new Color(C.current), emissiveIntensity: 2.6, roughness: 0.3 }),
    );
    this.sparkLight = new PointLight(C.current, 14, 8, 2);
    this.scene.add(this.spark, this.sparkLight);

    const floor = new Mesh(
      new PlaneGeometry(60, 90),
      new MeshStandardMaterial({ color: C.floor, metalness: 0.35, roughness: 0.62, envMapIntensity: 0.25 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, FLOOR_Y, -30);
    this.scene.add(floor);

    this.motes = this.buildMotes();
    this.scene.add(this.motes);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.42, 0.5, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', this.resize);
    this.loop();
  }

  private buildMotes(): Points {
    const count = 320;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 16;
      positions[i * 3 + 1] = (Math.random() - 0.3) * 8;
      positions[i * 3 + 2] = -Math.random() * 46 + 4;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return new Points(
      geo,
      new PointsMaterial({ color: 0xcdb46a, size: 0.035, transparent: true, opacity: 0.35, depthWrite: false }),
    );
  }

  setBuild(lanes: number[]): void {
    if (lanes.length === this.lanes.length && lanes.every((k, i) => k === this.lanes[i])) return;
    this.lanes = [...lanes];
    this.rebuild();
  }

  private disposeGates(): void {
    for (const gate of this.gates) {
      gate.group.traverse((node) => {
        if (node instanceof Mesh) {
          node.geometry.dispose();
          (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => m.dispose());
        }
      });
      this.root.remove(gate.group);
    }
    this.gates = [];
    if (this.railGroup) {
      this.railGroup.traverse((node) => {
        if (node instanceof Mesh) node.geometry.dispose();
      });
      this.root.remove(this.railGroup);
      this.railGroup = null;
    }
  }

  private rebuild(): void {
    this.disposeGates();

    this.lanes.forEach((count, index) => {
      const group = new Group();
      const z = -index * GATE_SPACING;
      group.position.z = z;

      const stackH = count * LANE_H + (count - 1) * LANE_GAP;
      const thickness = 0.17;

      const outer = roundedRect(FRAME_W, OUTER_H, 0.3);
      const inner = roundedRect(FRAME_W - thickness * 2, OUTER_H - thickness * 2, 0.2);
      outer.holes.push(new Path(inner.getPoints(28)));

      const frame = new Mesh(
        new ExtrudeGeometry(outer, {
          depth: 0.26,
          bevelEnabled: true,
          bevelSize: 0.03,
          bevelThickness: 0.03,
          bevelSegments: 2,
          curveSegments: 12,
        }),
        new MeshStandardMaterial({ color: C.frame, metalness: 0.85, roughness: 0.38 }),
      );
      group.add(frame);

      // Brass edge strip on the face of each gate: the receding chain of lit
      // rectangles is what makes the corridor read as a corridor.
      const ringOuter = roundedRect(FRAME_W - 0.06, OUTER_H - 0.06, 0.27);
      const ringInner = roundedRect(FRAME_W - 0.06 - 0.06, OUTER_H - 0.06 - 0.06, 0.24);
      ringOuter.holes.push(new Path(ringInner.getPoints(28)));
      const ring = new Mesh(
        new ExtrudeGeometry(ringOuter, { depth: 0.02, bevelEnabled: false, curveSegments: 12 }),
        new MeshStandardMaterial({
          color: 0x2a2410,
          emissive: new Color(C.edgeIdle),
          emissiveIntensity: 0.5,
          metalness: 0.6,
          roughness: 0.4,
        }),
      );
      ring.position.z = 0.28;
      group.add(ring);

      const wires: Mesh[] = [];
      for (let lane = 0; lane < count; lane++) {
        const y = stackH / 2 - LANE_H / 2 - lane * (LANE_H + LANE_GAP);
        const bar = new Mesh(
          new CapsuleGeometry(LANE_H / 2, GATE_W - LANE_H, 6, 16),
          new MeshStandardMaterial({
            color: C.wireIdle,
            emissive: new Color(C.wireIdle),
            emissiveIntensity: 0.15,
            metalness: 0.92,
            roughness: 0.22,
          }),
        );
        bar.rotation.z = Math.PI / 2;
        bar.position.set(0, y, 0.13);
        group.add(bar);
        wires.push(bar);
      }

      this.root.add(group);
      this.gates.push({ group, frame, ring, wires, z });
    });

    this.buildRails();
    this.buildLabels();
    this.resetVisuals();
  }

  /** Four bus bars threading the gates together so the run reads as one machine. */
  private buildRails(): void {
    if (this.gates.length < 2) return;
    const span = (this.gates.length - 1) * GATE_SPACING;
    const length = span + 0.9;
    const material = new MeshStandardMaterial({ color: 0x1b1c22, metalness: 0.9, roughness: 0.35 });
    const rail = new Mesh(new BoxGeometry(0.07, 0.07, length), material);
    const group = new Group();
    for (const [x, y] of [
      [-FRAME_W / 2, OUTER_H / 2],
      [FRAME_W / 2, OUTER_H / 2],
      [-FRAME_W / 2, -OUTER_H / 2],
      [FRAME_W / 2, -OUTER_H / 2],
    ]) {
      const clone = rail.clone();
      clone.position.set(x, y, 0.3 - length / 2);
      group.add(clone);
    }
    this.railGroup = group;
    this.root.add(group);
  }

  /** One HTML chip per gate, projected onto the canvas each frame. */
  private buildLabels(): void {
    if (!this.labelLayer) return;
    this.labelLayer.innerHTML = '';
    this.labels = this.gates.map((_, i) => {
      const node = document.createElement('div');
      node.className = 'gate-label';
      node.innerHTML = `<b>${this.labelText[i] ?? ''}</b><span>gate ${i + 1}</span>`;
      this.labelLayer!.append(node);
      return node;
    });
  }

  setLabels(texts: string[]): void {
    this.labelText = [...texts];
    this.labels.forEach((node, i) => {
      const value = node.querySelector('b');
      if (value) value.textContent = this.labelText[i] ?? '';
    });
  }

  private updateLabels(failedAt: number, clearedCount: number): void {
    if (!this.labelLayer || this.labels.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const point = new Vector3();
    // Labels converge toward the vanishing point; walk from the camera outwards
    // and drop any that would land on the last one kept.
    let last: { x: number; y: number } | null = null;

    this.gates.forEach((gate, i) => {
      const node = this.labels[i];
      if (!node) return;
      point.set(0, OUTER_H / 2 + 0.12, gate.z);
      point.project(this.camera);

      const depth = this.cameraZ - gate.z;
      const x = ((point.x + 1) / 2) * rect.width;
      const y = ((-point.y + 1) / 2) * rect.height;
      const crowded = last !== null && Math.hypot(x - last.x, y - last.y) < 64;
      const visible = point.z < 1 && depth > 0.7 && depth < 24 && !crowded;

      node.style.display = visible ? 'flex' : 'none';
      if (!visible) return;
      last = { x, y };

      const scale = Math.max(0.55, Math.min(1, 4.4 / depth));
      node.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px) scale(${scale})`;
      node.style.opacity = String(Math.max(0.25, Math.min(1, 1.4 - depth / 18)));

      node.classList.toggle('is-failed', failedAt === i);
      node.classList.toggle('is-cleared', this.anim !== null && i < clearedCount);
      node.classList.toggle('is-dim', failedAt !== -1 && i > failedAt);
    });
  }

  private resetVisuals(): void {
    for (const gate of this.gates) {
      const ring = gate.ring.material as MeshStandardMaterial;
      ring.emissive.set(C.edgeIdle);
      ring.emissiveIntensity = 0.5;
      for (const bar of gate.wires) {
        const mat = bar.material as MeshStandardMaterial;
        mat.color.set(C.wireIdle);
        mat.emissive.set(C.wireIdle);
        mat.emissiveIntensity = 0.15;
      }
    }
  }

  setHover(index: number): void {
    this.hover = index;
  }

  gateAt(x: number, y: number): number {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return -1;
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1), this.camera);

    for (let i = 0; i < this.gates.length; i++) {
      const plane = new Plane(new Vector3(0, 0, 1), -this.gates[i].z);
      const hit = new Vector3();
      if (!ray.ray.intersectPlane(plane, hit)) continue;
      if (Math.abs(hit.x) <= FRAME_W / 2 && Math.abs(hit.y) <= OUTER_H / 2) return i;
    }
    return -1;
  }

  play(trace: boolean[][]): Promise<void> {
    this.resetVisuals();
    this.anim = { trace, emitted: new Set(), start: performance.now() };
    this.emit({ type: 'charge' });

    const laneCount = trace.reduce((acc, gate) => acc + gate.length, 0);
    const duration = this.reduceMotion ? 260 : trace.length * GATE_MS + laneCount * LANE_MS + END_MS;
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  clearRound(): void {
    this.anim = null;
    this.resetVisuals();
  }

  destroy(): void {
    if (this.labelLayer) this.labelLayer.innerHTML = '';
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.disposeGates();
    this.composer.dispose();
    this.renderer.dispose();
  }

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(rect.width, rect.height, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(rect.width, rect.height);
    this.bloom.resolution.set(rect.width, rect.height);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
  };

  private gateStart(index: number): number {
    if (!this.anim) return 0;
    let t = 0;
    for (let i = 0; i < index; i++) t += GATE_MS + (this.anim.trace[i]?.length ?? 0) * LANE_MS;
    return t;
  }

  private loop = (): void => {
    const now = performance.now();
    const dt = Math.min(50, now - (this.lastFrame || now));
    this.lastFrame = now;
    this.update(now, dt);
    this.composer.render();
    this.raf = requestAnimationFrame(this.loop);
  };

  private update(now: number, dt: number): void {
    const positions = this.motes.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      let z = positions.getZ(i) + dt * 0.0012;
      if (z > this.cameraZ + 2) z -= 50;
      positions.setZ(i, z);
    }
    positions.needsUpdate = true;

    let frontier = 0;
    let cleared = 0;
    let failedAt = -1;

    if (this.anim) {
      const elapsed = this.reduceMotion ? Number.MAX_SAFE_INTEGER : now - this.anim.start;

      this.gates.forEach((gate, i) => {
        const traced = this.anim!.trace[i];
        if (!traced) return;
        const span = GATE_MS + traced.length * LANE_MS;
        const value = Math.max(0, Math.min(1, (elapsed - this.gateStart(i)) / span));
        if (value <= 0) return;

        if (!this.anim!.emitted.has(`g${i}`)) {
          this.anim!.emitted.add(`g${i}`);
          traced.forEach((live, lane) => setTimeout(() => this.emit({ type: 'lane', live }), lane * LANE_MS));
        }

        traced.forEach((live, lane) => {
          if (value * traced.length <= lane) return;
          const bar = gate.wires[lane];
          if (!bar) return;
          const mat = bar.material as MeshStandardMaterial;
          if (live) {
            mat.color.set(C.wireLive);
            mat.emissive.set(C.wireLive);
            mat.emissiveIntensity = 1.35;
          } else {
            mat.color.set(C.wireDead);
            mat.emissive.set(C.wireDead);
            mat.emissiveIntensity = 0.6;
          }
        });

        const passed = traced.some(Boolean);
        if (value >= 1) {
          if (!this.anim!.emitted.has(`r${i}`)) {
            this.anim!.emitted.add(`r${i}`);
            if (passed) {
              this.emit({ type: 'gate', index: i });
              if (i === this.gates.length - 1) {
                this.emit({ type: 'won', gates: this.gates.length });
                this.shake = 0.5;
              }
            } else {
              this.emit({ type: 'failed', index: i });
              this.shake = 0.32;
            }
          }
          const ring = gate.ring.material as MeshStandardMaterial;
          ring.emissive.set(passed ? C.edgeLive : C.edgeFail);
          ring.emissiveIntensity = passed ? 2.0 : 2.3;
          if (passed) cleared = i + 1;
          else if (failedAt === -1) failedAt = i;
        }
        if (failedAt === -1) frontier = i + Math.min(1, value);
      });
    }

    // Camera rides just behind the frontier; a failed run stops where it died.
    const targetZ = CAM_BACK - frontier * GATE_SPACING;
    this.cameraZ += (targetZ - this.cameraZ) * Math.min(1, dt / 190);

    this.shake = Math.max(0, this.shake - dt / 420);
    const jitter = this.reduceMotion ? 0 : this.shake * 0.1;
    this.camera.position.set(
      CAM_OFF_X + (Math.random() - 0.5) * jitter,
      CAM_OFF_Y + (Math.random() - 0.5) * jitter,
      this.cameraZ,
    );
    this.camera.lookAt(0, -0.15, this.cameraZ - 7.2);

    const sparkZ = 0.8 - frontier * GATE_SPACING;
    this.spark.position.set(0, 0.05, sparkZ);
    this.sparkLight.position.copy(this.spark.position);
    const active = this.anim !== null && failedAt === -1;
    this.spark.visible = active;
    this.sparkLight.intensity = active ? 14 : 0;

    this.gates.forEach((gate, i) => {
      const hovered = this.hover === i && !this.anim;
      const ring = gate.ring.material as MeshStandardMaterial;
      gate.group.position.y = Math.sin(now / 1400 + i) * 0.01;
      if (!this.anim) {
        const pulse = (Math.sin(now / 700 - i * 0.6) + 1) / 2;
        ring.emissiveIntensity = 0.35 + pulse * 0.6 + (hovered ? 1.6 : 0);
      }
      if (failedAt !== -1 && i > failedAt) ring.emissiveIntensity = 0.12;
    });

    this.updateLabels(failedAt, cleared);
  }
}
