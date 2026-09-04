/**
 * The apparatus as a corridor.
 *
 * Gates recede into depth and the camera flies forward as each one opens, so how
 * far the current got — which is exactly what the round pays on — is read as
 * distance travelled rather than as a number.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
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
  PointLight,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Shape,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { StageEvent, StageLike } from './stage-api';

const GATE_SPACING = 3.15;
const LANE_H = 0.3;
const LANE_GAP = 0.23;
const GATE_W = 2.5;
/** How far in front of the frontier gate the camera sits, in world units. */
const CAM_BACK = 5.8;
/** Off-axis so the corridor is seen down its length; head-on, the near gate's
 *  wires occlude everything behind it and the depth is lost. */
const CAM_OFF_X = 3.1;
const CAM_OFF_Y = 1.45;
const MAX_STACK = 4;
/**
 * Every gate gets the same outer frame regardless of how many wires it holds —
 * varying frame sizes hid the thin gates behind the wide ones and destroyed the
 * corridor. Only the wires inside differ.
 */
const INNER_H = MAX_STACK * LANE_H + (MAX_STACK - 1) * LANE_GAP;
const OUTER_H = INNER_H + 0.62;
const FRAME_W = GATE_W + 0.62;

const GATE_MS = 165;
const LANE_MS = 58;
const END_MS = 900;

const C = {
  bg: 0x06070b,
  frame: 0x222a3a,
  frameLive: 0x2ee6b6,
  frameFail: 0xff4d63,
  wireIdle: 0x323b4e,
  wireLive: 0x6ef7cf,
  wireDead: 0x6d1f30,
  current: 0xbdfff4,
  gold: 0xffd166,
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

/** Soft radial sprite used to fake bloom without a post-processing pass. */
function glowTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

type WireParts = { bar: Mesh; halo: Mesh };
type GateParts = { group: Group; frame: Mesh; ring: Mesh; wires: WireParts[]; z: number };

export class Scene3D implements StageLike {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private root = new Group();
  private gates: GateParts[] = [];
  private lanes: number[] = [];
  private glow = glowTexture();
  private raf = 0;
  private hover = -1;

  private spark: Mesh;
  private sparkLight: PointLight;
  private motes: Points;
  private railGroup: Group | null = null;
  private labelLayer: HTMLElement | null = null;
  private labels: HTMLElement[] = [];
  private labelText: string[] = [];

  private cameraZ = CAM_BACK;
  private shake = 0;
  private lastFrame = 0;

  private anim: { trace: boolean[][]; emitted: Set<string>; start: number } | null = null;
  private emit: (event: StageEvent) => void;
  private reduceMotion: boolean;

  constructor(
    private canvas: HTMLCanvasElement,
    emit: (event: StageEvent) => void,
    labelLayer?: HTMLElement,
  ) {
    this.emit = emit;
    this.labelLayer = labelLayer ?? null;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(C.bg, 1);

    this.scene.fog = new FogExp2(C.bg, 0.03);
    this.scene.add(this.root);

    this.camera = new PerspectiveCamera(52, 1, 0.1, 120);
    this.camera.position.set(CAM_OFF_X, CAM_OFF_Y, this.cameraZ);

    const key = new PointLight(0x9fe8ff, 24, 26, 2);
    key.position.set(2.4, 3.2, 3);
    const rim = new PointLight(0x4affd0, 16, 22, 2);
    rim.position.set(-3, -2, -4);
    this.scene.add(key, rim);

    this.spark = new Mesh(
      new SphereGeometry(0.13, 20, 20),
      new MeshStandardMaterial({ color: C.current, emissive: new Color(C.current), emissiveIntensity: 4, roughness: 0.3 }),
    );
    this.sparkLight = new PointLight(C.current, 26, 9, 2);
    this.scene.add(this.spark, this.sparkLight);

    this.motes = this.buildMotes();
    this.scene.add(this.motes);

    this.resize();
    window.addEventListener('resize', this.resize);
    this.loop();
  }

  private buildMotes(): Points {
    const count = 420;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 16;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 2] = -Math.random() * 46 + 4;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return new Points(
      geo,
      new PointsMaterial({ color: 0x63e8c8, size: 0.045, transparent: true, opacity: 0.5, depthWrite: false }),
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
      const thickness = 0.16;

      const outer = roundedRect(FRAME_W, OUTER_H, 0.34);
      const inner = roundedRect(FRAME_W - thickness * 2, OUTER_H - thickness * 2, 0.24);
      outer.holes.push(new Path(inner.getPoints(28)));

      const frame = new Mesh(
        new ExtrudeGeometry(outer, {
          depth: 0.22,
          bevelEnabled: true,
          bevelSize: 0.035,
          bevelThickness: 0.035,
          bevelSegments: 2,
          curveSegments: 12,
        }),
        new MeshStandardMaterial({
          color: C.frame,
          emissive: new Color(C.frame),
          emissiveIntensity: 0.55,
          metalness: 0.75,
          roughness: 0.35,
        }),
      );
      group.add(frame);

      // A thin emissive outline on the face of each gate: the receding chain of
      // lit rectangles is what makes the corridor read as a corridor.
      const ringOuter = roundedRect(FRAME_W - 0.05, OUTER_H - 0.05, 0.31);
      const ringInner = roundedRect(FRAME_W - 0.05 - 0.07, OUTER_H - 0.05 - 0.07, 0.28);
      ringOuter.holes.push(new Path(ringInner.getPoints(28)));
      const ring = new Mesh(
        new ExtrudeGeometry(ringOuter, { depth: 0.02, bevelEnabled: false, curveSegments: 12 }),
        new MeshStandardMaterial({
          color: 0x0a0f16,
          emissive: new Color(C.frameLive),
          emissiveIntensity: 0.55,
          toneMapped: false,
        }),
      );
      ring.position.z = 0.24;
      group.add(ring);

      const wires: WireParts[] = [];
      for (let lane = 0; lane < count; lane++) {
        const y = stackH / 2 - LANE_H / 2 - lane * (LANE_H + LANE_GAP);

        const bar = new Mesh(
          new CapsuleGeometry(LANE_H / 2, GATE_W - LANE_H, 6, 14),
          new MeshStandardMaterial({
            color: C.wireIdle,
            emissive: new Color(C.wireIdle),
            emissiveIntensity: 0.6,
            metalness: 0.6,
            roughness: 0.45,
          }),
        );
        bar.rotation.z = Math.PI / 2;
        bar.position.set(0, y, 0.11);

        const halo = new Mesh(
          new PlaneGeometry(GATE_W + 1.5, LANE_H * 4.5),
          new MeshStandardMaterial({
            map: this.glow,
            color: C.wireLive,
            transparent: true,
            opacity: 0,
            blending: AdditiveBlending,
            depthWrite: false,
          }),
        );
        halo.position.set(0, y, 0.14);

        group.add(bar, halo);
        wires.push({ bar, halo });
      }

      this.root.add(group);
      this.gates.push({ group, frame, ring, wires, z });
    });

    this.buildRails();
    this.buildLabels();
    this.resetVisuals();
  }

  /** Four rails threading the gates together so the run reads as one corridor. */
  private buildRails(): void {
    if (this.gates.length < 2) return;

    const span = (this.gates.length - 1) * GATE_SPACING;
    const length = span + 0.9;
    const material = new MeshStandardMaterial({
      color: 0x1a2131,
      emissive: new Color(0x121824),
      emissiveIntensity: 0.6,
      metalness: 0.8,
      roughness: 0.4,
    });

    const rail = new Mesh(new BoxGeometry(0.06, 0.06, length), material);
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

  /** One HTML chip per gate, projected onto the canvas each frame. Crisper and
   *  cheaper than 3D text, and it is what makes the corridor legible: you are
   *  flying through a ladder of named payouts, not past anonymous frames. */
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
    // Gates converge toward the vanishing point, so their labels would stack into
    // an unreadable pile. Walk from the camera outwards and drop any label that
    // lands too close to the last one kept.
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
      const mat = gate.frame.material as MeshStandardMaterial;
      mat.color.set(C.frame);
      mat.emissive.set(C.frame);
      mat.emissiveIntensity = 0.55;
      const ring = gate.ring.material as MeshStandardMaterial;
      ring.emissive.set(C.frameLive);
      ring.emissiveIntensity = 0.55;
      gate.group.visible = true;
      for (const wire of gate.wires) {
        const bar = wire.bar.material as MeshStandardMaterial;
        bar.color.set(C.wireIdle);
        bar.emissive.set(C.wireIdle);
        bar.emissiveIntensity = 0.3;
        (wire.halo.material as MeshStandardMaterial).opacity = 0;
      }
    }
  }

  setHover(index: number): void {
    this.hover = index;
  }

  /** Raycast against gate frames so the player can click a gate in the scene. */
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
    this.renderer.dispose();
  }

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(rect.width, rect.height, false);
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
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };

  private update(now: number, dt: number): void {
    const positions = this.motes.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      let z = positions.getZ(i) + dt * 0.0016;
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
          const wire = gate.wires[lane];
          if (!wire) return;
          const bar = wire.bar.material as MeshStandardMaterial;
          const halo = wire.halo.material as MeshStandardMaterial;
          if (live) {
            bar.color.set(C.wireLive);
            bar.emissive.set(C.wireLive);
            bar.emissiveIntensity = 2.6;
            halo.opacity = Math.min(0.85, halo.opacity + dt / 200);
          } else {
            bar.color.set(C.wireDead);
            bar.emissive.set(C.wireDead);
            bar.emissiveIntensity = 0.5;
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
          const mat = gate.frame.material as MeshStandardMaterial;
          mat.emissive.set(passed ? C.frameLive : C.frameFail);
          mat.emissiveIntensity = passed ? 1.1 : 1.4;
          const ring = gate.ring.material as MeshStandardMaterial;
          ring.emissive.set(passed ? C.frameLive : C.frameFail);
          ring.emissiveIntensity = passed ? 5.5 : 4.5;
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
    const jitter = this.reduceMotion ? 0 : this.shake * 0.11;
    this.camera.position.set(
      CAM_OFF_X + (Math.random() - 0.5) * jitter,
      CAM_OFF_Y + (Math.random() - 0.5) * jitter,
      this.cameraZ,
    );
    this.camera.lookAt(0, -0.05, this.cameraZ - 7.4);

    const sparkZ = 0.8 - frontier * GATE_SPACING;
    this.spark.position.set(0, 0.05, sparkZ);
    this.sparkLight.position.copy(this.spark.position);
    const active = this.anim !== null && failedAt === -1;
    this.spark.visible = active;
    this.sparkLight.intensity = active ? 26 : 0;

    this.gates.forEach((gate, i) => {
      const hovered = this.hover === i && !this.anim;
      const mat = gate.frame.material as MeshStandardMaterial;
      if (!this.anim) mat.emissiveIntensity = hovered ? 1.15 : 0.55;
      gate.group.position.y = Math.sin(now / 1400 + i) * 0.012;
      if (!this.anim) {
        const pulse = (Math.sin(now / 620 - i * 0.7) + 1) / 2;
        (gate.ring.material as MeshStandardMaterial).emissiveIntensity = 0.35 + pulse * 0.85 + (hovered ? 2 : 0);
      }
      if (failedAt !== -1 && i > failedAt) {
        mat.emissiveIntensity = 0.12;
        (gate.ring.material as MeshStandardMaterial).emissiveIntensity = 0.1;
      }
    });

    this.updateLabels(failedAt, cleared);
  }
}
