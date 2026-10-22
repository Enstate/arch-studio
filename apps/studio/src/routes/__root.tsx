import { fontPreloads } from "@arch/ui/lib/fonts";
import { themeScript } from "@arch/ui/lib/theme";
import { TooltipProvider } from "@arch/ui/components/tooltip";
import { Toaster } from "@arch/ui/components/sonner";
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, ScriptOnce } from "@tanstack/react-router";
import { session } from "../lib/server";
import { rememberStudioSession } from "../lib/browser-session";
import css from "../index.css?url";
import { useStudioLocale } from "../lib/locale";
import { studioText } from "../lib/messages";

export const Route = createRootRouteWithContext<{queryClient: QueryClient}>()({
  ssr: false,
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("studio") ?? undefined;
    const paired = await session({data: {token}});
    rememberStudioSession(paired.secret);
    if (token) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  },
  head: () => ({meta: [{charSet: "utf-8"}, {name: "viewport", content: "width=device-width, initial-scale=1"}, {title: "Arch Studio"}], links: [...fontPreloads, {rel: "stylesheet", href: css}]}),
  shellComponent: Document,
  component: Outlet,
  errorComponent: StudioAccess,
  notFoundComponent: StudioNotFound,
});
function Document({children}: {children: ReactNode}) {
  const {locale} = useStudioLocale();
  return <html lang={locale} suppressHydrationWarning><head><ScriptOnce>{themeScript}</ScriptOnce><HeadContent /></head><body><TooltipProvider>{children}<Toaster /></TooltipProvider><Scripts /></body></html>;
}

function StudioAccess() {
  const {locale} = useStudioLocale();
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6"><h1 className="text-xl font-semibold">Arch Studio</h1><p>{studioText[locale].sessionRequired}</p></main>;
}

function StudioNotFound() {
  const {locale} = useStudioLocale();
  return <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6"><h1 className="text-xl font-semibold">Arch Studio</h1><p>{studioText[locale].notFound}</p></main>;
}
