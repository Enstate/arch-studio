import { useState } from "react";
import { useStudioLocale } from "../lib/locale";
import { failureDetails, studioFailure } from "../lib/studio-errors";

export function StudioFailure({error, className}: {error: {message: string; name?: string}; className?: string}) {
  const {locale} = useStudioLocale();
  const [copied, setCopied] = useState(false);
  const failure = studioFailure(error, locale);
  // Someone helping can read the code and message without access to this computer.
  const copy = () => void navigator.clipboard.writeText(failureDetails(error, locale)).then(() => {setCopied(true); setTimeout(() => setCopied(false), 1500);}, () => undefined);
  return <div role="alert" className={className}>
    <p>{failure.message}</p>
    {failure.details && <details className="mt-1"><summary className="cursor-pointer text-xs">{failure.detailsLabel}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{failure.details}</pre></details>}
    <button type="button" onClick={copy} className="mt-1 cursor-pointer text-xs underline-offset-4 opacity-80 hover:underline hover:opacity-100">{copied ? failure.copiedLabel : failure.copyLabel}</button>
  </div>;
}
