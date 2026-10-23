import * as THREE from 'three/webgpu';

/** How a picture is taken: three-quarters from the front right, slightly from above. */
const VIEW = new THREE.Vector3(1, 0.75, 1.6).normalize();
const FOV = 28;

const half = new Float32Array(1);
const halfBits = new Uint32Array(half.buffer);
/** One IEEE half float as a number. */
function fromHalf(h: number) {
  const exponent = (h >> 10) & 0x1f, mantissa = h & 0x3ff, sign = h & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  halfBits[0] = ((h & 0x8000) << 16) | ((exponent + 112) << 23) | (mantissa << 13);
  return half[0]!;
}

/** Khronos PBR Neutral, as the stage tone maps, then the sRGB curve: one linear colour as 0..255. */
function display(rgb: [number, number, number]) {
  let [r, g, b] = rgb;
  const low = Math.min(r, g, b), offset = low < 0.08 ? low - 6.25 * low * low : 0.04;
  r -= offset; g -= offset; b -= offset;
  const peak = Math.max(r, g, b), start = 0.76;
  if (peak >= start) {
    const d = 1 - start, top = 1 - (d * d) / (peak + d - start), k = top / peak;
    const fade = 1 - 1 / (0.15 * (peak - top) + 1);
    [r, g, b] = [r, g, b].map((c) => c * k * (1 - fade) + top * fade) as [number, number, number];
  }
  return [r, g, b].map((c) => {
    const v = Math.min(1, Math.max(0, c));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  });
}

/**
 * A picture of one piece on a clear background, lit by `environment` and a key light, as a WebP
 * data URL. Renders with the stage's renderer into its own target, so the view on screen is untouched.
 */
export async function piecePicture(renderer: THREE.WebGPURenderer, environment: THREE.Texture | null, piece: THREE.Object3D, px = 256): Promise<string> {
  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, 3);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0x8a8478, 0.6), piece);
  piece.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(piece);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.05, box.getSize(new THREE.Vector3()).length() / 2);
  const camera = new THREE.PerspectiveCamera(FOV, 1, radius / 50, radius * 10);
  camera.position.copy(centre).addScaledVector(VIEW, (radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2))) * 1.02);
  camera.lookAt(centre);
  const target = new THREE.RenderTarget(px, px, { type: THREE.HalfFloatType, samples: 4 });
  const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha(), previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.render(scene, camera);
    const raw = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, px, px)) as Uint16Array;
    // The WebGL backend reads rows from the bottom up.
    const flip = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true;
    const image = new ImageData(px, px);
    for (let y = 0; y < px; y++) {
      const row = flip ? px - 1 - y : y;
      for (let x = 0; x < px; x++) {
        const i = (row * px + x) * 4, o = (y * px + x) * 4;
        const a = Math.min(1, Math.max(0, fromHalf(raw[i + 3]!)));
        const [r, g, b] = display([0, 1, 2].map((c) => (a > 0 ? fromHalf(raw[i + c]!) / a : 0)) as [number, number, number]);
        image.data.set([r!, g!, b!, Math.round(a * 255)], o);
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    return canvas.toDataURL('image/webp', 0.85);
  } finally {
    renderer.setRenderTarget(previous);
    renderer.setClearColor(clear, alpha);
    target.dispose();
    scene.remove(piece);
  }
}
