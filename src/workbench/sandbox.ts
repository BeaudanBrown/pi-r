import { isAbsolute } from "node:path";
import { RecoverableError } from "../r-edit/errors.js";

export function sandboxRuntimePath(explicit?: string): string {
  const value = explicit ?? process.env.PI_R_SANDBOX_PATH;
  if (!value) throw new RecoverableError("SANDBOX_RUNTIME_MISSING", "PI_R_SANDBOX_PATH is required");
  const entries = value.split(":").filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !isAbsolute(entry) || !entry.startsWith("/nix/store/"))) {
    throw new RecoverableError("SANDBOX_RUNTIME_INVALID", "Sandbox runtime PATH must contain only absolute Nix store directories");
  }
  return entries.join(":");
}
