export interface PipelineInput {
  yaml: string;
  variables: Record<string, string>;
}

export interface Pipeline {
  stages: string[];
  jobs: Job[];
  edges: Edge[];
  artifact_edges?: Edge[];
  suggested_branches?: string[];
  suggested_variables?: string[];
  warnings?: string[];
  error?: string;
}

export interface Job {
  name: string;
  stage: string;
  enabled: boolean;
  when: string;
  allow_failure: boolean;
  interruptible: boolean;
  image?: string;
  needs: string[];
  has_explicit_needs: boolean;
  artifacts?: Artifacts;
  variables?: Record<string, string>;
  tags?: string[];
  environment?: string;
  resource_group?: string;
  parallel_count?: number;
  matrix_instances?: MatrixInstance[];
  rules_trace: RuleTrace[];
  retry?: number;
  release?: boolean;
  coverage?: boolean;
  pages?: boolean;
  needs_no_artifacts?: string[];
  dependencies?: string[];
  trigger?: TriggerInfo;
}

export interface TriggerInfo {
  project?: string;  // non-empty = multi-project trigger
  branch?: string;
  strategy?: string;
  include?: string;  // non-empty = local parent-child trigger
}

export interface Artifacts {
  paths?: string[];
  reports?: Record<string, string[]>;
  expire_in?: string;
  when?: string;
}

export interface MatrixInstance {
  variables: Record<string, string>;
  name: string;
}

export interface Edge {
  from: string;
  to: string;
  type: "needs" | "stage";
}

export interface RuleTrace {
  rule_index: number;
  condition?: string;
  matched: boolean;
  when?: string;
}

export interface ConditionState {
  yaml: string;
  pipelineSource: string;
  branch: string;
  tag: string;
  extraVars: Array<{ key: string; value: string }>;
}
