export interface Position {
  row: number;
  column: number;
}

export interface SourceRange {
  start: Position;
  end: Position;
  startByte: number;
  endByte: number;
}

export interface LocalHelper {
  name: string;
  range: SourceRange;
}

export interface RFunction {
  name: string;
  signature: string;
  parameters: string;
  bodyRange: SourceRange;
  functionRange: SourceRange;
  localHelpers: LocalHelper[];
}

export interface Inspection {
  path: string;
  functions: RFunction[];
}

export type EditOperation =
  | { kind: "replace"; body: string }
  | { kind: "patch"; oldText: string; newText: string };

export interface EditRequest {
  path: string;
  function: string;
  operation: EditOperation;
}

export interface EditCandidate {
  path: string;
  function: RFunction;
  candidate: string;
}
