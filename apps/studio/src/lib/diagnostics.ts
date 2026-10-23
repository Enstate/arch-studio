/**
 * Error text that is safe to hand to someone else: no capability URLs, no tokens and no
 * home folder. `home` is this machine's home folder when the caller knows it.
 */
export function redactDiagnostics(text: string, home?: string): string {
  let result = text;
  if (home && home.length > 1) for (const form of [home, JSON.stringify(home).slice(1, -1)]) result = result.split(form).join("~");
  return result
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, "<url>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <token>")
    // Checkpoint IDs stay recognizable. Capability tokens and session secrets lose their value.
    .replace(/\b[a-f0-9]{64}\b/gi, hex => `${hex.slice(0, 12)}…`)
    .replace(/(?:\/Users|\/home)\/[^/\s"']+/g, "~")
    .replace(/\b[A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\)[^\\\s"']+/g, "~");
}

/** The ARCH_ code an error carries, alone or quoted inside a validation issue list. */
export function failureCode(message: string): string | null {
  return /^ARCH_[A-Z_]+$/.test(message) ? message : message.match(/"(ARCH_[A-Z_]+)"/)?.[1] ?? null;
}
