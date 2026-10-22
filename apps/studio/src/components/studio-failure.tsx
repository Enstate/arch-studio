import { useStudioLocale } from "../lib/locale";
import { studioFailure } from "../lib/studio-errors";

export function StudioFailure({error, className}: {error: {message: string}; className?: string}) {
  const {locale} = useStudioLocale();
  const failure = studioFailure(error, locale);
  return <div role="alert" className={className}>
    <p>{failure.message}</p>
    {failure.details && <details className="mt-1"><summary className="cursor-pointer text-xs">{failure.detailsLabel}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{failure.details}</pre></details>}
  </div>;
}
