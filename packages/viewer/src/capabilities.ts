/** What the browser can run, checked without loading three.js. */
export interface Capabilities {
  webgpu: boolean;
  webgl2: boolean;
  /** Phone or tablet: touch-only pointer or a mobile user agent. */
  mobile: boolean;
  /**
   * `full`: the desktop profile (full-resolution textures, 4K sun shadows).
   * `lite`: the phone profile (1k textures, fewer AO samples, 2K sun shadows, lower resolution).
   * `still`: no usable 3D; show a picture instead.
   */
  recommended: 'full' | 'lite' | 'still';
}

let cached: Promise<Capabilities> | undefined;

export function capabilities(): Promise<Capabilities> {
  if (!cached) {
    const p = detect();
    // React's use() reads these fields and renders a settled promise without suspending, which
    // skips the fallback and its 300 ms reveal throttle once a preload has run the check.
    void p.then((value) => Object.assign(p, { status: 'fulfilled', value }));
    cached = p;
  }
  return cached;
}

async function detect(): Promise<Capabilities> {
  if (typeof window === 'undefined') return { webgpu: false, webgl2: false, mobile: false, recommended: 'still' };
  let webgpu = false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    webgpu = !!(gpu && (await gpu.requestAdapter()));
  } catch {
    webgpu = false;
  }
  let webgl2 = false;
  try {
    webgl2 = !!document.createElement('canvas').getContext('webgl2');
  } catch {
    webgl2 = false;
  }
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch points give it away.
  const ipad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const touchOnly = matchMedia('(any-pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(ua) || ipad || touchOnly;
  const recommended = !webgpu && !webgl2 ? 'still' : mobile ? 'lite' : 'full';
  return { webgpu, webgl2, mobile, recommended };
}
