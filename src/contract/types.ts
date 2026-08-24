export const ARTIFACT_KINDS = ["table", "object", "file"] as const;
export const PATTERN_KINDS = ["map", "cross"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type PatternKind = (typeof PATTERN_KINDS)[number];
export type ConstantValue = string | number | boolean | null;

export interface NixpkgsPin {
  owner: string;
  repo: string;
  rev: string;
  narHash: string;
  lastModified: number;
}

export interface ApprovedFunction {
  name: string;
  parameters: string[];
}

export type ArgumentReference = { target: string } | { constant: string };

export interface TargetDefinition {
  name: string;
  function: string;
  artifact: ArtifactKind;
  arguments: Record<string, ArgumentReference>;
  pattern?: { kind: PatternKind; over: string[] };
}

export interface ProjectContract {
  contractVersion: 1;
  templateVersion: "pi-r-template-v1";
  policyVersion: "pi-r-policy-v1";
  project: { name: string; nixpkgs: NixpkgsPin };
  dependencies: string[];
  constants: Record<string, ConstantValue>;
  functions: ApprovedFunction[];
  targets: TargetDefinition[];
}

export interface ContractSummary {
  contractVersion: number;
  templateVersion: string;
  policyVersion: string;
  project: string;
  dependencies: string[];
  functions: string[];
  constants: string[];
  targets: string[];
}
