import type { ExecutionTargetKind } from "../../providers/types.js";

export type TeamRelayDispatch = "single" | "parallel";
export type TeamRelayApproval = "auto" | "confirm";
export type TeamRelayWorkspace = "none" | "isolated" | "resource";

export interface TeamRelayRoute {
  id: string;
  label: string;
  match: string[];
  preferred: string[];
  dispatch: TeamRelayDispatch;
  approval: TeamRelayApproval;
  workspace: TeamRelayWorkspace;
}

export interface TeamRelayPreset {
  version: number;
  max_parallel: number;
  routes: TeamRelayRoute[];
}

export interface TeamSettingsSnapshot { revision: number; preset: TeamRelayPreset }
export interface DoubaoAccessView {
  state: "signed_out" | "logging_in" | "saved" | "connected" | "expired" | "unavailable";
  message: string;
}
export type DoubaoAccessAction = "status" | "login" | "check" | "cancel" | "logout";
export interface DoubaoAccessPort {
  status(): DoubaoAccessView;
  start(): DoubaoAccessView;
  check(): Promise<DoubaoAccessView>;
  cancel(): DoubaoAccessView;
  logout(): DoubaoAccessView;
}
export interface TeamAgentView {
  id: string;
  label: string;
  selectable: boolean;
  status: "builtin" | "detected" | "not_integrated" | "unsupported" | DoubaoAccessView["state"];
  message: string;
}

export interface TeamRelayTarget {
  kind: ExecutionTargetKind;
  id: string;
}

export interface TeamRelayRouteResolution {
  selected: string[];
  unavailable: string[];
}
