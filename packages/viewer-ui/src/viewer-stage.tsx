import { Button } from "@arch/ui/components/button";
import { useTheme } from "@arch/ui/lib/theme";
import { capabilities } from "@arch/viewer/capabilities";
import { Viewer, type ViewerProgress } from "@arch/viewer/react";
import { RotateCwIcon } from "lucide-react";
import { Suspense, use, useCallback, useState } from "react";

import { useFormat, useT } from "./locale";

import { ViewerLoader } from "./viewer-loader";
import { ASSET_BASE, type ViewerInstance } from "./viewer-model";

interface StageProps {
  planUrl: string;
  assetBase?: string;
  /** Builds the house for hand editing, with the shared library behind the project's own. */
  editable?: { catalogBase: string };
  posterUrl?: string | null;
  onViewer: (viewer: ViewerInstance | null) => void;
  /** 0..1 over the whole load. */
  onProgress?: (progress: number) => void;
  onError?: () => void;
}

/**
 * The "A" fills with the real load, then fades to the canvas after its first frame. `<Viewer>`
 * is imported directly: its module is tiny and starts three.js itself, and a lazy boundary here
 * would hold the mount back by React's 300 ms reveal throttle. Without WebGL the render shows as a still.
 */
export function ViewerStage(props: StageProps) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-muted">
      <Suspense fallback={<ViewerLoader progress={0} />}>
        <Profiled {...props} />
      </Suspense>
    </div>
  );
}

function Profiled(props: StageProps) {
  const { recommended } = use(capabilities());
  const [attempt, setAttempt] = useState(0);
  if (recommended === "still") return <Still url={props.posterUrl} />;
  return <Live key={attempt} {...props} onRetry={() => setAttempt(attempt + 1)} />;
}

function Live({ planUrl, assetBase = ASSET_BASE, editable, onViewer, onProgress, onError, onRetry }: StageProps & { onRetry: () => void }) {
  const [progress, setProgress] = useState(0);
  const [shown, setShown] = useState(false);
  const [loaderHidden, setLoaderHidden] = useState(false);
  const [error, setError] = useState(false);
  const { resolvedTheme } = useTheme();
  const { tag } = useFormat();
  const reportViewer = useCallback((viewer: ViewerInstance | null) => {
    setShown(viewer !== null);
    onViewer(viewer);
  }, [onViewer]);

  return (
    <>
      <Viewer
        ref={reportViewer}
        planUrl={planUrl}
        assetBase={assetBase}
        editable={!!editable}
        catalogBase={editable?.catalogBase}
        locale={tag}
        mode="dollhouse"
        cut
        theme={resolvedTheme}
        onProgress={(p: ViewerProgress) => {
          setProgress((prev) => Math.max(prev, p.progress));
          onProgress?.(p.progress);
        }}
        onError={() => {
          setError(true);
          onViewer(null);
          onError?.();
        }}
        className="touch-none select-none"
      />
      {!error && !loaderHidden && <ViewerLoader progress={progress} done={shown} onHidden={() => setLoaderHidden(true)} />}
      {error && <LoadError onRetry={onRetry} />}
    </>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <div role="alert" className="absolute inset-0 grid place-items-center p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-ui text-muted-foreground">{t.viewer.loadError}</p>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={onRetry}>
          <RotateCwIcon />
          {t.actions.retry}
        </Button>
      </div>
    </div>
  );
}

function Still({ url }: { url?: string | null }) {
  const t = useT();
  return (
    <figure className="absolute inset-0 m-0">
      {url && <img src={url} alt={t.viewer.stillAlt} className="size-full object-cover" />}
      <figcaption className="absolute inset-x-0 top-0 flex justify-center p-3">
        <span className="rounded-full bg-background/85 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
          {t.viewer.stillNotice}
        </span>
      </figcaption>
    </figure>
  );
}
