import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

export interface ResourcePaths {
  resources: string;
  extension: string;
  rHelper: string;
}

export function resourcePaths(environment = process.env): ResourcePaths {
  const installedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const resources = environment.PI_R_RESOURCE_ROOT ?? join(installedRoot, "share", "pi-r");
  return {
    resources,
    extension: join(resources, "extensions", "pi-r.ts"),
    rHelper: join(resources, "R", "pi_r_runtime.R"),
  };
}
