import { expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FlyCamera } from '../src/viewer/fly.ts';

function setup(position: [number, number, number], target: [number, number, number]) {
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld();
  const fly = new FlyCamera(camera);
  fly.start(new THREE.Vector3(...target));
  return { camera, fly };
}

const direction = (camera: THREE.Camera) => camera.getWorldDirection(new THREE.Vector3());

test('starting keeps the view, and the mouse turns it where the camera stands', () => {
  const { camera, fly } = setup([10, 8, 10], [0, 0, 0]);
  const before = direction(camera);
  expect(direction(camera).distanceTo(before)).toBeLessThan(1e-6);
  const at = camera.position.clone();
  fly.look(200, 0);
  expect(camera.position.distanceTo(at)).toBe(0);
  expect(direction(camera).angleTo(before)).toBeGreaterThan(0.3);
});

test('W flies along the view, including its slope; A and D strafe level; Q and E sink and rise', () => {
  const { camera, fly } = setup([10, 8, 10], [0, 0, 0]);
  const start = camera.position.clone();
  const look = direction(camera);
  // 16.25 m from what it looks at: 0.75 m/s per metre.
  expect(fly.speed).toBeCloseTo(12.19, 2);
  fly.move(0.1, new Set(['KeyW']));
  const moved = camera.position.clone().sub(start);
  expect(moved.length()).toBeCloseTo(fly.speed * 0.1, 5);
  expect(moved.normalize().angleTo(look)).toBeLessThan(1e-6);
  expect(camera.position.y).toBeLessThan(start.y);

  const level = camera.position.y;
  fly.move(0.1, new Set(['KeyD']));
  expect(camera.position.y).toBeCloseTo(level, 6);
  fly.move(0.1, new Set(['KeyE']));
  expect(camera.position.y).toBeCloseTo(level + fly.speed * 0.1, 5);
  expect(fly.move(0.1, new Set())).toBe(false);
});

test('the pace follows the view distance, Shift and the wheel scale it, and the camera stays above the ground', () => {
  const { camera, fly } = setup([0, 2, 5], [0, 0, 0]);
  // Close up the pace bottoms out at 3 m/s; far out it tops out at 30 m/s.
  expect(fly.speed).toBeCloseTo(4.04, 2);
  expect(setup([60, 40, 60], [0, 0, 0]).fly.speed).toBe(30);
  const start = camera.position.clone();
  fly.move(0.1, new Set(['KeyW', 'ShiftLeft']));
  expect(camera.position.distanceTo(start)).toBeCloseTo(fly.speed * 0.3, 5);
  const before = fly.speed;
  fly.adjustSpeed(-100);
  expect(fly.speed).toBeCloseTo(before * 1.25, 6);
  for (let i = 0; i < 100; i++) fly.move(0.1, new Set(['KeyQ']));
  expect(camera.position.y).toBeCloseTo(0.3, 6);
});

// The start view looks 0.52 rad down at the origin; each case raises it by `pitch`, and `tilt` bounds the aim change.
for (const [name, pitch, tilt] of [['looking down at the floor', 0, 1e-6], ['looking level', 0.52, 0.15], ['looking up', 1.2, 0.85]] as const) {
  test(`releasing while ${name} hands the orbit a pivot it can keep without moving the camera`, () => {
    const { camera, fly } = setup([10, 8, 10], [0, 0, 0]);
    fly.look(0, -pitch / 0.0025);
    const position = camera.position.clone(), look = direction(camera);
    const pivot = fly.end(0);
    const orbit = new OrbitControls(camera);
    orbit.maxPolarAngle = Math.PI * 0.47;
    orbit.target.copy(pivot);
    orbit.update();
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-6);
    // A downward view keeps its aim; level and upward views tip down to a pivot just below eye height.
    expect(direction(camera).angleTo(look)).toBeLessThan(tilt);
    if (pitch === 0) expect(pivot.y).toBeCloseTo(0, 6);
  });
}
