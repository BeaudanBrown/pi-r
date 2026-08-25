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

export interface ProducedTargetDefinition {
  name: string;
  function: string;
  artifact: ArtifactKind;
  arguments: Record<string, ArgumentReference>;
  output?: { parameter: string; constant: string };
  pattern?: { kind: PatternKind; over: string[] };
  source?: never;
}

export interface SourceFileTargetDefinition {
  name: string;
  artifact: "file";
  source: { constant: string };
  arguments: Record<string, never>;
  function?: never;
  output?: never;
  pattern?: never;
}

export type TargetDefinition = ProducedTargetDefinition | SourceFileTargetDefinition;

export function isSourceFileTarget(target: TargetDefinition): target is SourceFileTargetDefinition {
  return "source" in target;
}

export interface VersionedDeliverable {
  target: string;
  path: string;
}

export interface DependencyApproval {
  scope: "project" | "shared";
  domain: string;
  rationale: string;
  policyStatus: "required" | "preferred" | "allowed" | "unregistered";
}

export interface ProjectContract {
  contractVersion: 1;
  templateVersion: "pi-r-template-v1";
  policyVersion: "pi-r-policy-v1";
  project: { name: string; nixpkgs: NixpkgsPin };
  dependencies: string[];
  dependencyApprovals: Record<string, DependencyApproval>;
  deliverables: VersionedDeliverable[];
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
  deliverables: string[];
  functions: string[];
  constants: string[];
  targets: string[];
}
