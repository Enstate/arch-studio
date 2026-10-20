import * as THREE from 'three/webgpu';
import type { Plan, Opening, Wall, Vec2 } from '../plan/schema.ts';
import { withDefaults } from '../plan/schema.ts';
import { wallDir, wallThickness, roomAt } from '../plan/geom.ts';

type MatFn = (key: string) => THREE.Material;

const FRAME = 0.06; // window frame profile
const CASING = 0.07; // door architrave width
const CASING_PROUD = 0.012;

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Same local frame as the wall builder: +x along a→b, +z to the right. */
function frameFor(w: Wall, offset: number) {
  const d = wallDir(w);
  const g = new THREE.Group();
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(d[0], 0, d[1]),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(-d[1], 0, d[0]),
  );
  m.setPosition(w.a[0] + d[0] * offset, 0, w.a[1] + d[1] * offset);
  g.applyMatrix4(m);
  return g;
}

/** Which local side (+1 right / −1 left) faces the inside of the house, or 0 for interior walls. */
function insideSide(plan: Plan, w: Wall, offset: number): -1 | 0 | 1 {
  if (!w.exterior) return 0;
  const d = wallDir(w);
  const t = wallThickness(plan, w);
  const p: Vec2 = [w.a[0] + d[0] * offset - d[1] * (t / 2 + 0.1), w.a[1] + d[1] * offset + d[0] * (t / 2 + 0.1)];
  return roomAt(plan, p) ? 1 : -1;
}

function addCasings(g: THREE.Group, width: number, height: number, t: number, mat: THREE.Material, sides: number[]) {
  for (const s of sides) {
    const z = s * (t / 2 + CASING_PROUD / 2);
    g.add(box(CASING, height + CASING, CASING_PROUD, mat, -width / 2 - CASING / 2, (height + CASING) / 2, z));
    g.add(box(CASING, height + CASING, CASING_PROUD, mat, width / 2 + CASING / 2, (height + CASING) / 2, z));
    g.add(box(width + CASING * 2, CASING, CASING_PROUD, mat, 0, height + CASING / 2, z));
  }
}

function addLining(g: THREE.Group, width: number, height: number, t: number, mat: THREE.Material) {
  const lt = 0.018;
  g.add(box(lt, height, t + 0.004, mat, -width / 2 + lt / 2, height / 2, 0));
  g.add(box(lt, height, t + 0.004, mat, width / 2 - lt / 2, height / 2, 0));
  g.add(box(width, lt, t + 0.004, mat, 0, height - lt / 2, 0));
}

// Created per build: the renderer hooks a dispose listener into every material it draws, so a
// module-level material would keep each unmounted viewer's renderer alive.
let panelLine: THREE.Material;

function doorLeaf(width: number, height: number, mat: THREE.Material, handle: THREE.Material) {
  const leaf = new THREE.Group();
  const th = 0.04;
  // Leaf geometry starts at the hinge (x = 0) and runs to +x.
  leaf.add(box(width, height, th, mat, width / 2, height / 2, 0));
  // Recessed panel lines give the leaf some depth without a texture.
  const line = panelLine;
  for (const s of [-1, 1]) {
    const z = s * (th / 2 + 0.0005);
    leaf.add(box(width - 0.2, 0.004, 0.001, line, width / 2, height * 0.55, z));
  }
  for (const s of [-1, 1]) {
    const z = s * (th / 2 + 0.025);
    const lever = box(0.13, 0.018, 0.018, handle, width - 0.14, 1.05, z);
    leaf.add(lever);
    leaf.add(box(0.03, 0.05, 0.03, handle, width - 0.075, 1.05, s * (th / 2 + 0.012)));
  }
  return leaf;
}

function buildDoor(plan: Plan, o: Opening, w: Wall, mat: MatFn, double: boolean) {
  const d = withDefaults(plan);
  const t = wallThickness(plan, w);
  const g = frameFor(w, o.offset);
  const h = o.height ?? d.doorHeight;
  const trim = mat(o.frame ?? 'door-white');
  const inside = insideSide(plan, w, o.offset);
  addLining(g, o.width, h, t, trim);
  addCasings(g, o.width, h, t, trim, inside === 0 ? [-1, 1] : [inside]);

  const swingZ = o.swing === 'left' ? -1 : 1;
  const angle = THREE.MathUtils.degToRad(o.openAngle ?? 75);
  const clear = o.width - 0.036;
  const leafH = h - 0.02;
  const leafMat = mat(o.frame ?? 'door-white');
  const handle = mat('chrome');
  const leaves: { hingeX: number; dir: 1 | -1; w: number }[] = double
    ? [{ hingeX: -clear / 2, dir: 1, w: clear / 2 - 0.002 }, { hingeX: clear / 2, dir: -1, w: clear / 2 - 0.002 }]
    : [{ hingeX: o.hinge === 'end' ? clear / 2 : -clear / 2, dir: o.hinge === 'end' ? -1 : 1, w: clear }];
  for (const l of leaves) {
    const pivot = new THREE.Group();
    pivot.position.set(l.hingeX, 0.005, swingZ * (t / 2 - 0.025));
    const leaf = doorLeaf(l.w, leafH, leafMat, handle);
    if (l.dir === -1) leaf.scale.x = -1;
    pivot.add(leaf);
    // Positive rotation.y turns +x toward −z. Mirror for leaves that run −x or swing to +z.
    pivot.rotation.y = angle * l.dir * (swingZ === -1 ? 1 : -1);
    pivot.userData = { kind: 'door-leaf', dynamic: true, open: pivot.rotation.y, closed: 0 };
    g.add(pivot);
  }
  return g;
}

function buildWindow(plan: Plan, o: Opening, w: Wall, mat: MatFn, sliding: boolean) {
  const d = withDefaults(plan);
  const t = wallThickness(plan, w);
  const g = frameFor(w, o.offset);
  const isDoor = sliding;
  const sill = isDoor ? 0 : (o.sill ?? d.windowSill);
  const h = o.height ?? (isDoor ? 2.25 : d.windowHeight);
  const inside = insideSide(plan, w, o.offset) || 1;
  const frameMat = mat(o.frame ?? 'frame-anthracite');
  const glass = mat('glass');
  const reveal = mat('paint-white');
  // Frames sit about a third into the wall from the outside, as in insulated masonry.
  const zf = -inside * (t / 2 - Math.min(0.12, t * 0.35));
  const W = o.width, y0 = sill, y1 = sill + h;
  const fd = 0.07;
  g.add(box(W, FRAME, fd, frameMat, 0, y0 + FRAME / 2, zf));
  g.add(box(W, FRAME, fd, frameMat, 0, y1 - FRAME / 2, zf));
  g.add(box(FRAME, h, fd, frameMat, -W / 2 + FRAME / 2, (y0 + y1) / 2, zf));
  g.add(box(FRAME, h, fd, frameMat, W / 2 - FRAME / 2, (y0 + y1) / 2, zf));

  const panes = sliding ? 2 : W > 1.3 ? 2 : 1;
  const innerW = W - FRAME * 2;
  for (let i = 0; i < panes; i++) {
    const pw = innerW / panes;
    const cx = -innerW / 2 + pw * (i + 0.5);
    // Sliding panels overlap on two tracks, one slid partly open.
    const zt = sliding ? zf + (i === 0 ? -0.018 : 0.018) : zf;
    const slide = sliding && i === 1 ? -pw * 0.45 : 0;
    const sash = new THREE.Group();
    sash.position.set(cx + slide, 0, zt);
    if (slide) sash.userData = { kind: 'door-slide', dynamic: true, open: cx + slide, closed: cx };
    const sw = sliding ? pw + 0.03 : pw;
    const sf = 0.05;
    sash.add(box(sw, sf, 0.045, frameMat, 0, y0 + FRAME + sf / 2, 0));
    sash.add(box(sw, sf, 0.045, frameMat, 0, y1 - FRAME - sf / 2, 0));
    sash.add(box(sf, h - FRAME * 2, 0.045, frameMat, -sw / 2 + sf / 2, (y0 + y1) / 2, 0));
    sash.add(box(sf, h - FRAME * 2, 0.045, frameMat, sw / 2 - sf / 2, (y0 + y1) / 2, 0));
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(sw - sf * 2, h - FRAME * 2 - sf * 2), glass);
    pane.position.set(0, (y0 + y1) / 2, 0);
    pane.userData.kind = 'glass';
    sash.add(pane);
    if (!sliding) sash.add(box(0.02, 0.12, 0.03, mat('chrome'), sw / 2 - sf - 0.03, (y0 + y1) / 2, inside * 0.035));
    g.add(sash);
  }

  if (!isDoor) {
    // Interior window board and exterior sill.
    const boardDepth = Math.max(0.05, t / 2 + 0.03 - zf * inside);
    g.add(box(W + 0.04, 0.025, boardDepth, reveal, 0, y0 - 0.0125, inside * (t / 2 + 0.03 - boardDepth / 2)));
    if (w.exterior) {
      const outDepth = t / 2 + 0.05 + zf * inside;
      g.add(box(W + 0.06, 0.02, outDepth, mat('frame-anthracite'), 0, y0 - 0.03, -inside * (t / 2 + 0.05 - outDepth / 2)));
    }
  }
  return g;
}

function buildGarageDoor(plan: Plan, o: Opening, w: Wall, mat: MatFn) {
  const t = wallThickness(plan, w);
  const g = frameFor(w, o.offset);
  const h = o.height ?? 2.2;
  const panel = mat(o.frame ?? 'frame-anthracite');
  const n = 5;
  for (let i = 0; i < n; i++) g.add(box(o.width - 0.02, h / n - 0.008, 0.04, panel, 0, (h / n) * (i + 0.5), 0));
  void t;
  return g;
}

export function buildOpenings(plan: Plan, mat: MatFn) {
  panelLine = new THREE.MeshStandardMaterial({ color: '#000000', transparent: true, opacity: 0.08 });
  const group = new THREE.Group();
  group.name = 'openings';
  for (const o of plan.openings ?? []) {
    const w = plan.walls.find((x) => x.id === o.wall);
    if (!w) continue;
    let g: THREE.Group | null = null;
    if (o.type === 'door') g = buildDoor(plan, o, w, mat, false);
    else if (o.type === 'double-door') g = buildDoor(plan, o, w, mat, true);
    else if (o.type === 'window') g = buildWindow(plan, o, w, mat, false);
    else if (o.type === 'sliding-door') g = buildWindow(plan, o, w, mat, true);
    else if (o.type === 'garage-door') g = buildGarageDoor(plan, o, w, mat);
    else if (o.type === 'opening') {
      g = frameFor(w, o.offset);
      addLining(g, o.width, o.height ?? withDefaults(plan).doorHeight, wallThickness(plan, w), mat('paint-white'));
    }
    if (g) {
      g.userData = { kind: 'opening', id: o.id };
      group.add(g);
    }
  }
  return group;
}
