import * as THREE from 'three/webgpu';
import type { Plan, Vec2, Wall, Opening } from '../plan/schema.ts';
import { withDefaults } from '../plan/schema.ts';
import { wallDir, wallLength, wallThickness, roomAt, pointSegment } from '../plan/geom.ts';
import { FURNITURE_DEFAULT_SIZE } from '../plan/furnitureSizes.ts';
import type { MaterialLibrary } from './materials.ts';

type MatFn = (key: string) => THREE.Material;

/**
 * Set dressing generated from the plan: the small things every lived-in room has and an empty
 * model lacks. Curtains and rods at exterior windows, radiators under windows, light switches
 * beside doors, framed art above beds, recessed ceiling downlights. Nothing here needs a JSON
 * entry; it follows the walls, openings and furniture so new plans get it for free.
 */
export function buildDressing(plan: Plan, lib: MaterialLibrary, mat: MatFn) {
  const d = withDefaults(plan);
  const group = new THREE.Group();
  group.name = 'dressing';
  const white = mat('skirting');
  const steel = mat('black-steel');

  const furnitureNear = (p: Vec2, r: number) =>
    (plan.furniture ?? []).some((f) => {
      if (f.type === 'rug' || f.type === 'plant' || f.type === 'floor-lamp') return false;
      const [w, dd] = f.size ?? FURNITURE_DEFAULT_SIZE[f.type] ?? [0.5, 0.5, 0.5];
      return Math.hypot(f.position[0] - p[0], f.position[1] - p[1]) < r + Math.max(w, dd) / 2;
    });

  for (const o of plan.openings ?? []) {
    const w = plan.walls.find((x) => x.id === o.wall);
    if (!w) continue;
    const frame = openingFrame(plan, w, o);
    if (!frame) continue;
    const { inward, along, mid, t } = frame;
    const isWindow = o.type === 'window' || o.type === 'sliding-door' || o.type === 'double-door';
    const L = wallLength(w);

    if (w.exterior && isWindow) {
      // Curtains: a pleated panel parked each side of the opening, hanging from a rod just
      // under the ceiling. Skipped where the wall ends or furniture stands in the way.
      const panelW = Math.max(0.45, Math.min(0.75, o.width * 0.35));
      const top = (d.wallHeight ?? 2.6) - 0.06;
      const face = t / 2 + 0.09;
      const rodHalf = o.width / 2 + panelW + 0.1;
      const room = rodHalf < Math.min(o.offset, L - o.offset) - 0.08;
      if (room) {
        const curtainMat = curtainMaterial(lib);
        for (const side of [-1, 1]) {
          const u = side * (o.width / 2 + panelW / 2 + 0.04);
          const c: Vec2 = [mid[0] + along[0] * u + inward[0] * face, mid[1] + along[1] * u + inward[1] * face];
          if (furnitureNear(c, 0.05)) continue;
          const panel = new THREE.Mesh(pleatedPanel(panelW, top - 0.02), curtainMat);
          panel.position.set(c[0], (top - 0.02) / 2 + 0.01, c[1]);
          panel.rotation.y = Math.atan2(-inward[0], -inward[1]);
          panel.castShadow = true;
          panel.receiveShadow = true;
          group.add(panel);
        }
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, rodHalf * 2, 24), steel);
        rod.rotation.z = Math.PI / 2;
        rod.rotation.y = Math.atan2(-inward[0], -inward[1]);
        rod.position.set(mid[0] + inward[0] * face, top + 0.02, mid[1] + inward[1] * face);
        rod.castShadow = true;
        group.add(rod);
      }

      // Panel radiator under windows with a real sill, unless a counter or bed is there.
      const sill = o.type === 'window' ? (o.sill ?? d.windowSill) : 0;
      const rp: Vec2 = [mid[0] + inward[0] * (t / 2 + 0.07), mid[1] + inward[1] * (t / 2 + 0.07)];
      if (sill >= 0.65 && !furnitureNear(rp, 0.15)) group.add(radiator(Math.min(1.2, o.width * 0.8), sill - 0.25, rp, inward, white));
    }

    if (o.type === 'door' || o.type === 'double-door' || o.type === 'opening') {
      // Light switch on the latch side of the door, both faces of the wall where a room is.
      const latch = o.hinge === 'end' ? -1 : 1;
      const u = latch * (o.width / 2 + 0.16);
      for (const s of [-1, 1]) {
        const n: Vec2 = [inward[0] * s, inward[1] * s];
        const at: Vec2 = [mid[0] + along[0] * u + n[0] * (t / 2 + 0.006), mid[1] + along[1] * u + n[1] * (t / 2 + 0.006)];
        if (!roomAt(plan, [at[0] + n[0] * 0.2, at[1] + n[1] * 0.2])) continue;
        const sw = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.012), white);
        sw.position.set(at[0], 1.05, at[1]);
        sw.rotation.y = Math.atan2(n[0], n[1]);
        group.add(sw);
        const rocker = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.006), white);
        rocker.position.set(at[0] + n[0] * 0.008, 1.05, at[1] + n[1] * 0.008);
        rocker.rotation.copy(sw.rotation);
        group.add(rocker);
      }
    }
  }

  // Framed art above each bed's headboard.
  let seed = 3;
  for (const f of plan.furniture ?? []) {
    if (f.type !== 'bed') continue;
    const [w, dd, h] = f.size ?? FURNITURE_DEFAULT_SIZE.bed;
    const rot = -THREE.MathUtils.degToRad(f.rotation ?? 0);
    // Local −z is the headboard side; find the wall just behind it.
    const back = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    const p = new THREE.Vector3(f.position[0], 0, f.position[1]).addScaledVector(back, dd / 2 + 0.01);
    const artW = Math.min(1.2, w * 0.7), artH = artW * 0.62;
    const art = framedArt(artW, artH, seed++, mat);
    art.position.set(p.x, Math.max(h, 0.9) + 0.35 + artH / 2, p.z);
    art.rotation.y = rot;
    // Hangs over the bed, so it leaves with the loose furniture.
    art.userData.loose = true;
    group.add(art);
  }

  // Recessed downlights: a slim white ring on each ceiling, laid out on a ~1.8 m grid.
  const ringGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.01, 40);
  const lensMat = mat('bulb');
  for (const r of plan.rooms ?? []) {
    const xs = r.polygon.map((q) => q[0]), ys = r.polygon.map((q) => q[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const nx = Math.max(1, Math.round((x1 - x0) / 1.8)), ny = Math.max(1, Math.round((y1 - y0) / 1.8));
    const h = (r.ceilingHeight ?? d.wallHeight) - 0.012;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const q: Vec2 = [x0 + ((i + 0.5) * (x1 - x0)) / nx, y0 + ((j + 0.5) * (y1 - y0)) / ny];
        if (roomAt(plan, q)?.id !== r.id) continue;
        if (plan.walls.some((wl) => pointSegment(q, wl.a, wl.b).d < 0.4)) continue;
        const ring = new THREE.Mesh(ringGeo, white);
        ring.position.set(q[0], h, q[1]);
        group.add(ring);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.04, 32), lensMat);
        lens.rotation.x = Math.PI / 2;
        lens.position.set(q[0], h - 0.006, q[1]);
        group.add(lens);
      }
  }
  return group;
}

function openingFrame(plan: Plan, w: Wall, o: Opening) {
  const along = wallDir(w);
  const t = wallThickness(plan, w);
  const mid: Vec2 = [w.a[0] + along[0] * o.offset, w.a[1] + along[1] * o.offset];
  for (const s of [1, -1]) {
    const n: Vec2 = [-along[1] * s, along[0] * s];
    if (roomAt(plan, [mid[0] + n[0] * (t / 2 + 0.2), mid[1] + n[1] * (t / 2 + 0.2)])) return { inward: n, along, mid, t };
  }
  return null;
}

let curtainMat: THREE.MeshPhysicalMaterial | null = null;
function curtainMaterial(lib: MaterialLibrary) {
  if (curtainMat) return curtainMat;
  const base = lib.get('linen');
  // Light linen, seen from both sides, with a soft sheen and a little light passing through.
  curtainMat = new THREE.MeshPhysicalMaterial({
    color: '#efe9df',
    roughness: 1,
    sheen: 0.8,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color('#ffffff'),
    side: THREE.DoubleSide,
    normalMap: base.normalMap ?? null,
    specularIntensity: 0.15,
  });
  return curtainMat;
}

/** A hanging fabric panel with deep vertical pleats that soften toward the hem. */
function pleatedPanel(w: number, h: number) {
  const g = new THREE.PlaneGeometry(w, h, 64, 24);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const v = (y + h / 2) / h; // 0 hem, 1 top
    const pleat = Math.sin((x / 0.11) * Math.PI * 2) * 0.035 + Math.sin((x / 0.37) * Math.PI * 2 + 1.3) * 0.012;
    // Pleats are gathered tight at the rod and relax toward the floor.
    pos.setZ(i, pleat * (0.75 + 0.25 * v) + (1 - v) * 0.01 * Math.sin(x * 9));
  }
  g.computeVertexNormals();
  return g;
}

function radiator(w: number, h: number, p: Vec2, inward: Vec2, mat: THREE.Material) {
  const g = new THREE.Group();
  const ribs = Math.round(w / 0.05);
  for (let i = 0; i < ribs; i++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.035, h, 0.06), mat);
    rib.position.set(-w / 2 + (i + 0.5) * (w / ribs), 0.15 + h / 2, 0);
    rib.castShadow = rib.receiveShadow = true;
    g.add(rib);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, 0.07), mat);
  top.position.set(0, 0.15 + h + 0.006, 0);
  g.add(top);
  for (const s of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.15, 12), mat);
    pipe.position.set(s * (w / 2 - 0.05), 0.075, 0);
    g.add(pipe);
  }
  g.position.set(p[0], 0, p[1]);
  g.rotation.y = Math.atan2(inward[0], inward[1]);
  return g;
}

/** A thin black frame, white mount and a soft abstract print drawn on a canvas. */
function framedArt(w: number, h: number, seed: number, mat: MatFn) {
  const g = new THREE.Group();
  const frameMat = mat('black-steel');
  const fw = 0.022, depth = 0.03;
  for (const [sx, sy, bw, bh] of [[0, h / 2, w, fw], [0, -h / 2, w, fw], [-w / 2, 0, fw, h], [w / 2, 0, fw, h]] as const) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw + (bw > fw ? fw : 0), bh, depth), frameMat);
    b.position.set(sx, sy, depth / 2);
    b.castShadow = true;
    g.add(b);
  }
  const mount = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: '#f3f0ea', roughness: 0.95 }));
  mount.position.z = 0.004;
  g.add(mount);
  // 8 mm proud of the mount: at 2 mm the depth test lost the print to the mount beyond a few meters.
  const print = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, h * 0.7), new THREE.MeshStandardMaterial({ map: abstractPrint(seed), roughness: 0.9 }));
  print.position.z = 0.012;
  g.add(print);
  return g;
}

function abstractPrint(seed: number) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 360;
  const x = c.getContext('2d')!;
  let s = seed * 9301 + 49297;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const palettes = [
    ['#e9e1d3', '#c9785a', '#2f3b46', '#d9b48f'],
    ['#ece6dc', '#7d8b74', '#c2a77c', '#3b3a36'],
    ['#efe9e0', '#a9b7c0', '#c48f6a', '#535b5f'],
  ];
  const pal = palettes[seed % palettes.length];
  x.fillStyle = pal[0];
  x.fillRect(0, 0, 512, 360);
  // Soft colour fields with torn edges, like a contemporary print.
  for (let i = 0; i < 5; i++) {
    x.fillStyle = pal[1 + (i % 3)];
    x.globalAlpha = 0.55 + rnd() * 0.35;
    x.beginPath();
    const cx = 80 + rnd() * 350, cy = 60 + rnd() * 240, r = 50 + rnd() * 110;
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.15) {
      const rr = r * (0.85 + rnd() * 0.25);
      x.lineTo(cx + Math.cos(a) * rr * 1.2, cy + Math.sin(a) * rr * 0.8);
    }
    x.fill();
  }
  x.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
