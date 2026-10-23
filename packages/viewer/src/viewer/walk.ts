import * as THREE from 'three/webgpu';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';

const EYE = 1.6;
const RADIUS = 0.25;
const SPEED = 1.6; // m/s, an unhurried indoor walk
const RUN = 3.2;
const GRAVITY = 30;
const STEPS = 5;
const STEP_HEIGHT = 0.35;
const JUMP_SPEED = 5.5;
const SKIN = 0.001;
const CLEARANCE = 0.00001;
const EMPTY_BLOCKERS: THREE.Box3[] = [];
/** Smallest collision cell worth dividing, about the walker's radius: finer cells speed up nothing. */
const MIN_CELL = 0.25;

/**
 * Octree over every collider triangle. three's own split keeps dividing a cell while it holds more
 * than 8 triangles, so faces that lie on top of each other, such as a stair modelled as nested boxes,
 * never thin out and the tree grows fourfold per level until the page runs out of memory. Here a
 * cell stops dividing once dividing no longer separates its triangles or the cell is about the
 * walker's size, and the tree has a budget.
 */
export function colliderTree(colliders: THREE.Object3D) {
  const tree = new Octree();
  // Collect the triangles only; the split below replaces Octree.build.
  tree.build = () => tree;
  tree.fromGraphNode(colliders);
  delete (tree as Partial<Octree>).build;
  if (!tree.triangles.length) return tree;
  tree.calcBox();
  let budget = Math.max(200_000, tree.triangles.length * 16);
  const half = new THREE.Vector3();
  const corner = new THREE.Vector3();
  const split = (node: Octree, level: number) => {
    const box = node.box!;
    half.subVectors(box.max, box.min).multiplyScalar(0.5);
    const cells: Octree[] = [];
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
      const cell = new THREE.Box3();
      cell.min.copy(box.min).add(corner.set(x, y, z).multiply(half));
      cell.max.copy(cell.min).add(half);
      cells.push(new Octree(cell));
    }
    for (const triangle of node.triangles) for (const cell of cells) if (cell.box!.intersectsTriangle(triangle)) cell.triangles.push(triangle);
    const held = node.triangles.length;
    node.triangles = [];
    for (const cell of cells) {
      const count = cell.triangles.length;
      if (!count) continue;
      budget -= count;
      node.subTrees.push(cell);
      const { min, max } = cell.box!;
      const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
      if (count > cell.trianglesPerLeaf && count < held && size > MIN_CELL && level < cell.maxLevel && budget > 0) split(cell, level + 1);
    }
  };
  split(tree, 0);
  return tree;
}

/**
 * First-person walker: capsule against an octree of the house, mouse look
 * with pointer lock on desktop, left-thumb move and right-thumb look on touch.
 * Based on three.js examples/games_fps.html.
 */
export class Walker {
  readonly camera: THREE.PerspectiveCamera;
  private octree = new Octree();
  private capsule = new Capsule(new THREE.Vector3(0, RADIUS, 0), new THREE.Vector3(0, EYE - 0.1, 0), RADIUS);
  private velocity = new THREE.Vector3();
  private wish = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private heading = new THREE.Vector3();
  private stepNormal = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private contact = new THREE.Vector3();
  private candidate = new Capsule();
  private floorRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  private supportRay = new THREE.Ray();
  private onFloor = false;
  /** Last point the walker stood on a floor, or the last placement; `y` is the floor height. */
  private safe = { x: 0, y: 0, z: 0 };
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private dom: HTMLElement;
  private touchMove: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private touchLook: { id: number; x: number; y: number } | null = null;
  private abort = new AbortController();
  private lockChangedAt = -Infinity;
  active = false;
  locked = false;

  /** Walking input is held, or the walker is airborne. */
  get moving() {
    return this.active && (this.keys.size > 0 || this.touchMove !== null || !this.onFloor);
  }
  onLockChange?: (locked: boolean) => void;

  constructor(dom: HTMLElement, aspect: number) {
    this.dom = dom;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.bind();
  }

  private worlds = new Map<THREE.Object3D, Octree>();

  /** Octrees are cached per collider group, so switching back and forth is free. */
  setWorld(colliders: THREE.Object3D) {
    let o = this.worlds.get(colliders);
    if (!o) {
      o = colliderTree(colliders);
      this.worlds.set(colliders, o);
    }
    this.octree = o;
    this.onFloor = false;
    this.stepNormal.set(0, 0, 0);
    this.velocity.y = 0;
  }

  /** Plan position (x, z) of the walker's feet, and their height `y`. */
  get position() {
    return { x: this.capsule.start.x, y: this.capsule.start.y - RADIUS, z: this.capsule.start.z };
  }

  /** Places the walker standing at plan point (x, z) on the floor at height `y`, looking toward (lx, lz). */
  place(x: number, z: number, lx: number, lz: number, y = 0) {
    this.capsule.start.set(x, y + RADIUS + 0.01, z);
    this.capsule.end.set(x, y + EYE - 0.1, z);
    this.velocity.set(0, 0, 0);
    this.heading.set(0, 0, 0);
    this.stepNormal.set(0, 0, 0);
    this.onFloor = false;
    this.safe = { x, y, z };
    this.yaw = Math.atan2(-(lx - x), -(lz - z));
    this.pitch = -0.05;
    this.sync();
  }

  /** One grounded jump. Holding a button cannot queue another jump on landing. */
  jump() {
    if (!this.active || !this.onFloor) return false;
    this.velocity.y = JUMP_SPEED;
    this.onFloor = false;
    this.stepNormal.set(0, 0, 0);
    return true;
  }

  lock() {
    if (matchMedia('(pointer: coarse)').matches) return;
    // Embedded previews and some iframes refuse pointer lock; drag-to-look still works there.
    try {
      const p = this.dom.requestPointerLock?.() as unknown as Promise<void> | undefined;
      p?.catch?.(() => undefined);
    } catch {
      /* drag-to-look fallback */
    }
  }

  unlock() {
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  dispose() {
    this.unlock();
    this.abort.abort();
    this.worlds.clear();
    this.octree = new Octree();
  }

  private bind() {
    const signal = this.abort.signal;
    document.addEventListener('pointerlockchange', () => {
      this.lockChangedAt = performance.now();
      // The dollhouse's free look also captures the mouse; only a walk lock is the walker's.
      this.locked = this.active && document.pointerLockElement === this.dom;
      this.onLockChange?.(this.locked);
    }, { signal });
    let dragging = false;
    this.dom.addEventListener('mousedown', () => (dragging = true), { signal });
    document.addEventListener('mouseup', () => (dragging = false), { signal });
    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      // Chromium reports one bogus jump to or from the window centre when the mouse is captured.
      if (performance.now() - this.lockChangedAt < 60 || Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
      if (this.locked) this.look(e.movementX, e.movementY, 0.0022);
      else if (dragging) this.look(e.movementX, e.movementY, 0.004);
    }, { signal });
    const key = (down: boolean) => (e: KeyboardEvent) => {
      // Release even if focus or walk mode changed while the key was held.
      if (!down) this.keys.delete(e.code);
      if (!this.active) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, select, textarea, [contenteditable]')) return;
      if (e.code === 'Space') {
        if (target?.closest?.('button, a, [role=button]')) return;
        e.preventDefault();
        if (down && !e.repeat && !this.keys.has(e.code)) this.jump();
      }
      if (down) this.keys.add(e.code);
    };
    document.addEventListener('keydown', key(true), { signal });
    document.addEventListener('keyup', key(false), { signal });
    window.addEventListener('blur', () => this.keys.clear(), { signal });

    this.dom.addEventListener('touchstart', (e) => {
      if (!this.active) return;
      for (const t of Array.from(e.changedTouches)) {
        const left = t.clientX < this.dom.clientWidth / 2;
        if (left && !this.touchMove) this.touchMove = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY };
        else if (!left && !this.touchLook) this.touchLook = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
      e.preventDefault();
    }, { passive: false, signal });
    this.dom.addEventListener('touchmove', (e) => {
      if (!this.active) return;
      for (const t of Array.from(e.changedTouches)) {
        if (this.touchMove?.id === t.identifier) {
          this.touchMove.x = t.clientX;
          this.touchMove.y = t.clientY;
        } else if (this.touchLook?.id === t.identifier) {
          this.look(t.clientX - this.touchLook.x, t.clientY - this.touchLook.y, 0.005);
          this.touchLook.x = t.clientX;
          this.touchLook.y = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false, signal });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.touchMove?.id === t.identifier) this.touchMove = null;
        if (this.touchLook?.id === t.identifier) this.touchLook = null;
      }
    };
    this.dom.addEventListener('touchend', end, { signal });
    this.dom.addEventListener('touchcancel', end, { signal });
  }

  /** Touch joystick offset in −1..1, for drawing the thumb indicator. */
  get stick() {
    if (!this.touchMove) return null;
    const max = 50;
    return {
      x0: this.touchMove.x0, y0: this.touchMove.y0,
      dx: THREE.MathUtils.clamp((this.touchMove.x - this.touchMove.x0) / max, -1, 1),
      dy: THREE.MathUtils.clamp((this.touchMove.y - this.touchMove.y0) / max, -1, 1),
    };
  }

  private look(dx: number, dy: number, k: number) {
    this.yaw -= dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k, -1.35, 1.35);
  }

  /** Boxes outside the octree that block the walker, such as closed doors. */
  blockers: () => THREE.Box3[] = () => EMPTY_BLOCKERS;

  /** Pushes the capsule (a vertical segment of RADIUS) horizontally out of each box it overlaps. */
  private pushOutOf(boxes: THREE.Box3[]) {
    const c = this.capsule;
    let moved = false;
    for (const b of boxes) {
      if (c.end.y + RADIUS < b.min.y || c.start.y - RADIUS > b.max.y) continue;
      const x = c.start.x, z = c.start.z;
      let nx = x - THREE.MathUtils.clamp(x, b.min.x, b.max.x), nz = z - THREE.MathUtils.clamp(z, b.min.z, b.max.z);
      let d = Math.hypot(nx, nz);
      if (d >= RADIUS) continue;
      let push: number;
      if (d > 1e-6) {
        nx /= d;
        nz /= d;
        push = RADIUS - d;
      } else {
        // Centre inside the box: leave by the nearest face.
        d = x - b.min.x;
        nx = -1;
        nz = 0;
        if (b.max.x - x < d) { d = b.max.x - x; nx = 1; }
        if (z - b.min.z < d) { d = z - b.min.z; nx = 0; nz = -1; }
        if (b.max.z - z < d) { d = b.max.z - z; nx = 0; nz = 1; }
        push = d + RADIUS;
      }
      c.translate(this.offset.set(nx * push, 0, nz * push));
      moved = true;
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= into * nx;
        this.velocity.z -= into * nz;
      }
    }
    return moved;
  }

  private sync(dt = 0) {
    const target = this.capsule.end.y + 0.1;
    this.camera.position.x = this.capsule.end.x;
    this.camera.position.z = this.capsule.end.z;
    this.camera.position.y = dt > 0
      ? Math.min(this.camera.position.y + (target - this.camera.position.y) * (1 - Math.exp(-20 * dt)), this.capsule.end.y + RADIUS - 0.05)
      : target;
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private floorHeight(x: number, z: number, feet: number) {
    this.floorRay.origin.set(x, feet + STEP_HEIGHT + SKIN, z);
    const hit = this.octree.rayIntersect(this.floorRay);
    if (!hit || hit.position.y < feet - STEP_HEIGHT - SKIN) return -Infinity;
    if (hit.triangle.getNormal(this.normal).y <= 0.5) return -Infinity;
    return hit.position.y;
  }

  private capsuleClearance(capsule: Capsule, boxes: THREE.Box3[]) {
    for (const b of boxes) {
      if (capsule.end.y + RADIUS <= b.min.y || capsule.start.y - RADIUS >= b.max.y) continue;
      const dx = capsule.start.x - THREE.MathUtils.clamp(capsule.start.x, b.min.x, b.max.x);
      const dz = capsule.start.z - THREE.MathUtils.clamp(capsule.start.z, b.min.z, b.max.z);
      if (dx * dx + dz * dz < RADIUS * RADIUS - CLEARANCE) return false;
    }
    const hit = this.octree.capsuleIntersect(capsule);
    return !hit || hit.depth <= CLEARANCE;
  }

  /** Support the front of the foot at a riser, without moving the body through it. */
  private stepFloor(boxes: THREE.Box3[], previousX: number, previousZ: number, blockingNormal?: THREE.Vector3) {
    const c = this.capsule;
    const feet = c.start.y - RADIUS;
    // Keep the contact direction while the foot crosses the lip, after the
    // lifted capsule has stopped touching the riser but still needs support.
    if (blockingNormal) this.stepNormal.copy(blockingNormal);
    const center = this.floorHeight(c.start.x, c.start.z, feet);
    let floor = center;
    if (this.heading.lengthSq() > 0) {
      const reach = RADIUS + 0.05;
      for (let probe = 0; probe < 2; probe++) {
        let dx = this.heading.x, dz = this.heading.z;
        if (probe === 1) {
          if (dx * this.stepNormal.x + dz * this.stepNormal.z >= 0) break;
          // At oblique risers the heading probe cannot reach past the capsule
          // radius. Also look directly into the actual blocking contact.
          const length = Math.hypot(this.stepNormal.x, this.stepNormal.z);
          if (length <= CLEARANCE) break;
          dx = -this.stepNormal.x / length;
          dz = -this.stepNormal.z / length;
        }
        const front = this.floorHeight(c.start.x + dx * reach, c.start.z + dz * reach, feet);
        if (front > floor) {
          // A floor behind a wall or closed door cannot support the front foot.
          this.supportRay.origin.set(c.start.x, front + RADIUS + SKIN, c.start.z);
          this.supportRay.direction.set(dx, 0, dz);
          const hit = this.octree.rayIntersect(this.supportRay);
          let blocked = !!hit && hit.distance < reach;
          for (const b of boxes) {
            if (this.supportRay.intersectBox(b, this.contact) && this.contact.distanceTo(this.supportRay.origin) < reach) blocked = true;
          }
          if (!blocked) floor = front;
        }
      }
    }
    if (!blockingNormal && floor <= center + SKIN) this.stepNormal.set(0, 0, 0);
    const rise = floor + SKIN - feet;
    if (!Number.isFinite(floor) || Math.abs(rise) > STEP_HEIGHT + SKIN) return false;
    if (rise > SKIN) {
      // Lift at the previous, unpenetrated position first. Check the whole head
      // path, including thin beams, before accepting the horizontal movement.
      const lifts = Math.ceil(rise / 0.1);
      for (let i = 1; i <= lifts; i++) {
        this.candidate.copy(c).translate(this.offset.set(previousX - c.start.x, rise * i / lifts, previousZ - c.start.z));
        if (!this.capsuleClearance(this.candidate, boxes)) return false;
      }
    }
    this.candidate.copy(c).translate(this.offset.set(0, rise, 0));
    if (!this.capsuleClearance(this.candidate, boxes)) return false;
    c.copy(this.candidate);
    this.velocity.y = 0;
    return true;
  }

  update(dt: number) {
    if (!this.active) return;
    dt = Math.min(dt, 0.05);
    const step = dt / STEPS;
    let mx = 0, mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.touchMove) {
      mx += THREE.MathUtils.clamp((this.touchMove.x - this.touchMove.x0) / 50, -1, 1);
      mz -= THREE.MathUtils.clamp((this.touchMove.y - this.touchMove.y0) / 50, -1, 1);
    }
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN : SPEED;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wish = this.wish.set(-sin * mz + cos * mx, 0, -cos * mz - sin * mx);
    if (wish.lengthSq() > 1) wish.normalize();
    if (wish.lengthSq() > 0) this.heading.copy(wish).normalize();
    wish.multiplyScalar(speed);

    const blockers = this.blockers();
    // Doors can close around a resting walker. Check them even when the static
    // world needs no physics work, and wake collision resolution if they push.
    const pushed = this.pushOutOf(blockers);
    if (!pushed && this.onFloor && wish.lengthSq() === 0 && this.velocity.lengthSq() < 0.000001) {
      this.velocity.set(0, 0, 0);
      this.sync(dt);
      return;
    }
    for (let i = 0; i < STEPS; i++) {
      // Snappy ground control: steer horizontal velocity straight to the wish velocity.
      const k = this.onFloor ? Math.min(1, step * 14) : step * 2;
      this.velocity.x += (wish.x - this.velocity.x) * k;
      this.velocity.z += (wish.z - this.velocity.z) * k;
      const grounded = this.onFloor;
      if (!grounded) this.velocity.y -= GRAVITY * step;
      const previousX = this.capsule.start.x, previousZ = this.capsule.start.z;
      this.capsule.translate(this.offset.copy(this.velocity).multiplyScalar(step));
      this.onFloor = false;
      const hit = this.octree.capsuleIntersect(this.capsule);
      if (hit && hit.depth > CLEARANCE) {
        if (hit.normal.y > 0.5 && this.velocity.y <= 0) {
          this.onFloor = true;
          this.velocity.y = 0;
        } else {
          const into = hit.normal.dot(this.velocity);
          if (into < 0) this.velocity.addScaledVector(hit.normal, -into);
        }
        this.capsule.translate(this.offset.copy(hit.normal).multiplyScalar(hit.depth));
      }
      this.pushOutOf(blockers);
      // Floor support must use the resolved body, not a tiny overlap from
      // walking into a wall or door. Otherwise contact would cancel a jump.
      if (grounded && this.velocity.y <= 0) {
        this.onFloor = this.stepFloor(blockers, previousX, previousZ,
          hit && hit.depth > CLEARANCE && hit.normal.y <= 0.5 ? hit.normal : undefined);
      }
      if (this.onFloor) {
        this.safe.x = this.capsule.start.x;
        this.safe.y = this.capsule.start.y - RADIUS;
        this.safe.z = this.capsule.start.z;
      } else {
        this.stepNormal.set(0, 0, 0);
      }
    }
    // Fell out of the house (bad plan, open edge): return to the last floor spot, keeping the view.
    // Terrain may lie lower than a house's floor, so the limit follows the lowest surface of the world.
    if (this.capsule.start.y < Math.min(-5, this.octree.bounds.min.y - 1)) {
      const { yaw, pitch } = this;
      const { x, y, z } = this.safe;
      this.place(x, z, x - Math.sin(yaw), z - Math.cos(yaw), y);
      this.pitch = pitch;
    }
    this.sync(dt);
  }
}
