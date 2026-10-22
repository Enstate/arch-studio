import type { AgentAccount, AgentProvider, AgentProviderStatus } from "@arch/agent";
import { Button } from "@arch/ui/components/button";
import { ProjectPage } from "@arch/ui/components/project-layout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@arch/ui/components/select";
import { Switch } from "@arch/ui/components/switch";
import { useHotkey } from "@arch/ui/hooks/use-hotkey";
import { useTheme } from "@arch/ui/lib/theme";
import { cn } from "@arch/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, BotIcon, CheckIcon, CopyIcon, ExternalLinkIcon, InfoIcon, PaletteIcon, RefreshCwIcon, Settings2Icon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { languageNames, relativeTime, useStudioFormat } from "../lib/locale";
import type { Locale, studioText } from "../lib/messages";
import { agentRunnable, agentProvidersQuery, closeSettings, openSettings, type SettingsSection, settingsSections, useDisabledAgents } from "../lib/settings";
import { agentProviders } from "../lib/server";
import { useDesktopUpdate } from "./desktop-updates";
import { ClaudeIcon, OpenAIIcon } from "./model-picker";

type Copy = typeof studioText.de;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

const sectionIcons = {general: Settings2Icon, appearance: PaletteIcon, agents: BotIcon, about: InfoIcon} as const;
const sectionLabel = (section: SettingsSection, t: Copy) => ({general: t.general, appearance: t.appearance, agents: t.agents, about: t.about})[section];

/** Replaces the project list while Settings is open, like T3 Code's settings navigation. */
export function SettingsNav({section, t}: {section: SettingsSection; t: Copy}) {
  return <nav aria-label={t.settingsSections} className="mt-1 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
    <button type="button" onClick={closeSettings} className="mb-2 flex h-8 items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"><ArrowLeftIcon className="size-4" />{t.back}</button>
    {settingsSections.map(value => {
      const Icon = sectionIcons[value];
      return <button type="button" key={value} aria-current={section === value ? "page" : undefined} onClick={() => openSettings(value)} className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-foreground/9 aria-[current=page]:font-medium aria-[current=page]:text-foreground"><Icon className="size-4" />{sectionLabel(value, t)}</button>;
    })}
  </nav>;
}

export function SettingsPage({section, navigation, locale, changeLocale, restore, t}: {section: SettingsSection; navigation: ReactNode; locale: Locale; changeLocale: (locale: Locale) => void; restore: () => void; t: Copy}) {
  // Escape leaves Settings unless a dialog or menu has focus and handles the key itself.
  useHotkey("escape", event => {if (!(event.target instanceof Element && event.target.closest("[role=dialog],[role=menu],[role=listbox]"))) closeSettings();});
  return <ProjectPage title={<span className="flex items-center gap-1.5">{t.settings}<span className="font-normal text-muted-foreground">· {sectionLabel(section, t)}</span></span>} navigation={navigation}>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-3xl content-start gap-8 px-6 py-8 text-ui max-md:px-4 max-md:py-6">
        {section === "general" && <GeneralSettings locale={locale} changeLocale={changeLocale} restore={restore} t={t} />}
        {section === "appearance" && <AppearanceSettings t={t} />}
        {section === "agents" && <AgentSettings t={t} />}
        {section === "about" && <AboutSettings t={t} />}
      </div>
    </div>
  </ProjectPage>;
}

function SettingsGroup({title, action, description, children, className}: {title: ReactNode; action?: ReactNode; description?: ReactNode; children: ReactNode; className?: string}) {
  return <section className="grid gap-2.5">
    <div className="flex min-h-7 items-center justify-between gap-4 px-3 sm:px-4">
      <h2 className="flex items-center gap-2 text-sm text-foreground/70">{title}</h2>
      {action}
    </div>
    {description && <p className="-mt-1 max-w-xl px-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">{description}</p>}
    <div className={cn("overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50", className)}>{children}</div>
  </section>;
}

function SettingsRow({title, description, status, control, children}: {title: ReactNode; description?: ReactNode; status?: ReactNode; control?: ReactNode; children?: ReactNode}) {
  return <div data-slot="settings-row" className="@container/settings-row px-3 py-3 sm:px-4">
    <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description && <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">{description}</p>}
        {status && <div className="pt-0.5 text-xs text-muted-foreground">{status}</div>}
      </div>
      {control && <div className="flex min-w-0 items-center gap-2 @min-[32rem]/settings-row:justify-end">{control}</div>}
    </div>
    {children}
  </div>;
}

function GeneralSettings({locale, changeLocale, restore, t}: {locale: Locale; changeLocale: (locale: Locale) => void; restore: () => void; t: Copy}) {
  return <>
    <SettingsGroup title={t.general}>
      <SettingsRow title={t.language} description={t.languageHint} control={<Select value={locale} onValueChange={value => changeLocale(value as Locale)}><SelectTrigger size="sm" aria-label={t.language} className="w-full @min-[32rem]/settings-row:w-48"><SelectValue>{(value: Locale) => languageNames[value]}</SelectValue></SelectTrigger><SelectContent align="end">{(Object.keys(languageNames) as Locale[]).map(value => <SelectItem key={value} value={value} lang={value}>{languageNames[value]}</SelectItem>)}</SelectContent></Select>} />
    </SettingsGroup>
    <SettingsGroup title={t.sharing}>
      <SettingsRow title={t.openProjectFile} description={t.openProjectFileHint} control={<Button size="sm" variant="outline" onClick={restore}>{t.chooseProjectFile}</Button>} />
    </SettingsGroup>
  </>;
}

/** Small window sketches, like T3 Code's theme cards. */
function AppearanceSettings({t}: {t: Copy}) {
  const {theme, setTheme} = useTheme();
  const sketch = (mode: "light" | "dark") => <span className={cn("flex h-full flex-1 gap-1 p-1.5", mode === "dark" ? "bg-neutral-900" : "bg-neutral-100")}>
    <span className={cn("w-1/4 rounded-sm", mode === "dark" ? "bg-neutral-800" : "bg-white")} />
    <span className="flex flex-1 flex-col gap-1"><span className={cn("h-1.5 w-2/3 rounded-full", mode === "dark" ? "bg-neutral-700" : "bg-neutral-300")} /><span className={cn("flex-1 rounded-sm", mode === "dark" ? "bg-neutral-800" : "bg-white")} /></span>
  </span>;
  return <SettingsGroup title={t.appearance} description={t.appearanceHint} className="grid grid-cols-3 gap-3 border-none bg-transparent p-0 shadow-none [&>*+*]:border-t-0">
    {(["system", "light", "dark"] as const).map(value => <button type="button" key={value} aria-pressed={theme === value} onClick={() => setTheme(value)} className="group grid gap-2 rounded-xl border border-border/60 bg-card/40 p-2 text-left text-sm outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:border-ring/70 aria-pressed:bg-accent/30 aria-pressed:ring-1 aria-pressed:ring-ring/70">
      <span aria-hidden="true" className="flex h-20 overflow-hidden rounded-lg border border-border/60">{value === "system" ? <>{sketch("light")}{sketch("dark")}</> : sketch(value)}</span>
      <span className="flex items-center justify-between px-0.5 font-medium">{t[value]}{theme === value && <CheckIcon className="size-4 text-foreground" />}</span>
    </button>)}
  </SettingsGroup>;
}

const providerNames: Record<AgentProvider, string> = {claude: "Claude Code", codex: "Codex"};
const providerIcons = {claude: ClaudeIcon, codex: OpenAIIcon} as const;
const planNames: Record<string, string> = {free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", max: "Max", team: "Team", business: "Business", self_serve_business_usage_based: "Business", enterprise: "Enterprise", enterprise_cbp_usage_based: "Enterprise", edu: "Edu"};
const cloudNames: Record<string, string> = {bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", foundry: "Microsoft Foundry", anthropicAws: "Claude on AWS", anthropicGoogleCloud: "Claude on Google Cloud", gateway: "Claude gateway", mantle: "Mantle"};
const windowsHost = () => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
/** Official install and sign-in commands. Codex installs through npm on every platform. */
const setup = (provider: AgentProvider) => provider === "claude"
  ? {install: windowsHost() ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude auth login", docs: "https://docs.claude.com/en/docs/claude-code/setup"}
  : {install: "npm install -g @openai/codex", signIn: "codex login", docs: "https://developers.openai.com/codex/cli"};

export function accountLabel(provider: AgentProvider, account: AgentAccount | null, t: Copy) {
  if (!account) return null;
  if (account.kind === "api-key") return t.apiKey;
  if (account.kind === "cloud") return cloudNames[account.service] ?? account.service;
  const brand = provider === "claude" ? "Claude" : "ChatGPT";
  return fill(t.subscription, {plan: account.plan ? `${brand} ${planNames[account.plan] ?? account.plan}` : brand});
}

type Tone = "ready" | "warning" | "error" | "off" | "checking";
function agentSummary(status: AgentProviderStatus | undefined, enabled: boolean, t: Copy): {tone: Tone; headline: string} {
  if (!status) return {tone: "checking", headline: t.agentChecking};
  if (!enabled) return {tone: "off", headline: t.agentOff};
  switch (status.issue) {
    case "not-installed": return {tone: "error", headline: t.agentNotInstalled};
    case "launcher-only": return {tone: "error", headline: t.agentLauncherOnly};
    case "failed": return {tone: "error", headline: t.agentFailed};
    case "signed-out": return {tone: "warning", headline: t.agentSignedOut};
    case "unverified": return {tone: "warning", headline: t.agentUnverified};
  }
  const account = accountLabel(status.provider, status.account, t);
  return {tone: status.warnings.length || !agentRunnable(status) ? "warning" : "ready", headline: account ? `${t.agentReady} · ${account}` : t.agentReady};
}
const toneDot: Record<Tone, string> = {ready: "bg-success", warning: "bg-warning", error: "bg-destructive", off: "bg-muted-foreground/50", checking: "bg-muted-foreground/30 motion-safe:animate-pulse"};

function AgentSettings({t}: {t: Copy}) {
  const queryClient = useQueryClient();
  const format = useStudioFormat();
  const providers = useQuery(agentProvidersQuery);
  const {disabled, setAgentEnabled} = useDisabledAgents();
  const [selected, setSelected] = useState<AgentProvider>("claude");
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try { queryClient.setQueryData(agentProvidersQuery.queryKey, await agentProviders({data: {refresh: true}})); }
    catch { await queryClient.invalidateQueries({queryKey: agentProvidersQuery.queryKey}); }
    finally { setRefreshing(false); }
  };
  const checkedAt = providers.data?.map(item => Date.parse(item.checkedAt)).sort((a, b) => b - a)[0];
  const busy = refreshing || providers.isFetching;
  const statusOf = (provider: AgentProvider) => providers.data?.find(item => item.provider === provider);
  const action = <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void refresh()} title={t.checkAgain}>
    <RefreshCwIcon className={busy ? "motion-safe:animate-spin" : undefined} />{busy ? t.checking : checkedAt ? fill(t.checkedAt, {time: relativeTime(checkedAt, Date.now(), format)}) : t.checkAgain}
  </Button>;
  return <SettingsGroup title={t.agents} description={t.agentsHint} action={action} className="@container/agents">
    <div className="grid @min-[44rem]/agents:grid-cols-[15rem_minmax(0,1fr)]">
      <ul className="divide-y divide-border/50 border-border/50 bg-muted/10 @max-[44rem]/agents:border-b @min-[44rem]/agents:border-r">
        {(["claude", "codex"] as const).map(provider => {
          const summary = agentSummary(statusOf(provider), !disabled.includes(provider), t);
          const Icon = providerIcons[provider];
          return <li key={provider} className={cn("relative flex min-h-16 items-center gap-3 px-3 py-3 transition-colors sm:px-4", selected === provider ? "bg-muted/45" : "hover:bg-muted/25")}>
            <button type="button" aria-pressed={selected === provider} onClick={() => setSelected(provider)} className="absolute inset-0 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset" aria-label={providerNames[provider]} />
            <Icon aria-hidden="true" className="pointer-events-none size-4 shrink-0" />
            <span className={cn("pointer-events-none min-w-0 flex-1", summary.tone === "off" && selected !== provider && "opacity-60")}>
              <span className="block truncate text-sm font-medium">{providerNames[provider]}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground/80"><span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", toneDot[summary.tone])} /><span className="line-clamp-2">{summary.headline}</span></span>
            </span>
            <Switch className="relative" checked={!disabled.includes(provider)} onCheckedChange={checked => setAgentEnabled(provider, checked)} aria-label={fill(t.useAgent, {provider: providerNames[provider]})} />
          </li>;
        })}
      </ul>
      <AgentDetails key={selected} provider={selected} status={statusOf(selected)} enabled={!disabled.includes(selected)} summary={agentSummary(statusOf(selected), !disabled.includes(selected), t)} t={t} />
    </div>
  </SettingsGroup>;
}

function CommandBox({command, t}: {command: string; t: Copy}) {
  const [copied, setCopied] = useState(false);
  return <div className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/40 py-1 pr-1 pl-2.5">
    <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap select-all [scrollbar-width:none]">{command}</code>
    <Button size="icon-xs" variant="ghost" aria-label={copied ? t.copied : t.copyCommand} title={copied ? t.copied : t.copyCommand} onClick={() => void navigator.clipboard.writeText(command).then(() => {setCopied(true); setTimeout(() => setCopied(false), 1500);})}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>
  </div>;
}

function Notice({tone, title, children}: {tone: "warning" | "error"; title: string; children: ReactNode}) {
  return <div role={tone === "error" ? "alert" : "status"} className={cn("grid gap-2.5 rounded-lg border p-3", tone === "error" ? "border-destructive/30 bg-destructive/5" : "border-warning/30 bg-warning/5")}>
    <p className="flex items-center gap-2 text-sm font-medium"><TriangleAlertIcon className={cn("size-4 shrink-0", tone === "error" ? "text-destructive" : "text-warning")} />{title}</p>
    {children}
  </div>;
}

function AgentDetails({provider, status, enabled, summary, t}: {provider: AgentProvider; status: AgentProviderStatus | undefined; enabled: boolean; summary: {tone: Tone; headline: string}; t: Copy}) {
  const [showEmail, setShowEmail] = useState(false);
  const name = providerNames[provider];
  const commands = setup(provider);
  const values = {provider: name, terminal: windowsHost() ? t.powershell : t.terminal};
  const guide = <a href={commands.docs} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{t.setupGuide}<ExternalLinkIcon className="size-3" /></a>;
  const issue = status?.issue;
  const account = status ? accountLabel(provider, status.account, t) : null;
  const email = status?.account?.kind === "subscription" ? status.account.email : null;
  const current = status?.models.filter(model => !model.legacy) ?? [];
  const Icon = providerIcons[provider];
  return <div className="grid min-w-0 content-start gap-4 p-4">
    <div className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border/60 bg-muted/30"><Icon aria-hidden="true" className="size-4.5" /></span>
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-base font-medium">{name}{status?.version && <code className="text-xs font-normal text-muted-foreground">v{status.version}</code>}</h3>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", toneDot[summary.tone])} />{summary.headline}</p>
      </div>
    </div>
    {!enabled && <p className="text-xs text-muted-foreground">{fill(t.agentOffHint, values)}</p>}
    {issue === "not-installed" && <Notice tone="error" title={fill(t.installTitle, values)}><p className="text-xs text-muted-foreground">{fill(t.installHint, values)}</p><CommandBox command={commands.install} t={t} />{guide}</Notice>}
    {issue === "launcher-only" && <Notice tone="error" title={fill(t.reinstallTitle, values)}><p className="text-xs text-muted-foreground">{fill(t.reinstallHint, values)}</p><CommandBox command={commands.install} t={t} />{guide}</Notice>}
    {(issue === "signed-out" || issue === "unverified") && <Notice tone="warning" title={fill(t.signInTitle, values)}><p className="text-xs text-muted-foreground">{fill(issue === "signed-out" ? t.signInHint : t.unverifiedHint, values)}</p><CommandBox command={commands.signIn} t={t} /></Notice>}
    {issue === "failed" && <Notice tone="error" title={fill(t.failedTitle, values)}><p className="text-xs text-muted-foreground">{fill(t.failedHint, values)}</p><CommandBox command={provider} t={t} />{guide}</Notice>}
    {status?.warnings.includes("git-bash-missing") && <Notice tone="warning" title={t.gitBashTitle}><p className="text-xs text-muted-foreground">{t.gitBashHint}</p><a href="https://git-scm.com/downloads/win" target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{t.downloadGit}<ExternalLinkIcon className="size-3" /></a></Notice>}
    {status?.installed && <div className="overflow-hidden rounded-lg border border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
      {account && <SettingsRow title={t.account} description={account} status={email && (showEmail ? fill(t.signedInAs, {email}) : <button type="button" className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => setShowEmail(true)}>{t.showEmail}</button>)} />}
      {status.executable && <SettingsRow title={t.agentProgram} description={fill(t.agentProgramHint, values)} status={<code className="block truncate font-mono text-xs" title={status.executable}>{status.executable}</code>} />}
      {!!current.length && <SettingsRow title={t.agentModels} description={t.agentModelsHint}>
        <ul className="flex flex-wrap gap-1.5 pt-2.5 pb-0.5">{current.map(model => <li key={model.id} className="rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-xs">{model.label}</li>)}</ul>
      </SettingsRow>}
    </div>}
  </div>;
}

function AboutSettings({t}: {t: Copy}) {
  const control = useDesktopUpdate(t);
  return <SettingsGroup title={t.about}>
    <SettingsRow title={control ? `${t.appVersion} ${control.update.currentVersion}` : t.appVersion} description={control ? t.appVersionHint : t.browserAbout} status={control && control.update.status !== "disabled" ? <span role="status">{control.label}{control.update.version ? ` · ${control.update.version}` : ""}</span> : control?.label} control={control?.actionButton}>
      {control?.failure && <div className="pt-2">{control.failure}</div>}
      {control?.confirmation}
    </SettingsRow>
  </SettingsGroup>;
}
