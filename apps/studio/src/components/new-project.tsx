import { StudioFailure } from "./studio-failure";
import { studioFailure } from "../lib/studio-errors";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentTitle } from "@arch/ui/components/attachment";
import { Button } from "@arch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { Field, FieldLabel } from "@arch/ui/components/field";
import { Input } from "@arch/ui/components/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@arch/ui/components/select";
import { Textarea } from "@arch/ui/components/textarea";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "@arch/ui/components/sonner";
import { createProject, createThread, grantBuilds, startRound } from "../lib/server";
import { agentProvidersQuery, agentRunnable, useDisabledAgents } from "../lib/settings";
import type { StudioClient } from "../lib/model";
import type { studioText } from "../lib/messages";
import { useStudioFormat, useStudioLocale } from "../lib/locale";

const accepted = ".pdf,.png,.jpg,.jpeg,.webp,.svg,.txt,.md,.json";
const noClient = "none";
const addClient = "new";
const intakeRequest = (brief: string) => `Review every reference in this new project and complete intake as AGENTS.md and BUILDERS.md describe: classify the documents, update source/intake.json, and record assumptions and open questions. Do not author geometry unless the references settle scale, structure and openings.${brief ? `\n\nBrief from the user:\n${brief}` : ""}`;

/** Name, references and an optional brief become a ready project folder in one step. */
export function NewProject({open, setOpen, clients, defaultClientId, created, t}: {open: boolean; setOpen: (open: boolean) => void; clients: StudioClient[]; defaultClientId?: string; created: (value: {clientId: string; projectId: string; threadId?: string}) => void; t: typeof studioText.en}) {
  const format = useStudioFormat();
  const {locale} = useStudioLocale();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [references, setReferences] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const providers = useQuery({...agentProvidersQuery, enabled: open});
  const {disabled} = useDisabledAgents();
  const agent = providers.data?.find(item => !disabled.includes(item.provider) && agentRunnable(item));
  const create = useMutation({
    mutationFn: async (values: {name: string; client: string; clientName: string; brief: string; startIntake: boolean}) => {
      const data = new FormData();
      data.set("name", values.name);
      data.set("brief", values.brief);
      if (values.client === addClient) data.set("clientName", values.clientName);
      else if (values.client !== noClient) data.set("clientId", values.client);
      for (const file of references) data.append("references", file);
      const created: {clientId: string; projectId: string; threadId?: string} = await createProject({data});
      // Starting now is the explicit execution confirmation for this project.
      if (values.startIntake && agent && references.length) {
        // The project exists either way. A failed start leaves it ready for a manual first round.
        try {
          await grantBuilds({data: {projectId: created.projectId, branch: "main"}});
          // The review runs in the project's first conversation, which then opens.
          const {threadId} = await createThread({data: {projectId: created.projectId}});
          const round = new FormData();
          round.set("projectId", created.projectId); round.set("threadId", threadId); round.set("kind", "request"); round.set("settings", "{}");
          round.set("request", intakeRequest(values.brief.trim())); round.set("provider", agent.provider); round.set("model", agent.models[0]!.id);
          await startRound({data: round});
          created.threadId = threadId;
        } catch (error) {toast.error(t.intakeFailed, {description: error instanceof Error ? studioFailure(error, locale).message : undefined});}
      }
      return created;
    },
    onSuccess: async value => {await queryClient.invalidateQueries(); created(value); setOpen(false);},
  });
  const form = useForm({
    defaultValues: {name: "", client: defaultClientId ?? noClient, clientName: "", brief: "", startIntake: false},
    onSubmit: ({value}) => {if (!create.isPending) create.mutate(value);},
  });
  const add = (files: FileList | null) => {
    if (!files) return;
    const selected = [...files];
    setReferences(current => [...current, ...selected.filter(file => !current.some(item => item.name === file.name && item.size === file.size))].slice(0, 100));
  };
  const reset = (value: boolean) => {
    if (create.isPending) return;
    if (value) {create.reset(); form.reset(); setReferences([]);}
    setOpen(value);
  };
  const clientLabel = (value: string) => value === noClient ? t.noClient : value === addClient ? t.newClientOption : clients.find(client => client.id === value)?.name ?? value;
  return <Dialog open={open} onOpenChange={reset}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t.newProject}</DialogTitle><DialogDescription>{t.newProjectHint}</DialogDescription></DialogHeader>
    <form autoComplete="off" className="grid gap-4 text-ui" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}}>
      <form.Field name="name">{field => <Field className="gap-2"><FieldLabel htmlFor="new-project-name" className="text-ui font-normal">{t.name}</FieldLabel><Input id="new-project-name" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required maxLength={160} disabled={create.isPending} /></Field>}</form.Field>
      <form.Field name="client">{field => <Field className="gap-2"><FieldLabel className="text-ui font-normal">{t.clientLabel}</FieldLabel><Select value={field.state.value} onValueChange={value => field.handleChange(String(value))} disabled={create.isPending}><SelectTrigger className="w-full"><SelectValue>{(value: string) => clientLabel(value)}</SelectValue></SelectTrigger><SelectContent><SelectItem value={noClient}>{t.noClient}</SelectItem>{clients.filter(client => client.id !== "local").map(client => <SelectItem key={client.id} value={client.id}>{client.name}</SelectItem>)}<SelectSeparator /><SelectItem value={addClient}>{t.newClientOption}</SelectItem></SelectContent></Select></Field>}</form.Field>
      <form.Subscribe selector={state => state.values.client}>{client => client === addClient && <form.Field name="clientName">{field => <Field className="gap-2"><FieldLabel htmlFor="new-project-client" className="text-ui font-normal">{t.clientName}</FieldLabel><Input id="new-project-client" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required maxLength={160} disabled={create.isPending} /></Field>}</form.Field>}</form.Subscribe>
      <Field className="gap-2"><FieldLabel htmlFor="new-project-references" className="text-ui font-normal">{t.referencesLabel}</FieldLabel>
        <fieldset aria-label={t.referencesLabel} data-dragging={dragging || undefined} onDragOver={event => {event.preventDefault(); setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={event => {event.preventDefault(); setDragging(false); add(event.dataTransfer.files);}} className="grid place-items-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center text-xs text-muted-foreground data-dragging:border-ring data-dragging:bg-foreground/4">
          <p>{t.referencesHint}</p>
          <Button type="button" size="sm" variant="outline" disabled={create.isPending} onClick={() => input.current?.click()}>{t.addReferences}</Button>
          <input ref={input} id="new-project-references" type="file" multiple accept={accepted} className="sr-only" tabIndex={-1} onChange={event => {add(event.target.files); event.target.value = "";}} />
        </fieldset>
        {!!references.length && <AttachmentGroup className="max-h-40 overflow-y-auto">{references.map(file => <Attachment key={`${file.name}:${file.size}`} size="xs"><FileIcon className="size-3.5 text-muted-foreground" /><AttachmentContent><AttachmentTitle>{file.name}</AttachmentTitle><AttachmentDescription>{format.number(Math.max(1, Math.round(file.size / 1024)), {style: "unit", unit: "kilobyte", unitDisplay: "short"})}</AttachmentDescription></AttachmentContent><AttachmentActions><AttachmentAction aria-label={`${t.removeFile}: ${file.name}`} disabled={create.isPending} onClick={() => setReferences(current => current.filter(item => item !== file))}><XIcon /></AttachmentAction></AttachmentActions></Attachment>)}</AttachmentGroup>}
      </Field>
      <form.Field name="brief">{field => <Field className="gap-2"><FieldLabel htmlFor="new-project-brief" className="text-ui font-normal">{t.briefLabel}</FieldLabel><Textarea id="new-project-brief" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" maxLength={4000} rows={3} placeholder={t.briefPlaceholder} disabled={create.isPending} /></Field>}</form.Field>
      {agent && !!references.length && <form.Field name="startIntake">{field => <Field orientation="horizontal" className="items-start gap-2"><input id="new-project-intake" type="checkbox" name={field.name} checked={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.checked)} className="mt-0.5" disabled={create.isPending} /><FieldLabel htmlFor="new-project-intake" className="grid gap-0.5 text-ui font-normal"><span>{t.startIntake}</span><span className="text-xs text-muted-foreground">{t.startIntakeHint}</span></FieldLabel></Field>}</form.Field>}
      {create.error && <StudioFailure className="text-destructive" error={create.error} />}
      <Button type="submit" disabled={create.isPending}>{create.isPending ? t.creatingProject : t.create}</Button>
    </form>
  </DialogContent></Dialog>;
}
