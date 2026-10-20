import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@arch/ui/components/sheet";
import { Skeleton } from "@arch/ui/components/skeleton";
import { cn } from "@arch/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";

/** Dennis's project chrome, with navigation and content supplied by each app. */
export function ProjectLayout({
  sidebar,
  children,
  sidebarOpen,
  isMobile,
  mobileOpen,
  onMobileOpenChange,
  labels,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  sidebarOpen: boolean;
  isMobile: boolean;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  labels: { skipToContent: string; sidebar: string; mobileTitle: string; mobileDescription: string };
}) {
  return (
    <>
      <div
        data-sidebar={sidebarOpen ? "open" : "closed"}
        style={{ "--sidebar-w": "15.75rem" } as CSSProperties}
        className="grid h-svh grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-sidebar text-foreground transition-[grid-template-columns] duration-200 ease-out-quint has-[[data-viewer]]:transition-none md:grid-cols-[0_minmax(0,1fr)] md:data-[sidebar=open]:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]"
      >
        <a
          href="#inhalt"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 text-ui focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
        >
          {labels.skipToContent}
        </a>
        <aside aria-label={labels.sidebar} inert={!sidebarOpen} className="hidden min-w-0 overflow-hidden md:block">
          {!isMobile && sidebar}
        </aside>
        <main className="relative flex min-h-0 min-w-0 flex-col">{children}</main>
      </div>

      <Sheet open={isMobile && mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" showCloseButton={false} className="w-72 gap-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">{labels.mobileTitle}</SheetTitle>
          <SheetDescription className="sr-only">{labels.mobileDescription}</SheetDescription>
          {sidebar}
        </SheetContent>
      </Sheet>
    </>
  );
}

export function ProjectSidebar({
  header,
  toggle,
  footer,
  children,
}: {
  header: ReactNode;
  toggle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col px-2.5 pb-2.5 md:w-(--sidebar-w)">
      <div className="flex h-11 shrink-0 items-center gap-1 max-md:h-14">
        <div className="flex min-w-0 flex-1">{header}</div>
        {toggle}
      </div>
      {children}
      {footer && <div className="pt-2">{footer}</div>}
    </div>
  );
}

export function ProjectPage({
  title,
  meta,
  actions,
  navigation,
  children,
  className,
}: {
  /** Null paints a loading bar; undefined leaves the bar empty. */
  title?: ReactNode | null;
  meta?: ReactNode;
  actions?: ReactNode;
  navigation?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-1.5 pr-2.5 max-md:h-14 max-md:px-1.5">
        {navigation}
        <div className="flex min-w-0 flex-1 items-baseline gap-2 px-1.5">
          {title === null ? (
            <Skeleton aria-hidden="true" className="h-3 w-36 self-center" />
          ) : (
            title && <h1 className="min-w-0 truncate text-ui font-semibold">{title}</h1>
          )}
          {meta && <p className="min-w-0 truncate text-xs text-muted-foreground max-sm:hidden">{meta}</p>}
        </div>
        {actions}
      </header>
      <div
        id="inhalt"
        tabIndex={-1}
        className={cn(
          "app-panel relative flex min-h-0 flex-1 flex-col overflow-hidden outline-none max-md:rounded-none max-md:shadow-[0_-1px_0_var(--border)] md:mr-2 md:mb-2",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}

export const projectIconButton =
  "inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/7 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 active:scale-[0.96] max-md:size-11 [&_svg]:size-4";

export const projectNavItem =
  "flex h-7.5 w-full min-w-0 items-center gap-2.25 rounded-[7px] px-2 text-left text-ui font-medium text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/7 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 aria-[current=page]:bg-foreground/11 aria-[current=page]:text-foreground max-md:h-11 [&_svg]:size-4 [&_svg]:shrink-0";
