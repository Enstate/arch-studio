import { afterEach, expect, test } from 'bun:test';
import { PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { bindOrbitInput } from '../src/viewer/orbit-input.ts';

class Canvas extends EventTarget {
  style = { touchAction: '', cursor: '' };
  clientWidth = 800;
  clientHeight = 600;
  captures = new Set<number>();
  ownerDocument = Object.assign(new EventTarget(), { defaultView: new EventTarget(), hidden: false });
  getRootNode() { return this.ownerDocument; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function pointer(target: EventTarget, type: string, button: number, buttons: number, x = 400, id = 1, pointerType = 'mouse') {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: id, pointerType, button, buttons, clientX: x, clientY: 300, pageX: x, pageY: 300, ctrlKey: false, metaKey: false, shiftKey: false });
  target.dispatchEvent(event);
}
function fixture() {
  const canvas = new Canvas();
  const camera = new PerspectiveCamera(50, 4 / 3, .1, 100);
  camera.position.set(8, 8, 8);
  const orbit = new OrbitControls(camera);
  const lifetime = new AbortController();
  const cancel = bindOrbitInput(canvas as unknown as HTMLCanvasElement, [orbit], () => {}, lifetime.signal);
  orbit.connect(canvas as unknown as HTMLElement);
  cleanup.push(() => { lifetime.abort(); orbit.dispose(); });
  return { canvas, camera, orbit, cancel };
}

for (const interruption of ['capture loss', 'window blur', 'released buttons', 'hidden document', 'Escape']) {
  test(`${interruption} ends right-drag and lets the next left-drag rotate`, () => {
    const {canvas, camera, orbit} = fixture();
    pointer(canvas, 'pointerdown', 2, 2);
    pointer(canvas.ownerDocument, 'pointermove', -1, 2, 430);
    if (interruption === 'capture loss') {
      canvas.releasePointerCapture(1);
      pointer(canvas, 'lostpointercapture', -1, 0);
    } else if (interruption === 'window blur') canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
    else if (interruption === 'released buttons') pointer(canvas.ownerDocument, 'pointermove', -1, 0, 430);
    else if (interruption === 'Escape') {
      const key = new Event('keydown');
      Object.assign(key, {code: 'Escape'});
      canvas.ownerDocument.dispatchEvent(key);
    } else {
      canvas.ownerDocument.hidden = true;
      canvas.ownerDocument.dispatchEvent(new Event('visibilitychange'));
      canvas.ownerDocument.hidden = false;
    }
    const resting = camera.position.clone();
    pointer(canvas.ownerDocument, 'pointermove', -1, 0, 470);
    expect(camera.position.distanceTo(resting)).toBeLessThan(1e-8);
    const target = orbit.target.clone();
    const direction = camera.position.clone().sub(target).normalize();
    pointer(canvas, 'pointerdown', 0, 1, 470);
    pointer(canvas.ownerDocument, 'pointermove', -1, 1, 510);
    expect(orbit.target.distanceTo(target)).toBeLessThan(1e-8);
    expect(camera.position.clone().sub(target).normalize().distanceTo(direction)).toBeGreaterThan(.01);
  });
}

test('normal right-drag pans and a subsequent left-drag rotates', () => {
  const {canvas, camera, orbit} = fixture();
  pointer(canvas, 'pointerdown', 2, 2);
  pointer(canvas.ownerDocument, 'pointermove', -1, 2, 430);
  expect(orbit.target.distanceTo(new Vector3())).toBeGreaterThan(.01);
  pointer(canvas.ownerDocument, 'pointerup', 2, 0, 430);
  const target = orbit.target.clone();
  const direction = camera.position.clone().sub(target).normalize();
  pointer(canvas, 'pointerdown', 0, 1, 430);
  pointer(canvas.ownerDocument, 'pointermove', -1, 1, 470);
  expect(orbit.target.distanceTo(target)).toBeLessThan(1e-8);
  expect(camera.position.clone().sub(target).normalize().distanceTo(direction)).toBeGreaterThan(.01);
});


test('a fresh mouse press recovers a missed release even without a hover event', () => {
  const {canvas, camera, orbit} = fixture();
  pointer(canvas, 'pointerdown', 2, 2);
  pointer(canvas.ownerDocument, 'pointermove', -1, 2, 430);
  const target = orbit.target.clone();
  const direction = camera.position.clone().sub(target).normalize();
  pointer(canvas, 'pointerdown', 0, 1, 430);
  pointer(canvas.ownerDocument, 'pointermove', -1, 1, 470);
  expect(orbit.target.distanceTo(target)).toBeLessThan(1e-8);
  expect(camera.position.clone().sub(target).normalize().distanceTo(direction)).toBeGreaterThan(.01);
});

test('changing mode cancels the current drag without changing the camera or target', () => {
  const {canvas, camera, orbit, cancel} = fixture();
  pointer(canvas, 'pointerdown', 2, 2);
  pointer(canvas.ownerDocument, 'pointermove', -1, 2, 430);
  const position = camera.position.clone(), target = orbit.target.clone();
  cancel();
  pointer(canvas.ownerDocument, 'pointermove', -1, 2, 470);
  expect(camera.position.distanceTo(position)).toBeLessThan(1e-8);
  expect(orbit.target.distanceTo(target)).toBeLessThan(1e-8);
  expect(canvas.hasPointerCapture(1)).toBe(false);
});

test('touch rotation remains active across zero-button moves and pointer capture loss', () => {
  const {canvas, camera, orbit} = fixture();
  pointer(canvas, 'pointerdown', 0, 1, 400, 7, 'touch');
  pointer(canvas, 'lostpointercapture', -1, 0, 400, 7, 'touch');
  const direction = camera.position.clone().sub(orbit.target).normalize();
  pointer(canvas.ownerDocument, 'pointermove', -1, 0, 450, 7, 'touch');
  expect(orbit.target.length()).toBeLessThan(1e-8);
  expect(camera.position.clone().normalize().distanceTo(direction)).toBeGreaterThan(.01);
});

test('the plan controller pans again after losing capture', () => {
  const {canvas, orbit} = fixture();
  orbit.enableRotate = false;
  orbit.mouseButtons.LEFT = orbit.mouseButtons.RIGHT;
  pointer(canvas, 'pointerdown', 2, 2);
  pointer(canvas, 'lostpointercapture', -1, 0);
  pointer(canvas, 'pointerdown', 0, 1);
  pointer(canvas.ownerDocument, 'pointermove', -1, 1, 450);
  expect(orbit.target.length()).toBeGreaterThan(.01);
});

test('holding Control across a normal drag preserves wheel zoom sensitivity', async () => {
  const distanceAfterWheel = async (drag: boolean) => {
    const {canvas, camera, orbit} = fixture();
    const control = new Event('keydown');
    Object.assign(control, {key: 'Control'});
    canvas.ownerDocument.dispatchEvent(control);
    if (drag) {
      pointer(canvas, 'pointerdown', 0, 1);
      pointer(canvas.ownerDocument, 'pointerup', 0, 0);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const wheel = new Event('wheel', {cancelable: true});
    Object.assign(wheel, {deltaY: 10, deltaMode: 0, ctrlKey: true, clientX: 400, clientY: 300});
    canvas.dispatchEvent(wheel);
    return camera.position.distanceTo(orbit.target);
  };
  expect(await distanceAfterWheel(true)).toBeCloseTo(await distanceAfterWheel(false), 8);
});
