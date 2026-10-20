import * as THREE from 'three/webgpu';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';

const EYE = 1.6;
const RADIUS = 0.25;
const SPEED = 1.6; // m/s, an unhurried indoor walk
const RUN = 3.2;
const GRAVITY = 30;
const STEPS = 5;

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
  private onFloor = false;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private dom: HTMLElement;
  private touchMove: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private touchLook: { id: number; x: number; y: number } | null = null;
  private abort = new AbortController();
  active = false;
  locked = false;

  /** A movement key or the touch stick is held. */
  get moving() {
    return this.active && (this.keys.size > 0 || this.touchMove !== null);
  }
  onLockChange?: (locked: boolean) => void;

  constructor(dom: HTMLElement, aspect: number) {
    this.dom = dom;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 200);
    this.camera.rotation.order = 'YXZ';
    this.bind();
  }

  setWorld(colliders: THREE.Object3D) {
    this.octree = new Octree();
    this.octree.fromGraphNode(colliders);
  }

  /** Plan position (x, z) of the walker's feet. */
  get position() {
    return { x: this.capsule.start.x, z: this.capsule.start.z };
  }

  /** Places the walker standing at plan point (x, z), looking toward (lx, lz). */
  place(x: number, z: number, lx: number, lz: number) {
    this.capsule.start.set(x, RADIUS + 0.01, z);
    this.capsule.end.set(x, EYE - 0.1, z);
    this.velocity.set(0, 0, 0);
    this.yaw = Math.atan2(-(lx - x), -(lz - z));
    this.pitch = -0.05;
    this.sync();
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
    this.octree = new Octree();
  }

  private bind() {
    const signal = this.abort.signal;
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      this.onLockChange?.(this.locked);
    }, { signal });
    let dragging = false;
    this.dom.addEventListener('mousedown', () => (dragging = true), { signal });
    document.addEventListener('mouseup', () => (dragging = false), { signal });
    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      if (this.locked) this.look(e.movementX, e.movementY, 0.0022);
      else if (dragging) this.look(e.movementX, e.movementY, 0.004);
    }, { signal });
    const key = (down: boolean) => (e: KeyboardEvent) => {
      if (!this.active) return;
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea, [contenteditable]')) return;
      if (down) this.keys.add(e.code);
      else this.keys.delete(e.code);
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

  private sync() {
    this.camera.position.copy(this.capsule.end).y += 0.1;
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  update(dt: number) {
    if (!this.active) return;
    dt = Math.min(dt, 0.05);
    const step = dt / STEPS;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    let mx = 0, mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    const s = this.stick;
    if (s) {
      mx += s.dx;
      mz -= s.dy;
    }
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN : SPEED;
    const wish = fwd.multiplyScalar(mz).add(right.multiplyScalar(mx));
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);

    for (let i = 0; i < STEPS; i++) {
      // Snappy ground control: steer horizontal velocity straight to the wish velocity.
      const k = this.onFloor ? Math.min(1, step * 14) : step * 2;
      this.velocity.x += (wish.x - this.velocity.x) * k;
      this.velocity.z += (wish.z - this.velocity.z) * k;
      if (!this.onFloor) this.velocity.y -= GRAVITY * step;
      this.capsule.translate(this.velocity.clone().multiplyScalar(step));
      const hit = this.octree.capsuleIntersect(this.capsule);
      this.onFloor = false;
      if (hit) {
        this.onFloor = hit.normal.y > 0.5;
        if (!this.onFloor) this.velocity.addScaledVector(hit.normal, -hit.normal.dot(this.velocity));
        else this.velocity.y = 0;
        if (hit.depth >= 1e-10) this.capsule.translate(hit.normal.multiplyScalar(hit.depth));
      }
    }
    // Fell out of the house (bad plan, open edge): put the walker back on the floor.
    if (this.capsule.start.y < -5) {
      this.capsule.translate(new THREE.Vector3(0, 6, 0));
      this.velocity.set(0, 0, 0);
    }
    this.sync();
  }
}
