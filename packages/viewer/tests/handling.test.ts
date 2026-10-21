import { expect, test } from 'bun:test';
import * as THREE from 'three/webgpu';
import { Carry } from '../src/viewer/handling.ts';

const run = (carry: Carry, seconds: number, onFrame?: () => void) => {
  let moving = true;
  for (let i = 0; i < seconds * 60 && moving; i++) {
    moving = carry.step(1 / 60);
    onFrame?.();
  }
  return moving;
};

test('a held piece lifts, leans back against the way it moves, then lands exactly where it was let go', () => {
  const obj = new THREE.Group();
  obj.position.set(1, 2.8, 1);
  const carry = new Carry(obj, false);
  run(carry, 0.5);
  expect(obj.position.y).toBeGreaterThan(2.9);
  carry.target = { x: 3, z: 1, yaw: -Math.PI / 2 };
  let leanedBack = false;
  run(carry, 0.15, () => (leanedBack ||= obj.rotation.z > 0.02));
  // Moving toward +x, its top trails toward −x.
  expect(leanedBack).toBe(true);
  carry.lifted = false;
  expect(run(carry, 4)).toBe(false);
  expect(obj.position.toArray()).toEqual([3, 2.8, 1]);
  expect([obj.rotation.x, obj.rotation.y, obj.rotation.z]).toEqual([0, -Math.PI / 2, 0]);
});

test('with reduced motion the piece goes straight to its target without leaning', () => {
  const obj = new THREE.Group();
  const carry = new Carry(obj, true);
  carry.target = { x: 2, z: 0, yaw: 0 };
  expect(carry.step(1 / 60)).toBe(false);
  expect(obj.position.x).toBe(2);
  expect(obj.rotation.z).toBe(0);
});
