export type ExecutionTargetKind = "dsh" | "provider" | "session";

export interface ProviderCapabilities {
  execute: boolean;
  streaming: boolean;
  cancel: boolean;
  quota: boolean;
}

export interface ProviderTaskInput {
  run_id: string;
  task_id: string;
  prompt: string;
  cwd?: string | null;
}

export type ProviderTaskResult =
  | {
      status: "completed";
      output: string | null;
      external_ref: string | null;
    }
  | { status: "failed"; error: string }
  | { status: "unknown"; error: string };

export interface ProviderExecutor {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  execute(input: ProviderTaskInput): Promise<ProviderTaskResult>;
}

export interface ProviderCapabilityView {
  id: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderRegistry {
  get(id: string): ProviderExecutor;
  list(): ProviderCapabilityView[];
}
