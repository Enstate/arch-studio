import { failureCode, redactDiagnostics } from "./diagnostics";
import { type Locale, studioText } from "./messages";

const en = {
  generic: "That didn't work. Try again.", details: "Technical details",
  ARCH_REFERENCE_FILES: "Choose PDF, PNG, JPEG, WebP, SVG, text, Markdown or JSON files, or DXF, CSV and GeoJSON survey data. Each file must be between 1 byte and 100 MiB.",
  ARCH_ATTACHMENTS: "Images must be between 1 byte and 10 MiB. PDF, SVG, text, Markdown and JSON files can be up to 100 MiB.",
  ARCH_IMAGE_LIMIT: "Attach up to 8 images per message.",
  ARCH_SOURCE_REQUIRED: "Open a project folder first.",
  ARCH_SOURCE_CHANGED: "This folder belongs to a different project. Open the original project folder.",
  ARCH_CLIENT_CHANGED: "The client ID in the project folder has changed. Restore its original client ID to continue.",
  ARCH_SOURCE_ATTACHED: "This project already has a folder. Continue working in that folder.",
  ARCH_SOURCE_IN_USE: "This folder is already linked to another project in Studio.",
  ARCH_SOURCE_IMPORT: "Studio could not open this project folder. Try opening it again.",
  ARCH_CLIENT_MISSING: "This client is no longer available. Choose another client.",
  ARCH_BUILDS_REQUIRED: "Allow Studio to run this project's code locally before continuing. Only allow this for a project you trust.",
  ARCH_VERSION_REQUIRED: "Create a version before asking for a critique.",
  ARCH_ROUND_RUNNING: "The agent is already working in this conversation. Wait for it to finish or stop it.",
  ARCH_AGENT_LOCKED: "This conversation uses its existing agent. Start a new conversation to use another agent.",
  ARCH_EDITS_BUSY: "The agent is working on this design. Save your changes when it finishes.",
  ARCH_STOP_TO_ARCHIVE: "Stop the agent before archiving this conversation.",
  ARCH_RESTORE_VARIANT: "Restore this archived variant before working on it.",
  ARCH_RESUME_STOPPED: "Only a stopped or failed request can continue.",
  ARCH_ROUND_STOPPED: "The agent is no longer working on this. Refresh to see the latest status.",
  ARCH_NO_APPROVAL: "The agent is no longer waiting for approval. Refresh to see the latest status.",
  ARCH_NO_QUESTION: "The agent is no longer waiting for this answer. Refresh to see the latest status.",
  ARCH_ITEM_MISSING: "This item is no longer available. Refresh and try again.",
  ARCH_PROJECT_EXISTS: "This project is already in Studio. Open the existing project instead.",
  ARCH_PACKAGE_INVALID: "This file is not a valid Arch Studio project, or it is damaged. Ask for a new export.",
  ARCH_EXPORT_NEEDS_VERSION: "Create a version before exporting this project.",
  ARCH_PACKAGE_EXPIRED: "This file was opened too long ago. Choose it again.",
  ARCH_PROJECT_BUSY: "Studio is still saving or updating this project. Try again in a moment.",
  ARCH_RESTORE_BUSY: "A round or build is working in this project. Restore it when that finishes.",
  ARCH_NO_SAVED_VERSION: "This project has no saved version to go back to yet.",
  ARCH_PROJECT_FILE: "A file in the project folder isn't valid.",
  copyDetails: "Copy details", copiedDetails: "Copied",
  fileInvalid: "The file {file} isn't valid: {problem}.",
  fileTooLong: "{field} is longer than {max} characters", fileTooMany: "{field} has more than {max} entries",
  fileEmpty: "{field} is empty", fileMissing: "{field} is missing", fileUnexpected: "{field} doesn't belong there",
  fileNotJson: "it can't be read as JSON", fileBadValue: "{field} has a value Studio can't use",
  ARCH_PROJECT_WORKING: "The agent is working on this project. Change this when it finishes.",
  ARCH_LOCATION_UNAVAILABLE: "Couldn't reach OpenStreetMap. Paste the coordinates or a Google Maps link instead.",
};
const copy: Record<Locale, Record<keyof typeof en, string>> = {
  en,
  de: {
    generic: "Das hat nicht geklappt. Versuch es noch einmal.", details: "Technische Details",
    ARCH_REFERENCE_FILES: "Wähle PDF-, PNG-, JPEG-, WebP-, SVG-, Text-, Markdown- oder JSON-Dateien oder Vermessungsdaten als DXF, CSV oder GeoJSON. Jede Datei muss zwischen 1 Byte und 100 MiB groß sein.",
    ARCH_ATTACHMENTS: "Bilder müssen zwischen 1 Byte und 10 MiB groß sein. PDF-, SVG-, Text-, Markdown- und JSON-Dateien dürfen bis zu 100 MiB groß sein.",
    ARCH_IMAGE_LIMIT: "Hänge bis zu 8 Bilder pro Nachricht an.",
    ARCH_SOURCE_REQUIRED: "Öffne zuerst einen Projektordner.",
    ARCH_SOURCE_CHANGED: "Dieser Ordner gehört zu einem anderen Projekt. Öffne den ursprünglichen Projektordner.",
    ARCH_CLIENT_CHANGED: "Die Kunden-ID im Projektordner hat sich geändert. Stelle die ursprüngliche Kunden-ID wieder her, um fortzufahren.",
    ARCH_SOURCE_ATTACHED: "Dieses Projekt hat bereits einen Ordner. Arbeite in diesem Ordner weiter.",
    ARCH_SOURCE_IN_USE: "Dieser Ordner ist bereits mit einem anderen Projekt in Studio verknüpft.",
    ARCH_SOURCE_IMPORT: "Studio konnte diesen Projektordner nicht öffnen. Versuch es noch einmal.",
    ARCH_CLIENT_MISSING: "Dieser Kunde ist nicht mehr verfügbar. Wähle einen anderen Kunden.",
    ARCH_BUILDS_REQUIRED: "Erlaube Studio zuerst, den Code dieses Projekts lokal auszuführen. Erlaube das nur für ein Projekt, dem du vertraust.",
    ARCH_VERSION_REQUIRED: "Erstelle zuerst eine Version, die geprüft werden kann.",
    ARCH_ROUND_RUNNING: "Der Agent arbeitet bereits in diesem Gespräch. Warte, bis er fertig ist, oder stoppe ihn.",
    ARCH_AGENT_LOCKED: "Dieses Gespräch nutzt seinen bisherigen Agenten. Beginne ein neues Gespräch, um einen anderen Agenten zu nutzen.",
    ARCH_EDITS_BUSY: "Der Agent arbeitet an diesem Entwurf. Speichere deine Änderungen, sobald er fertig ist.",
    ARCH_STOP_TO_ARCHIVE: "Stoppe den Agenten, bevor du dieses Gespräch archivierst.",
    ARCH_RESTORE_VARIANT: "Stelle diese archivierte Variante wieder her, bevor du daran arbeitest.",
    ARCH_RESUME_STOPPED: "Nur eine gestoppte oder fehlgeschlagene Anfrage kann fortgesetzt werden.",
    ARCH_ROUND_STOPPED: "Der Agent arbeitet nicht mehr daran. Lade die Seite neu, um den aktuellen Stand zu sehen.",
    ARCH_NO_APPROVAL: "Der Agent wartet nicht mehr auf eine Freigabe. Lade die Seite neu, um den aktuellen Stand zu sehen.",
    ARCH_NO_QUESTION: "Der Agent wartet nicht mehr auf diese Antwort. Lade die Seite neu, um den aktuellen Stand zu sehen.",
    ARCH_ITEM_MISSING: "Dieser Eintrag ist nicht mehr verfügbar. Lade die Seite neu und versuch es noch einmal.",
    ARCH_PROJECT_EXISTS: "Dieses Projekt ist bereits in Studio. Öffne stattdessen das vorhandene Projekt.",
    ARCH_PACKAGE_INVALID: "Diese Datei ist kein gültiges Arch-Studio-Projekt oder sie ist beschädigt. Bitte um einen neuen Export.",
    ARCH_EXPORT_NEEDS_VERSION: "Erstelle eine Version, bevor du dieses Projekt exportierst.",
    ARCH_PACKAGE_EXPIRED: "Diese Datei wurde vor zu langer Zeit geöffnet. Wähle sie noch einmal aus.",
    ARCH_PROJECT_BUSY: "Studio speichert oder aktualisiert dieses Projekt gerade. Versuch es gleich noch einmal.",
    ARCH_RESTORE_BUSY: "In diesem Projekt läuft gerade eine Runde oder ein Build. Stelle es wieder her, sobald das fertig ist.",
    ARCH_NO_SAVED_VERSION: "Dieses Projekt hat noch keine gespeicherte Version, zu der es zurückkehren kann.",
    ARCH_PROJECT_FILE: "Eine Datei im Projektordner ist ungültig.",
    copyDetails: "Details kopieren", copiedDetails: "Kopiert",
    fileInvalid: "Die Datei {file} ist ungültig: {problem}.",
    fileTooLong: "{field} hat mehr als {max} Zeichen", fileTooMany: "{field} hat mehr als {max} Einträge",
    fileEmpty: "{field} ist leer", fileMissing: "{field} fehlt", fileUnexpected: "{field} gehört nicht hierher",
    fileNotJson: "sie lässt sich nicht als JSON lesen", fileBadValue: "{field} hat einen Wert, den Studio nicht verwenden kann",
    ARCH_PROJECT_WORKING: "Der Agent arbeitet gerade an diesem Projekt. Ändere das, wenn er fertig ist.",
    ARCH_LOCATION_UNAVAILABLE: "OpenStreetMap ist nicht erreichbar. Füge stattdessen die Koordinaten oder einen Google-Maps-Link ein.",
  },
  es: {
    generic: "No se pudo completar la acción. Inténtalo de nuevo.", details: "Detalles técnicos",
    ARCH_REFERENCE_FILES: "Elige archivos PDF, PNG, JPEG, WebP, SVG, texto, Markdown o JSON, o levantamientos en DXF, CSV o GeoJSON. Cada archivo debe tener entre 1 byte y 100 MiB.",
    ARCH_ATTACHMENTS: "Las imágenes deben tener entre 1 byte y 10 MiB. Los archivos PDF, SVG, texto, Markdown y JSON pueden tener hasta 100 MiB.",
    ARCH_IMAGE_LIMIT: "Adjunta hasta 8 imágenes por mensaje.",
    ARCH_SOURCE_REQUIRED: "Abre primero una carpeta de proyecto.",
    ARCH_SOURCE_CHANGED: "Esta carpeta pertenece a otro proyecto. Abre la carpeta original del proyecto.",
    ARCH_CLIENT_CHANGED: "El ID del cliente cambió en la carpeta del proyecto. Restablece su ID original para continuar.",
    ARCH_SOURCE_ATTACHED: "Este proyecto ya tiene una carpeta. Sigue trabajando en esa carpeta.",
    ARCH_SOURCE_IN_USE: "Esta carpeta ya está vinculada a otro proyecto en Studio.",
    ARCH_SOURCE_IMPORT: "Studio no pudo abrir esta carpeta de proyecto. Intenta abrirla de nuevo.",
    ARCH_CLIENT_MISSING: "Este cliente ya no está disponible. Elige otro cliente.",
    ARCH_BUILDS_REQUIRED: "Permite que Studio ejecute el código de este proyecto en tu equipo antes de continuar. Hazlo solo si confías en el proyecto.",
    ARCH_VERSION_REQUIRED: "Crea una versión antes de pedir una crítica.",
    ARCH_ROUND_RUNNING: "El agente ya está trabajando en esta conversación. Espera a que termine o detenlo.",
    ARCH_AGENT_LOCKED: "Esta conversación usa su agente actual. Inicia otra conversación para usar otro agente.",
    ARCH_EDITS_BUSY: "El agente está trabajando en este diseño. Guarda tus cambios cuando termine.",
    ARCH_STOP_TO_ARCHIVE: "Detén al agente antes de archivar esta conversación.",
    ARCH_RESTORE_VARIANT: "Restaura esta variante archivada antes de trabajar en ella.",
    ARCH_RESUME_STOPPED: "Solo puedes continuar una solicitud detenida o fallida.",
    ARCH_ROUND_STOPPED: "El agente ya no está trabajando en esto. Actualiza la página para ver el estado.",
    ARCH_NO_APPROVAL: "El agente ya no espera un permiso. Actualiza la página para ver el estado.",
    ARCH_NO_QUESTION: "El agente ya no espera esta respuesta. Actualiza la página para ver el estado.",
    ARCH_ITEM_MISSING: "Este elemento ya no está disponible. Actualiza la página e inténtalo de nuevo.",
    ARCH_PROJECT_EXISTS: "Este proyecto ya está en Studio. Abre el proyecto existente.",
    ARCH_PACKAGE_INVALID: "Este archivo no es un proyecto válido de Arch Studio o está dañado. Pide una nueva exportación.",
    ARCH_EXPORT_NEEDS_VERSION: "Crea una versión antes de exportar este proyecto.",
    ARCH_PACKAGE_EXPIRED: "Este archivo se abrió hace demasiado tiempo. Vuelve a elegirlo.",
    ARCH_PROJECT_BUSY: "Studio todavía está guardando o actualizando este proyecto. Inténtalo de nuevo en un momento.",
    ARCH_RESTORE_BUSY: "Hay una ronda o una generación en curso en este proyecto. Restáuralo cuando termine.",
    ARCH_NO_SAVED_VERSION: "Este proyecto aún no tiene una versión guardada a la que volver.",
    ARCH_PROJECT_FILE: "Un archivo de la carpeta del proyecto no es válido.",
    copyDetails: "Copiar detalles", copiedDetails: "Copiado",
    fileInvalid: "El archivo {file} no es válido: {problem}.",
    fileTooLong: "{field} tiene más de {max} caracteres", fileTooMany: "{field} tiene más de {max} elementos",
    fileEmpty: "{field} está vacío", fileMissing: "falta {field}", fileUnexpected: "{field} no debería estar ahí",
    fileNotJson: "no se puede leer como JSON", fileBadValue: "{field} tiene un valor que Studio no puede usar",
    ARCH_PROJECT_WORKING: "El agente está trabajando en este proyecto. Cámbialo cuando termine.",
    ARCH_LOCATION_UNAVAILABLE: "No se pudo conectar con OpenStreetMap. Pega las coordenadas o un enlace de Google Maps.",
  },
  pt: {
    generic: "Não foi possível concluir a ação. Tente novamente.", details: "Detalhes técnicos",
    ARCH_REFERENCE_FILES: "Escolha arquivos PDF, PNG, JPEG, WebP, SVG, texto, Markdown ou JSON, ou levantamentos em DXF, CSV ou GeoJSON. Cada arquivo deve ter entre 1 byte e 100 MiB.",
    ARCH_ATTACHMENTS: "As imagens devem ter entre 1 byte e 10 MiB. Arquivos PDF, SVG, texto, Markdown e JSON podem ter até 100 MiB.",
    ARCH_IMAGE_LIMIT: "Anexe até 8 imagens por mensagem.",
    ARCH_SOURCE_REQUIRED: "Abra primeiro uma pasta de projeto.",
    ARCH_SOURCE_CHANGED: "Esta pasta pertence a outro projeto. Abra a pasta original do projeto.",
    ARCH_CLIENT_CHANGED: "O ID do cliente mudou na pasta do projeto. Restaure o ID original para continuar.",
    ARCH_SOURCE_ATTACHED: "Este projeto já tem uma pasta. Continue trabalhando nessa pasta.",
    ARCH_SOURCE_IN_USE: "Esta pasta já está vinculada a outro projeto no Studio.",
    ARCH_SOURCE_IMPORT: "O Studio não conseguiu abrir esta pasta de projeto. Tente abri-la novamente.",
    ARCH_CLIENT_MISSING: "Este cliente não está mais disponível. Escolha outro cliente.",
    ARCH_BUILDS_REQUIRED: "Permita que o Studio execute o código deste projeto no seu computador antes de continuar. Faça isso apenas se confiar no projeto.",
    ARCH_VERSION_REQUIRED: "Crie uma versão antes de pedir uma crítica.",
    ARCH_ROUND_RUNNING: "O agente já está trabalhando nesta conversa. Espere terminar ou interrompa o agente.",
    ARCH_AGENT_LOCKED: "Esta conversa usa o agente atual. Inicie outra conversa para usar outro agente.",
    ARCH_EDITS_BUSY: "O agente está trabalhando nesta variante. Salve suas alterações quando ele terminar.",
    ARCH_STOP_TO_ARCHIVE: "Interrompa o agente antes de arquivar esta conversa.",
    ARCH_RESTORE_VARIANT: "Restaure esta variante arquivada antes de trabalhar nela.",
    ARCH_RESUME_STOPPED: "Você só pode continuar uma solicitação interrompida ou que falhou.",
    ARCH_ROUND_STOPPED: "O agente não está mais trabalhando nisso. Atualize a página para ver o status.",
    ARCH_NO_APPROVAL: "O agente não está mais esperando uma permissão. Atualize a página para ver o status.",
    ARCH_NO_QUESTION: "O agente não está mais esperando esta resposta. Atualize a página para ver o status.",
    ARCH_ITEM_MISSING: "Este item não está mais disponível. Atualize a página e tente novamente.",
    ARCH_PROJECT_EXISTS: "Este projeto já está no Studio. Abra o projeto existente.",
    ARCH_PACKAGE_INVALID: "Este arquivo não é um projeto válido do Arch Studio ou está danificado. Peça uma nova exportação.",
    ARCH_EXPORT_NEEDS_VERSION: "Crie uma versão antes de exportar este projeto.",
    ARCH_PACKAGE_EXPIRED: "Este arquivo foi aberto há muito tempo. Escolha-o novamente.",
    ARCH_PROJECT_BUSY: "O Studio ainda está salvando ou atualizando este projeto. Tente novamente em instantes.",
    ARCH_RESTORE_BUSY: "Há uma rodada ou geração em andamento neste projeto. Restaure quando terminar.",
    ARCH_NO_SAVED_VERSION: "Este projeto ainda não tem uma versão salva para a qual voltar.",
    ARCH_PROJECT_FILE: "Um arquivo da pasta do projeto não é válido.",
    copyDetails: "Copiar detalhes", copiedDetails: "Copiado",
    fileInvalid: "O arquivo {file} não é válido: {problem}.",
    fileTooLong: "{field} tem mais de {max} caracteres", fileTooMany: "{field} tem mais de {max} itens",
    fileEmpty: "{field} está vazio", fileMissing: "falta {field}", fileUnexpected: "{field} não deveria estar aí",
    fileNotJson: "não dá para ler como JSON", fileBadValue: "{field} tem um valor que o Studio não consegue usar",
    ARCH_PROJECT_WORKING: "O agente está trabalhando neste projeto. Mude isso quando ele terminar.",
    ARCH_LOCATION_UNAVAILABLE: "Não foi possível acessar o OpenStreetMap. Cole as coordenadas ou um link do Google Maps.",
  },
};

type FileIssue = {path?: string; code?: string; origin?: string; maximum?: number; minimum?: number; keys?: string[]; missing?: boolean};
/** "The file arch.context.json isn't valid: driver is longer than 160 characters." */
function fileProblem(message: string, t: typeof en) {
  let value: {file?: unknown; issues?: unknown};
  try { value = JSON.parse(message) as typeof value; } catch { return null; }
  if (typeof value.file !== "string" || !Array.isArray(value.issues) || !value.issues.length) return null;
  const file = value.file;
  const reasons = (value.issues as FileIssue[]).slice(0, 3).map(issue => {
    const fill = (text: string, field = issue.path || file) => text.replace("{field}", field).replace("{max}", String(issue.maximum));
    if (issue.code === "invalid_json") return t.fileNotJson;
    if (issue.code === "too_big" && issue.maximum !== undefined) return fill(issue.origin === "array" ? t.fileTooMany : t.fileTooLong);
    if (issue.code === "too_small" && (issue.minimum ?? 0) <= 1) return fill(t.fileEmpty);
    if (issue.missing) return fill(t.fileMissing);
    if (issue.code === "unrecognized_keys" && issue.keys?.length) return fill(t.fileUnexpected, issue.keys.map(key => issue.path ? `${issue.path}.${key}` : key).join(", "));
    return fill(t.fileBadValue);
  });
  return t.fileInvalid.replace("{file}", file).replace("{problem}", reasons.join("; "));
}

export function studioFailure(error: {message: string}, locale: Locale) {
  const t = copy[locale];
  const labels = {detailsLabel: t.details, copyLabel: t.copyDetails, copiedLabel: t.copiedDetails};
  if (error.message === "ARCH_SESSION_REQUIRED") return {message: studioText[locale].sessionRequired, ...labels, details: undefined};
  // Validation errors wrap a code in a JSON issues array. Match complete quoted codes only.
  const code = failureCode(error.message);
  if (code === "ARCH_PROJECT_FILE") return {message: fileProblem(error.message, t) ?? t.ARCH_PROJECT_FILE, ...labels, details: undefined};
  const known = !!code && Object.hasOwn(t, code);
  return {message: known ? t[code as keyof typeof en] : t.generic, ...labels, details: known ? undefined : error.message};
}

/** What "Copy details" puts on the clipboard: the message and its code, never URLs or tokens. */
export function failureDetails(error: {message: string; name?: string}, locale: Locale) {
  return [
    studioFailure(error, locale).message,
    `Code: ${failureCode(error.message) ?? "none"}`,
    `Error: ${error.name || "Error"}`,
    `Message: ${redactDiagnostics(error.message).slice(0, 4000)}`,
    `Time: ${new Date().toISOString()}`,
  ].join("\n");
}

/** One line for surfaces that show only text, such as the viewer's notice. Unknown failures keep their own words. */
export function failureLine(error: unknown, locale: Locale) {
  const failure = studioFailure(error instanceof Error ? error : new Error(String(error)), locale);
  return failure.details ? `${failure.message} (${redactDiagnostics(failure.details).slice(0, 200)})` : failure.message;
}
