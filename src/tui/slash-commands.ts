export interface SlashCommandDefinition {
  command: string;
  insertText: string;
  description: string;
  argHint?: string;
  requiresArgument?: boolean;
}

export const TUI_SLASH_COMMAND_DEFINITIONS: readonly SlashCommandDefinition[] =
  [
    {
      command: "/help",
      insertText: "/help",
      description: "Show TUI command help",
    },
    {
      command: "/status",
      insertText: "/status",
      description: "Show current session status",
    },
    {
      command: "/goal",
      insertText: "/goal ",
      description: "Manage the persistent session goal",
      argHint: "<text|status|pause|resume|stop>",
      requiresArgument: true,
    },
    {
      command: "/copy",
      insertText: "/copy",
      description: "Copy the transcript to the clipboard",
    },
    {
      command: "/refresh",
      insertText: "/refresh",
      description: "Reload the session snapshot",
    },
    {
      command: "/theme",
      insertText: "/theme ",
      description: "List or switch TUI themes",
      argHint: "[name]",
    },
    {
      command: "/resume",
      insertText: "/resume ",
      description: "Resume the specified saved session",
      argHint: "<session_id>",
      requiresArgument: true,
    },
    {
      command: "/attach",
      insertText: "/attach ",
      description: "Queue an image file path or URL",
      argHint: "<path-or-url>",
      requiresArgument: true,
    },
    {
      command: "/attachments",
      insertText: "/attachments",
      description: "Show queued attachments",
    },
    {
      command: "/detach",
      insertText: "/detach ",
      description: "Remove one queued attachment",
      argHint: "[index]",
    },
    {
      command: "/exit",
      insertText: "/exit",
      description: "Exit the TUI",
    },
    {
      command: "/voice",
      insertText: "/voice",
      description: "Enter the realtime voice mode (Esc returns to text)",
    },
  ] as const;
