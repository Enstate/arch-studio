import * as THREE from 'three/webgpu';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Plan } from '../plan/schema.ts';

// Just under the 1.2 m cut so the clip plane keeps it; depthTest is off, so it still draws on top.
const Y = 1.15;
/** Major grid spacings in meters; the grid takes the finest that keeps a side to at most 60 lines. */
const GRID_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const GRID_LINES = 60;
const INK = '#c2410c';

/** The plan area the grid covers, in plan coordinates. */
export interface PlanArea { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Plan-view helpers: the source image placed at its calibrated scale, a
 * meter grid with coordinate labels, and a north arrow when the plan knows north.
 * The agent screenshots this to check its traced walls against the drawing and
 * to read coordinates off the grid.
 */
export class PlanOverlay {
  readonly group = new THREE.Group();
  readonly image = new THREE.Group();
  readonly grid = new THREE.Group();
  readonly compass = new THREE.Group();
  private imageMat: THREE.MeshBasicMaterial | null = null;

  constructor() {
    this.group.name = 'plan-overlay';
    this.group.add(this.image, this.grid, this.compass);
    this.group.visible = false;
  }

  /** Lays the image, the grid over `area` and the north arrow beside it. */
  async build(plan: Plan, imageUrl: string | undefined, area: PlanArea) {
    this.clear();
    const b = area;
    if (plan.source && imageUrl) {
      const tex = await new THREE.TextureLoader().loadAsync(imageUrl);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const img = tex.image as { width: number; height: number };
      const ppm = plan.source.pxPerMeter;
      const [ox, oy] = plan.source.originPx ?? [0, 0];
      const w = img.width / ppm, h = img.height / ppm;
      this.imageMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.55, depthTest: false, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.imageMat);
      mesh.rotation.x = -Math.PI / 2;
      // Image pixel (0,0) is its top-left corner; plan (0,0) sits at originPx.
      mesh.position.set(w / 2 - ox / ppm, Y, h / 2 - oy / ppm);
      mesh.renderOrder = 10;
      this.image.add(mesh);
    }
    // Grid from one step outside the area, with minor lines at half steps. A house gets 1 m major
    // and 0.5 m minor lines; a large site coarser ones, so lines and labels stay few.
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) + 2;
    const s = GRID_STEPS.find((step) => span / step <= GRID_LINES) ?? GRID_STEPS[GRID_STEPS.length - 1];
    const x0 = Math.floor(b.minX / s) * s - s, x1 = Math.ceil(b.maxX / s) * s + s;
    const z0 = Math.floor(b.minY / s) * s - s, z1 = Math.ceil(b.maxY / s) * s + s;
    const minor: number[] = [], major: number[] = [];
    for (let i = 0; x0 + (i * s) / 2 <= x1 + 1e-6; i++) {
      const x = x0 + (i * s) / 2;
      (i % 2 ? minor : major).push(x, Y + 0.01, z0, x, Y + 0.01, z1);
    }
    for (let i = 0; z0 + (i * s) / 2 <= z1 + 1e-6; i++) {
      const z = z0 + (i * s) / 2;
      (i % 2 ? minor : major).push(x0, Y + 0.01, z, x1, Y + 0.01, z);
    }
    const line = (pts: number[], color: string, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, toneMapped: false }));
      l.renderOrder = 11;
      return l;
    };
    this.grid.add(line(minor, INK, 0.18), line(major, INK, 0.45));
    for (let x = x0; x <= x1; x += s) this.grid.add(this.label(String(x), x, z0 - 0.3 * s));
    for (let z = z0; z <= z1; z += s) this.grid.add(this.label(String(z), x0 - 0.35 * s, z));

    // North arrow outside the grid's top right corner, pointing to plan north.
    if (plan.north !== undefined || plan.latitude !== undefined) {
      const a = THREE.MathUtils.degToRad(plan.north ?? 0);
      const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)), side = new THREE.Vector3(-dir.z, 0, dir.x);
      const c = new THREE.Vector3(x1 + 0.6 * s, Y + 0.01, z0 + 0.6 * s), r = 0.5 * s;
      const tip = c.clone().addScaledVector(dir, r), tail = c.clone().addScaledVector(dir, -r);
      const barb = (k: number) => tip.clone().addScaledVector(dir, -0.3 * s).addScaledVector(side, k * 0.15 * s);
      const pts = [tail, tip, tip, barb(1), tip, barb(-1)].flatMap((p) => [p.x, p.y, p.z]);
      const n = this.label('N', 0, 0);
      n.position.copy(c).addScaledVector(dir, r + 0.3 * s);
      this.compass.add(line(pts, INK, 0.9), n);
    }
  }

  private label(text: string, x: number, z: number) {
    const el = document.createElement('div');
    el.className = 'grid-label';
    Object.assign(el.style, { font: '11px ui-monospace, monospace', color: INK, fontVariantNumeric: 'tabular-nums' });
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.set(x, Y, z);
    return o;
  }

  set opacity(v: number) {
    if (this.imageMat) this.imageMat.opacity = v;
  }

  get hasImage() {
    return this.imageMat !== null;
  }

  clear() {
    for (const g of [this.image, this.grid, this.compass]) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (o instanceof CSS2DObject) o.element.remove();
      });
      g.clear();
    }
    this.imageMat?.map?.dispose();
    this.imageMat?.dispose();
    this.imageMat = null;
  }
}
