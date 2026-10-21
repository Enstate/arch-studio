import * as THREE from 'three/webgpu';

/** How high a held piece floats, in metres. */
const LIFT = 0.14;
/** Lean per metre a second of drag speed, in radians, and the most it leans. */
const LEAN = 0.045, MAX_LEAN = 0.16;

/** A damped spring toward `to`; light damping overshoots a little, which reads as a wobble. */
function spring(state: { x: number; v: number }, to: number, dt: number, stiffness: number, damping: number) {
  state.v += ((to - state.x) * stiffness - state.v * damping) * dt;
  state.x += state.v * dt;
}

/**
 * The motion of a piece someone picks up: it lifts off the floor, follows the pointer a touch
 * behind, leans against the way it moves and wobbles as it settles, then drops back onto the floor.
 * `target` is where it stands in plan, `lifted` whether it is held.
 */
export class Carry {
  readonly obj: THREE.Object3D;
  target: { x: number; z: number; yaw: number };
  lifted = true;
  private baseY: number;
  private lift = { x: 0, v: 0 };
  private leanX = { x: 0, v: 0 };
  private leanZ = { x: 0, v: 0 };
  private still: boolean;

  constructor(obj: THREE.Object3D, reducedMotion: boolean) {
    this.obj = obj;
    this.baseY = obj.position.y;
    this.target = { x: obj.position.x, z: obj.position.z, yaw: obj.rotation.y };
    this.still = reducedMotion;
    // Leaning in the world's axes, whatever way the piece faces.
    obj.rotation.order = 'XZY';
    if (!reducedMotion) {
      // A small kick as it leaves the floor.
      this.leanX.v = 0.9;
      this.leanZ.v = -0.6;
    }
  }

  /** Moves one frame on; false once it rests exactly at its target. */
  step(dt: number) {
    const o = this.obj;
    dt = Math.min(dt, 1 / 30);
    if (this.still) {
      o.position.set(this.target.x, this.baseY + (this.lifted ? LIFT : 0), this.target.z);
      o.rotation.set(0, this.target.yaw, 0);
      o.updateMatrixWorld(true);
      return false;
    }
    const k = 1 - Math.exp(-dt * 22);
    const dx = (this.target.x - o.position.x) * k, dz = (this.target.z - o.position.z) * k;
    o.position.x += dx;
    o.position.z += dz;
    const turn = Math.atan2(Math.sin(this.target.yaw - o.rotation.y), Math.cos(this.target.yaw - o.rotation.y));
    o.rotation.y += turn * (1 - Math.exp(-dt * 18));
    const vx = dx / dt, vz = dz / dt;
    // The top trails the move: moving toward +x leans it back toward −x.
    spring(this.leanZ, THREE.MathUtils.clamp(vx * LEAN, -MAX_LEAN, MAX_LEAN), dt, 160, 9);
    spring(this.leanX, THREE.MathUtils.clamp(-vz * LEAN, -MAX_LEAN, MAX_LEAN), dt, 160, 9);
    spring(this.lift, this.lifted ? LIFT : 0, dt, 260, this.lifted ? 20 : 26);
    // A dropped piece never sinks into the floor.
    if (!this.lifted && this.lift.x < 0) this.lift.x = this.lift.v = 0;
    o.position.y = this.baseY + this.lift.x;
    o.rotation.x = this.leanX.x;
    o.rotation.z = this.leanZ.x;
    o.updateMatrixWorld(true);
    const moving =
      this.lifted || Math.abs(this.lift.x) > 1e-3 || Math.abs(this.lift.v) > 1e-2 ||
      Math.abs(this.leanX.x) + Math.abs(this.leanZ.x) > 1e-3 || Math.abs(this.leanX.v) + Math.abs(this.leanZ.v) > 1e-2 ||
      Math.hypot(this.target.x - o.position.x, this.target.z - o.position.z) > 1e-3 || Math.abs(turn) > 1e-3;
    if (!moving) this.rest();
    return moving;
  }

  /** Puts it exactly at its target on the floor. */
  rest() {
    const o = this.obj;
    o.position.set(this.target.x, this.baseY, this.target.z);
    o.rotation.set(0, this.target.yaw, 0);
    o.updateMatrixWorld(true);
  }
}

/**
 * Where a piece stands, drawn on its floor: a tinted footprint, a rim just outside it that shows
 * past the piece from above, and an arrow off its front edge pointing the way it faces.
 */
export class PlacementMarker {
  readonly group = new THREE.Group();
  private material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  private rim = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 });
  private size = '';

  constructor() {
    this.group.name = 'placement';
    this.group.visible = false;
    this.group.renderOrder = 5;
  }

  /** `size` is [width, depth]; the piece's front faces its local +z. */
  show(size: readonly number[], x: number, y: number, z: number, yaw: number, color: string) {
    const key = `${size[0].toFixed(3)}|${size[1].toFixed(3)}`;
    if (key !== this.size) this.shape(size[0], size[1], key);
    this.material.color.set(color);
    this.rim.color.set(color);
    this.group.position.set(x, y + 0.012, z);
    this.group.rotation.set(0, yaw, 0);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  private shape(w: number, d: number, key: string) {
    this.size = key;
    for (const c of this.group.children) (c as THREE.Mesh).geometry.dispose();
    this.group.clear();
    const flat = (g: THREE.BufferGeometry) => g.rotateX(Math.PI / 2);
    const fill = new THREE.Mesh(flat(new THREE.PlaneGeometry(w, d)), this.material);
    const band = 0.05;
    const outer = new THREE.Shape([new THREE.Vector2(-w / 2 - band, -d / 2 - band), new THREE.Vector2(w / 2 + band, -d / 2 - band), new THREE.Vector2(w / 2 + band, d / 2 + band), new THREE.Vector2(-w / 2 - band, d / 2 + band)]);
    outer.holes.push(new THREE.Path([new THREE.Vector2(-w / 2, -d / 2), new THREE.Vector2(-w / 2, d / 2), new THREE.Vector2(w / 2, d / 2), new THREE.Vector2(w / 2, -d / 2)]));
    const rim = new THREE.Mesh(flat(new THREE.ShapeGeometry(outer)), this.rim);
    // The arrow sits just past the front edge; small pieces get a smaller one.
    const s = THREE.MathUtils.clamp(Math.min(w, d) * 0.6, 0.12, 0.3);
    const tip = d / 2 + band + 0.05;
    const arrow = new THREE.Mesh(
      flat(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-s / 2, tip), new THREE.Vector2(0, tip + s * 0.7), new THREE.Vector2(s / 2, tip), new THREE.Vector2(0, tip + s * 0.25)]))),
      this.rim,
    );
    this.group.add(fill, rim, arrow);
  }

  dispose() {
    for (const c of this.group.children) (c as THREE.Mesh).geometry.dispose();
    this.material.dispose();
    this.rim.dispose();
    this.group.removeFromParent();
  }
}
