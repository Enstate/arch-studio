import type { AgentModel, AgentModelSetting, AgentProvider, AgentProviderStatus } from "@arch/agent";
import { Badge } from "@arch/ui/components/badge";
import { Button } from "@arch/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@arch/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@arch/ui/components/popover";
import { cn } from "@arch/ui/lib/utils";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon, StarIcon, ZapIcon } from "lucide-react";
import { type ComponentProps, type SVGProps, useState } from "react";
import type { studioText } from "../lib/messages";
import { useStudioLocale } from "../lib/locale";
import { translateModelSettings } from "../lib/model-settings";

// Ported from T3 Code's ProviderModelPicker, ModelPickerContent, ModelListRow,
// ModelPickerSidebar, TraitsPicker and Icons (apps/web/src/components, MIT).

type Copy = typeof studioText.en;
export type ModelChoice = { provider: AgentProvider; model: string };
export type ModelSettings = Record<string, string | boolean>;

export function ClaudeIcon({className, ...props}: SVGProps<SVGSVGElement>) {
  return <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 257" className={cn("fill-[#d97757]", className)}><path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" /></svg>;
}
export function OpenAIIcon({className, ...props}: SVGProps<SVGSVGElement>) {
  return <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 260" className={cn("fill-black dark:fill-white", className)}><path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" /></svg>;
}
const providerIcon = {claude: ClaudeIcon, codex: OpenAIIcon} as const;
const providerName = {claude: "Claude", codex: "Codex"} as const;

const composerControlClassName = "h-7 min-h-7 gap-1.5 px-2.5 text-muted-foreground/70 transition-none hover:text-foreground/80";
function ComposerControl({className, ...props}: ComponentProps<typeof Button>) {
  return <Button type="button" size="sm" variant="ghost" className={cn(composerControlClassName, className)} {...props} />;
}
function ComposerControlChevron() {
  return <ChevronDownIcon aria-hidden="true" className="-mx-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70" strokeWidth={2.25} />;
}

const favoritesKey = "arch-model-favorites";
function storedFavorites(): string[] {
  try { return JSON.parse(localStorage.getItem(favoritesKey) ?? "[]") as string[]; } catch { return []; }
}

/** Provider rail, search and model list with legacy models folded away, as in T3 Code. */
export function ModelPicker({providers, value, lockedTo, onChange, t}: {providers: AgentProviderStatus[]; value?: ModelChoice; lockedTo?: AgentProvider; onChange: (value: ModelChoice) => void; t: Copy}) {
  const [open, setOpen] = useState(false);
  const ready = providers.filter(item => item.installed && item.authenticated !== false && item.models.length);
  const active = value ? ready.find(item => item.provider === value.provider)?.models.find(model => model.id === value.model) : undefined;
  const Icon = value ? providerIcon[value.provider] : null;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<ComposerControl aria-label={t.chooseModel} className="min-w-0 max-w-48 shrink justify-between whitespace-nowrap sm:max-w-56" />}>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {Icon && <Icon className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 overflow-hidden truncate">{active?.label ?? t.model}</span>
      </span>
      <ComposerControlChevron />
    </PopoverTrigger>
    <PopoverContent align="start" className="w-auto gap-0 overflow-hidden p-0">
      {open && <ModelPickerContent providers={ready} value={value} lockedTo={lockedTo} onChange={next => {onChange(next); setOpen(false);}} t={t} />}
    </PopoverContent>
  </Popover>;
}

function ModelPickerContent({providers, value, lockedTo, onChange, t}: {providers: AgentProviderStatus[]; value?: ModelChoice; lockedTo?: AgentProvider; onChange: (value: ModelChoice) => void; t: Copy}) {
  const [favorites, setFavorites] = useState(storedFavorites);
  const [rail, setRail] = useState<AgentProvider | "favorites">(() => favorites.length && !lockedTo ? "favorites" : value?.provider ?? lockedTo ?? providers[0]?.provider ?? "claude");
  const [query, setQuery] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const key = (provider: AgentProvider, model: string) => `${provider}:${model}`;
  const toggleFavorite = (provider: AgentProvider, model: string) => {
    const next = favorites.includes(key(provider, model)) ? favorites.filter(item => item !== key(provider, model)) : [...favorites, key(provider, model)];
    localStorage.setItem(favoritesKey, JSON.stringify(next));
    setFavorites(next);
  };
  const allowed = (provider: AgentProvider) => !lockedTo || provider === lockedTo;
  const all = providers.flatMap(item => item.models.map(model => ({provider: item.provider, model})));
  const search = query.trim().toLowerCase();
  const matches = search
    ? all.filter(item => allowed(item.provider) && `${item.model.label} ${item.model.id} ${providerName[item.provider]}`.toLowerCase().includes(search))
    : rail === "favorites" ? all.filter(item => allowed(item.provider) && favorites.includes(key(item.provider, item.model.id)))
    : all.filter(item => item.provider === rail);
  // Legacy models stay reachable but folded, unless favorited or found by search.
  const current = search ? matches : matches.filter(item => !item.model.legacy || favorites.includes(key(item.provider, item.model.id)));
  const legacy = search || rail === "favorites" ? [] : matches.filter(item => item.model.legacy && !favorites.includes(key(item.provider, item.model.id)));
  const row = (item: {provider: AgentProvider; model: AgentModel}) => {
    const selected = value?.provider === item.provider && value.model === item.model.id;
    const favorite = favorites.includes(key(item.provider, item.model.id));
    const Icon = providerIcon[item.provider];
    return <div key={key(item.provider, item.model.id)} role="option" aria-selected={selected} tabIndex={0} onClick={() => allowed(item.provider) && onChange({provider: item.provider, model: item.model.id})} onKeyDown={event => {if (event.key === "Enter" && allowed(item.provider)) onChange({provider: item.provider, model: item.model.id});}}
      className={cn("group relative flex w-full min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 outline-none transition-[background-color,color] hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))]", selected && "bg-foreground/[0.08] text-foreground")}>
      <div className="min-w-0 flex-1 text-left">
        <div className="min-w-0 truncate text-xs font-medium leading-snug">{item.model.label}</div>
        <div className="mt-1 flex items-center gap-1.5"><Icon className="size-3 shrink-0" /><span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">{providerName[item.provider]}</span></div>
      </div>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={favorite ? t.removeFavorite : t.addFavorite} onClick={event => {event.stopPropagation(); toggleFavorite(item.provider, item.model.id);}} className={cn("-mr-1 shrink-0 text-muted-foreground/70 opacity-64 transition-[color,opacity] hover:text-foreground hover:opacity-100 group-hover:opacity-100", favorite && "text-foreground opacity-100")}>
        <StarIcon className={cn("size-3", favorite && "fill-current text-yellow-500")} />
      </Button>
    </div>;
  };
  const railButton = "relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
  const indicator = <span className="pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary" />;
  return <div className="relative flex max-h-86.5 w-screen max-w-90 flex-row overflow-hidden" data-model-picker-content>
    {!search && <div className="w-11 shrink-0 overflow-hidden bg-muted/30">
      <div className="relative flex min-h-full flex-col gap-1 p-1">
        <div className="relative w-full"><button type="button" className={railButton} aria-label={t.favorites} title={t.favorites} onClick={() => setRail("favorites")}><StarIcon className="size-5 shrink-0 fill-current" aria-hidden /></button>{rail === "favorites" && indicator}</div>
        <div className="border-b border-border/70" aria-hidden="true" />
        {providers.map(item => {
          const Icon = providerIcon[item.provider];
          const disabled = !allowed(item.provider);
          return <div key={item.provider} className="relative w-full"><button type="button" className={railButton} disabled={disabled} aria-label={providerName[item.provider]} title={disabled ? t.providerLocked.replace("{provider}", providerName[item.provider]) : providerName[item.provider]} onClick={() => setRail(item.provider)}><Icon className="size-5" /></button>{rail === item.provider && indicator}</div>;
        })}
      </div>
    </div>}
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40", !search && "border-l border-border/70")}>
      <div className="px-2 pt-2">
        <div className="flex items-center gap-1.5 border-b border-border/70 pb-2.5 transition-colors focus-within:border-ring">
          <SearchIcon className="size-4 shrink-0 -translate-x-0.5 text-muted-foreground opacity-70" />
          <input ref={node => node?.focus({preventScroll: true})} value={query} onChange={event => setQuery(event.target.value)} placeholder={t.searchModels} className="h-6.5 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60" />
        </div>
      </div>
      <div role="listbox" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain py-1.5 pr-px pl-2">
        {current.map(row)}
        {!!legacy.length && <>
          <button type="button" aria-expanded={legacyOpen} onClick={() => setLegacyOpen(value => !value)} className="group flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))]">
            <div className="min-w-0 flex-1"><div className="text-xs font-medium leading-snug">{t.legacyModels}</div><div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">{legacy.length} {t.models}</div></div>
            <ChevronRightIcon className={cn("size-4 transition-transform", legacyOpen && "rotate-90")} />
          </button>
          {legacyOpen && legacy.map(row)}
        </>}
        {!current.length && !legacy.length && <p className="py-6 text-center text-xs text-muted-foreground">{rail === "favorites" && !search ? t.noFavorites : t.noModels}</p>}
      </div>
    </div>
  </div>;
}

/** The value a setting has for this turn: the chosen one, else the model's default. */
export function settingValue(setting: AgentModelSetting, settings: ModelSettings) {
  const chosen = settings[setting.id];
  if (setting.type === "boolean") return typeof chosen === "boolean" ? chosen : setting.currentValue ?? false;
  return typeof chosen === "string" && setting.options.some(option => option.id === chosen) ? chosen : setting.options.find(option => option.isDefault)?.id ?? setting.options[0]?.id ?? "";
}

/** Reasoning effort and other per-model traits, as in T3 Code's TraitsPicker. */
export function TraitsPicker({model, settings, onChange, t}: {model?: AgentModel; settings: ModelSettings; onChange: (settings: ModelSettings) => void; t: Copy}) {
  const {locale} = useStudioLocale();
  const descriptors = translateModelSettings(model?.settings ?? [], locale);
  if (!descriptors.length) return null;
  const selects = descriptors.filter((setting): setting is Extract<AgentModelSetting, {type: "select"}> => setting.type === "select");
  const booleans = descriptors.filter((setting): setting is Extract<AgentModelSetting, {type: "boolean"}> => setting.type === "boolean");
  const fast = booleans.some(setting => setting.id === "fastMode" && settingValue(setting, settings) === true);
  const labels = [
    ...selects.map(setting => setting.options.find(option => option.id === settingValue(setting, settings))?.label ?? ""),
    ...booleans.filter(setting => setting.id !== "fastMode").map(setting => `${setting.label} ${settingValue(setting, settings) ? t.on : t.off}`),
  ].filter(Boolean);
  const label = labels.length ? labels.join(" · ") : fast ? t.fast : t.normal;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<ComposerControl className="shrink-0 whitespace-nowrap" />}>
      {fast && labels.length > 0 && <><ZapIcon aria-hidden="true" className="size-4 shrink-0 text-foreground/80" /><span className="sr-only">{t.fastModeOn}</span></>}
      <span>{label}</span>
      <ComposerControlChevron />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-56">
      {selects.map((setting, index) => <div key={setting.id}>
        {index > 0 && <DropdownMenuSeparator />}
        <DropdownMenuGroup>
          <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{setting.label}</div>
          <DropdownMenuRadioGroup value={settingValue(setting, settings)} onValueChange={value => onChange({...settings, [setting.id]: String(value)})}>
            {setting.options.map(option => <DropdownMenuRadioItem key={option.id} value={option.id} title={option.description}>
              <span className="min-w-0 truncate">{option.label}{option.isDefault && <> <Badge variant="outline" className="h-4 border-border/70 bg-muted/60 px-1.5 py-0 text-[10px] font-semibold leading-none text-muted-foreground">{t.defaultBadge}</Badge></>}</span>
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </div>)}
      {booleans.map((setting, index) => <div key={setting.id}>
        {(index > 0 || selects.length > 0) && <DropdownMenuSeparator />}
        <DropdownMenuGroup>
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{setting.label}</div>
          <DropdownMenuRadioGroup value={settingValue(setting, settings) ? "on" : "off"} onValueChange={value => onChange({...settings, [setting.id]: value === "on"})}>
            <DropdownMenuRadioItem value="on">{t.on}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="off">{t.off}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </div>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
