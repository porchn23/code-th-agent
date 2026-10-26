/**
 * รูปแบบข้อมูลที่ส่งข้าม Rust ↔ TypeScript
 * ต้องตรงกับ serde ใน desktop/src-tauri/src/state.rs และ commands.rs
 */

export interface ModelInfo {
  id: string;
  name: string;
  context: number;
  free: boolean;
  tools: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  dir: string;
  owner?: string | null;
}

export interface Rule {
  id: string;
  tag: string;
  rule: string;
  usage_count: number;
  last_seen: number;
  created: number;
}

export interface RunEvent {
  run_id: string;
  ts: number;
  task: string;
  steps: number;
  tools: Record<string, number>;
  outcome: string;
  errors: string[];
  tok: number;
  model: string;
}

export interface EvalEntry {
  id: string;
  keywords: string[];
  check: string[];
  usage_count: number;
  last_seen: number;
}

export interface SkillEntry {
  name: string;
  description: string;
  params: unknown;
  created_at: number;
  last_used: number;
  calls: number;
}

export interface PlanStep {
  text: string;
  done: boolean;
}

export interface PlanFile {
  id: string;
  ts: number;
  title: string;
  steps: PlanStep[];
}

export interface PlanPayload {
  title: string;
  steps: PlanStep[];
}

export interface RunResult {
  cmd: string;
  code: number;
  ms: number;
  text: string;
}

export interface TreeEntry {
  name: string;
  dir: boolean;
  size: number;
}

export interface Profile {
  name: string;
  email: string;
  role: string;
  hasKey: boolean;
  keyTail: string;
}

/** event จาก Rust — type เดียวกับ SSE ของเวอร์ชัน JS */
export type AgentEventType =
  | "log"
  | "answer"
  | "answer-delta"
  | "answer-reset"
  | "error"
  | "run"
  | "plan"
  | "queued";

export interface AgentEvent<T = unknown> {
  type: AgentEventType;
  data: T;
  runId?: string;
}

// ---------------------------------------------------------------------
// โมเดลข้อความในแชท (ฝั่ง UI)
// ---------------------------------------------------------------------
export interface ActivityCounts {
  steps: number;
  tools: number;
  web: number;
  agents: number;
  tokens: number;
  errors: number;
  queued: number;
}

export type ChatEntry =
  | { kind: "user"; id: string; ts: number; text: string }
  | { kind: "answer"; id: string; ts: number; text: string }
  | { kind: "activity"; id: string; ts: number; counts: ActivityCounts; logs: string[]; runs: RunResult[] }
  | { kind: "error"; id: string; ts: number; text: string }
  | { kind: "plan"; id: string; ts: number; plan: PlanPayload };

export interface ChatSession {
  id: string;
  title: string;
  ts: number;
  entries: ChatEntry[];
  workspaceId: string | null;
}

export interface Settings {
  temp: number | null;
  maxSteps: number;
  mode: "research" | "code";
  model: string;
  workspaceId: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  temp: null,
  maxSteps: 12,
  mode: "research",
  model: "",
  workspaceId: null,
};
