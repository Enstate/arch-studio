import * as THREE from 'three/webgpu';

const LOOK = 0.0025; // radians per pixel of mouse movement
const PITCH = 1.5;
/** Fly speed in m/s per metre between the camera and what it looked at, so an overview moves fast and a close look slowly. */
const PACE = 0.75;
const MIN_PACE_SPEED = 3, MAX_PACE_SPEED = 30;
const FAST = 3;
const MIN_SCALE = 0.1, MAX_SCALE = 10;
/** Lowest eye height, so the camera stays above the ground it orbits. */
const FLOOR = 0.3;
/** The orbit clamps its polar angle near level; the pivot sits this far below the eye per metre ahead. */
const PIVOT_DROP = 0.1;

/**
 * Free look for the dollhouse, as in a 3D editor: while held, the mouse turns the camera where it
 * stands and W/S fly along the view, A/D strafe, Q/E sink and rise. Releasing hands back a pivot
 * ahead of the view, so orbiting carries on from there.
 */
export class FlyCamera {
  private yaw = 0;
  private pitch = 0;
  private reach = 6;
  /** The wheel's multiplier on the pace; it is kept for the next flight. */
  scale = 1;
  /** Metres per second at the current pace and wheel setting. */
  get speed() {
    return THREE.MathUtils.clamp(this.reach * PACE, MIN_PACE_SPEED, MAX_PACE_SPEED) * this.scale;
  }
  active = false;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly step = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** Takes the view the camera has now; `target` is the orbit pivot it looked at. */
  start(target: THREE.Vector3) {
    const direction = this.camera.getWorldDirection(this.forward);
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
    this.reach = Math.max(2, this.camera.position.distanceTo(target));
    this.active = true;
    this.apply();
  }

  look(dx: number, dy: number) {
    if (!this.active) return;
    this.yaw -= dx * LOOK;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * LOOK, -PITCH, PITCH);
    this.apply();
  }

  /** One notch of the wheel: up flies faster, down slower. */
  adjustSpeed(deltaY: number) {
    this.scale = THREE.MathUtils.clamp(this.scale * (deltaY < 0 ? 1.25 : 0.8), MIN_SCALE, MAX_SCALE);
  }

  /** Moves by the held keys (KeyboardEvent codes). Returns whether the camera moved. */
  move(dt: number, keys: Set<string>) {
    if (!this.active) return false;
    const held = (...codes: string[]) => codes.some((code) => keys.has(code));
    const ahead = Number(held('KeyW', 'ArrowUp')) - Number(held('KeyS', 'ArrowDown'));
    const side = Number(held('KeyD', 'ArrowRight')) - Number(held('KeyA', 'ArrowLeft'));
    const rise = Number(held('KeyE')) - Number(held('KeyQ'));
    if (!ahead && !side && !rise) return false;
    this.camera.getWorldDirection(this.forward);
    this.right.crossVectors(this.forward, THREE.Object3D.DEFAULT_UP).normalize();
    this.step.copy(this.forward).multiplyScalar(ahead).addScaledVector(this.right, side);
    this.step.y += rise;
    const fast = held('ShiftLeft', 'ShiftRight') ? FAST : 1;
    this.step.normalize().multiplyScalar(this.speed * fast * Math.min(dt, 0.1));
    this.camera.position.add(this.step);
    this.camera.position.y = Math.max(FLOOR, this.camera.position.y);
    return true;
  }

  /** Ends the flight and returns the orbit pivot: where the view meets `ground`, or a point ahead of it. */
  end(ground: number) {
    this.active = false;
    const direction = this.camera.getWorldDirection(this.forward);
    const eye = this.camera.position;
    const down = ground - eye.y;
    // Looking down at the floor: pivot where the view lands, within a sensible range.
    if (direction.y < -0.1 && down < 0) {
      const along = THREE.MathUtils.clamp(down / direction.y, 2, 60);
      return eye.clone().addScaledVector(direction, along);
    }
    // Level or upward: a pivot straight ahead, just below eye height, which the orbit's polar limit accepts.
    const flat = this.right.set(direction.x, 0, direction.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    return eye.clone().addScaledVector(flat, this.reach).setY(eye.y - this.reach * PIVOT_DROP);
  }

  private apply() {
    this.camera.quaternion.setFromEuler(this.euler.set(this.pitch, this.yaw, 0));
  }
}
