import * as THREE from 'three/webgpu';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Plan } from '../plan/schema.ts';
import { planBounds } from '../plan/geom.ts';

// Just under the 1.2 m cut so the clip plane keeps it; depthTest is off, so it still draws on top.
const Y = 1.15;

/**
 * Plan-view helpers: the source image placed at its calibrated scale, and a
 * meter grid with coordinate labels. The agent screenshots this to check its
 * traced walls against the drawing and to read coordinates off the grid.
 */
export class PlanOverlay {
  readonly group = new THREE.Group();
  readonly image = new THREE.Group();
  readonly grid = new THREE.Group();
  private imageMat: THREE.MeshBasicMaterial | null = null;

  constructor() {
    this.group.name = 'plan-overlay';
    this.group.add(this.image, this.grid);
    this.group.visible = false;
  }

  async build(plan: Plan, imageUrl: string | undefined) {
    this.clear();
    const b = planBounds(plan);
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
    // Grid from one meter outside the walls, 0.5 m minor and 1 m major lines.
    const x0 = Math.floor(b.minX) - 1, x1 = Math.ceil(b.maxX) + 1;
    const z0 = Math.floor(b.minY) - 1, z1 = Math.ceil(b.maxY) + 1;
    const minor: number[] = [], major: number[] = [];
    for (let x = x0; x <= x1 + 1e-6; x += 0.5) (Number.isInteger(x) ? major : minor).push(x, Y + 0.01, z0, x, Y + 0.01, z1);
    for (let z = z0; z <= z1 + 1e-6; z += 0.5) (Number.isInteger(z) ? major : minor).push(x0, Y + 0.01, z, x1, Y + 0.01, z);
    const line = (pts: number[], color: string, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, toneMapped: false }));
      l.renderOrder = 11;
      return l;
    };
    this.grid.add(line(minor, '#c2410c', 0.18), line(major, '#c2410c', 0.45));
    for (let x = x0; x <= x1; x++) this.grid.add(this.label(String(x), x, z0 - 0.3));
    for (let z = z0; z <= z1; z++) this.grid.add(this.label(String(z), x0 - 0.35, z));
  }

  private label(text: string, x: number, z: number) {
    const el = document.createElement('div');
    el.className = 'grid-label';
    Object.assign(el.style, { font: '11px ui-monospace, monospace', color: '#c2410c', fontVariantNumeric: 'tabular-nums' });
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
    for (const g of [this.image, this.grid]) {
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
