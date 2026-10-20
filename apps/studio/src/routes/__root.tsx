import { fontPreloads } from "@arch/ui/lib/fonts";
import { themeScript } from "@arch/ui/lib/theme";
import { TooltipProvider } from "@arch/ui/components/tooltip";
import { Toaster } from "@arch/ui/components/sonner";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, ScriptOnce } from "@tanstack/react-router";
import { session } from "../lib/server";
import css from "../index.css?url";

export const Route = createRootRouteWithContext<{queryClient: QueryClient}>()({
  beforeLoad: async () => {await session();},
  head: () => ({meta: [{charSet: "utf-8"}, {name: "viewport", content: "width=device-width, initial-scale=1"}, {title: "Arch Studio"}], links: [...fontPreloads, {rel: "stylesheet", href: css}]}),
  component: Document,
});
function Document() {
  return <html lang="de" suppressHydrationWarning><head><ScriptOnce>{themeScript}</ScriptOnce><HeadContent /></head><body><TooltipProvider><Outlet /><Toaster /></TooltipProvider><Scripts /></body></html>;
}
