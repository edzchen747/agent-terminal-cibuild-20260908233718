export interface ShellLike {
  id?: string;
}

/**
 * The shell id to show as selected in the default-terminal picker.
 * The desktop's snapshot default is authoritative. When it is stale (the
 * profile was removed on the desktop, or the store predates the current
 * shell list) the first shell with a usable id is shown instead, never an id
 * that no option would render. An empty or fully malformed shell list yields
 * an empty selection.
 */
export function effectiveDefaultShell(shells: readonly ShellLike[], defaultShellId: string): string {
  if (shells.some((shell) => shell.id === defaultShellId)) return defaultShellId;
  return shells.find((shell) => shell.id)?.id ?? "";
}
