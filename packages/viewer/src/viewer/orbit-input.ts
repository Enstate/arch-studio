import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** Recover a mouse drag when Chromium loses its release outside the canvas/window. */
export function bindOrbitInput(
  canvas: HTMLCanvasElement,
  controls: OrbitControls[],
  onEnd: () => void,
  signal: AbortSignal,
) {
  const document = canvas.ownerDocument;
  let mouse: { id: number } | null = null;

  const cancel = () => {
    const previous = mouse;
    mouse = null;
    // Public disconnect/connect clears OrbitControls' pointer list and drag state without
    // resetting its camera, target or settings. Disabling it alone leaves the old drag alive.
    for (const control of controls) {
      control.disconnect();
      control.connect(canvas);
    }
    if (previous && canvas.hasPointerCapture(previous.id)) canvas.releasePointerCapture(previous.id);
    onEnd();
  };
  const interrupted = () => { if (mouse) cancel(); };
  // A normal OrbitControls end has already cleared the pointer. Keep its keyboard
  // modifier tracking intact, so a held Control key does not become a pinch gesture.
  const completed = () => {
    if (!mouse) return;
    mouse = null;
    onEnd();
  };
  for (const control of controls) control.addEventListener('end', completed);
  signal.addEventListener('abort', () => {
    for (const control of controls) control.removeEventListener('end', completed);
  }, { once: true });
  canvas.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse') return;
    interrupted();
    mouse = { id: event.pointerId };
  }, { capture: true, signal });
  document.addEventListener('pointermove', event => {
    if (mouse && event.pointerType === 'mouse' && event.buttons === 0) cancel();
  }, { capture: true, signal });
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== mouse?.id) return;
    const ending = mouse;
    // Browsers can flush microtasks between capture and bubble listeners. Wait a
    // full task for OrbitControls' normal end; identity also protects a newer drag.
    setTimeout(() => { if (!signal.aborted && mouse === ending) cancel(); }, 0);
  };
  document.addEventListener('pointerup', finish, { capture: true, signal });
  canvas.addEventListener('pointercancel', finish, { signal });
  canvas.addEventListener('lostpointercapture', interrupted, { signal });
  document.defaultView?.addEventListener('blur', interrupted, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) interrupted(); }, { signal });
  document.addEventListener('keydown', event => { if (event.code === 'Escape') interrupted(); }, { signal });
  return cancel;
}

function navigationCursor(paths: string, fallback: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="white" stroke-width="4">${paths}</g><g stroke="#1c1b19" stroke-width="1.8">${paths}</g></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 14 14, ${fallback}`;
}

/** Matching rotate/pan symbols remain readable on both the model and dark ground. */
export const ORBIT_CURSOR = {
  rotate: navigationCursor('<path d="M6 10a9 9 0 0 1 16 0M22 6v4h-4M22 18a9 9 0 0 1-16 0M6 22v-4h4"/><circle cx="14" cy="14" r="1.5"/>', 'grab'),
  zoom: navigationCursor('<circle cx="12" cy="12" r="8"/><path d="M18 18l7 7M8 12h8M12 8v8"/>', 'ns-resize'),
  pan: navigationCursor('<path d="M14 3v22M3 14h22M10 7l4-4 4 4M10 21l4 4 4-4M7 10l-4 4 4 4M21 10l4 4-4 4"/>', 'move'),
};
