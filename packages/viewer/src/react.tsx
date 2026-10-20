import { type CSSProperties, type Ref, useCallback, useRef } from 'react';
import type { Viewer as ViewerInstance, ViewerOptions } from './viewer.ts';

export type { ViewerInstance };
export type {
  ViewerMode, ViewerProgress, ViewerState, ViewerStats, ViewerTheme, RoomInfo, ViewerPick, ViewerView, Vec3,
} from './viewer.ts';

export interface ViewerProps extends Omit<ViewerOptions, 'signal'> {
  /** Receives the instance after the first frame, and null on unmount. */
  ref?: Ref<ViewerInstance | null>;
  onError?: (error: Error) => void;
  className?: string;
  style?: CSSProperties;
}

function assign<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/**
 * Canvas host for the 3D viewer. three.js loads on mount through a dynamic import, so importing
 * this component keeps it out of the bundle until a viewer actually renders.
 * Options are read once on mount; give the component a new `key` to load another plan.
 * Drive it through the instance from `ref`; `viewer.subscribe`/`getState` fit useSyncExternalStore.
 */
export function Viewer({ ref, onError, className, style, ...options }: ViewerProps) {
  const latest = useRef({ options, ref, onError });
  latest.current = { options, ref, onError };

  const mount = useCallback((host: HTMLDivElement | null) => {
    if (!host) return;
    const controller = new AbortController();
    let instance: ViewerInstance | undefined;
    const initial = latest.current.options;
    import('./viewer.ts')
      .then(({ createViewer }) => {
        // StrictMode detaches and reattaches the ref at once, so the first mount is aborted before the import resolves.
        if (controller.signal.aborted) throw new DOMException('Viewer creation aborted', 'AbortError');
        return createViewer(host, {
          ...initial,
          onProgress: (p) => latest.current.options.onProgress?.(p),
          onModeChange: (m) => latest.current.options.onModeChange?.(m),
          onRoomChange: (r) => latest.current.options.onRoomChange?.(r),
          signal: controller.signal,
        });
      })
      .then(
        (v) => {
          if (controller.signal.aborted) return v.dispose();
          instance = v;
          assign(latest.current.ref, v);
        },
        (e: Error) => {
          if (e.name !== 'AbortError') latest.current.onError?.(e);
        },
      );
    return () => {
      controller.abort();
      if (instance) assign(latest.current.ref, null);
      instance?.dispose();
    };
  }, []);

  return <div ref={mount} className={className} style={{ position: 'relative', width: '100%', height: '100%', ...style }} />;
}

export default Viewer;
