interface CommandContext {
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, context: CommandContext): Promise<void>;
    },
  ): void;
}

/** Minimal inactive command surface; constrained session behavior lands in later issues. */
export default function piRExtension(pi: ExtensionAPI): void {
  pi.registerCommand("r", {
    description: "Manage a constrained R/targets workbench",
    async handler(args, context) {
      const requested = args.trim();
      const suffix = requested ? ` (requested: ${requested})` : "";
      context.ui.notify(`pi-r workbench is not active${suffix}`, "info");
    },
  });
}
