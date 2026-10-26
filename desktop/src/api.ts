/**
 * ชั้น API — คุยกับ Rust ผ่าน Tauri IPC
 * (แทน fetch('/api/...') + EventSource ของเวอร์ชัน JS)
 *
 * ⚠️ ไฟล์นี้ไม่มี React — ถ้าเปลี่ยน UI stack ส่วนนี้ใช้ต่อได้เลย
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  EvalEntry,
  ModelInfo,
  PlanFile,
  PlanPayload,
  Rule,
  RunEvent,
  SkillEntry,
  TreeEntry,
  Workspace,
} from "./types";

const EVENT_CHANNEL = "agent-event";

// ---------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------
export interface AskInput {
  task: string;
  model?: string;
  temp?: number | null;
  maxSteps?: number;
  history?: { role: string; content: string }[];
  mode?: "research" | "code";
  planMode?: boolean;
  approvedPlan?: PlanPayload;
  ws?: string;
}

export function ask(input: AskInput): Promise<string> {
  return invoke<string>("ask", {
    task: input.task,
    model: input.model ?? null,
    temp: input.temp ?? null,
    maxSteps: input.maxSteps ?? null,
    history: input.history ?? null,
    mode: input.mode ?? null,
    planMode: input.planMode ?? false,
    approvedPlan: input.approvedPlan ?? null,
    ws: input.ws ?? null,
  });
}

export function stopRun(): Promise<void> {
  return invoke<void>("stop_run");
}

/** ฟัง event จาก agent — คืนฟังก์ชันสำหรับ unsubscribe */
export function onAgentEvent(
  handler: (ev: AgentEvent) => void
): Promise<() => void> {
  return listen<AgentEvent>(EVENT_CHANNEL, (e) => handler(e.payload));
}

// ---------------------------------------------------------------------
// models / workspaces / files
// ---------------------------------------------------------------------
export function getModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("get_models");
}

export function getWorkspaces(): Promise<Workspace[]> {
  return invoke<Workspace[]>("get_workspaces");
}

export function addWorkspace(dir: string): Promise<Workspace> {
  return invoke<Workspace>("add_workspace", { dir });
}

export function removeWorkspace(id: string): Promise<void> {
  return invoke<void>("remove_workspace", { id });
}

export function listTree(ws: string, path: string): Promise<{ path: string; entries: TreeEntry[] }> {
  return invoke("list_tree", { ws, path });
}

export function readFile(ws: string, path: string): Promise<{ content: string }> {
  return invoke<{ content: string }>("read_file", { ws, path });
}

export function writeFile(ws: string, path: string, content: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("write_file", { ws, path, content });
}

// ---------------------------------------------------------------------
// circuit 1 / 2 / 3 + AGENTS.md + plan
// ---------------------------------------------------------------------
export function getPlaybook(): Promise<{ rules: Rule[]; events: RunEvent[] }> {
  return invoke("get_playbook");
}

export function getSkills(): Promise<{ tools: SkillEntry[] }> {
  return invoke<{ tools: SkillEntry[] }>("get_skills");
}

export function getEvals(): Promise<{
  evals: EvalEntry[];
  runs: { ok: number; avgTok: number };
}> {
  return invoke("get_evals");
}

export function getAgentsRules(): Promise<{ content: string }> {
  return invoke<{ content: string }>("get_agents_rules");
}

export function setAgentsRules(content: string): Promise<{ content: string }> {
  return invoke<{ content: string }>("set_agents_rules", { content });
}

export function getPlan(): Promise<PlanFile | null> {
  return invoke<PlanFile | null>("get_plan");
}

export function approvePlan(): Promise<PlanPayload> {
  return invoke<PlanPayload>("approve_plan");
}

// ---------------------------------------------------------------------
// checkpoints (diff / restore)
// ---------------------------------------------------------------------
export interface CheckpointInfo {
  id: string;
  ts: number;
  runId: string;
  kind: string;
  root: string;
  fileCount: number;
}

export interface DiffLine {
  t: "same" | "add" | "del" | "mod";
  text: string;
}

export function getCheckpoints(): Promise<CheckpointInfo[]> {
  return invoke<CheckpointInfo[]>("get_checkpoints");
}

export function diffCheckpoint(
  id: string
): Promise<{ id: string; files: { rel: string; diff: DiffLine[] }[] }> {
  return invoke("diff_checkpoint", { id });
}

export function restoreCheckpoint(id: string): Promise<{ restored: string[] }> {
  return invoke<{ restored: string[] }>("restore_checkpoint", { id });
}

// ---------------------------------------------------------------------
// git worktree
// ---------------------------------------------------------------------
export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
}

export function listWorktrees(ws: string): Promise<{ worktrees: WorktreeInfo[] }> {
  return invoke<{ worktrees: WorktreeInfo[] }>("list_worktrees", { ws });
}

export function createWorktree(ws: string, target: string, branch: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("create_worktree", { ws, target, branch });
}

export function removeWorktree(ws: string, target: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("remove_worktree", { ws, target });
}

// ---------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------
export function login(ident: string, password: string): Promise<{ sid: string; user: unknown }> {
  return invoke("login", { ident, password });
}

export function register(
  name: string,
  password: string,
  email?: string
): Promise<{ sid: string; user: unknown }> {
  return invoke("register", { name, password, email: email ?? null });
}

export function logout(sid?: string): Promise<void> {
  return invoke<void>("logout", { sid: sid ?? null });
}

export function whoami(sid?: string): Promise<unknown> {
  return invoke("whoami", { sid: sid ?? null });
}

export function updateProfile(
  sid: string,
  name?: string,
  email?: string
): Promise<{ name: string; email: string }> {
  return invoke("update_profile", { sid, name: name ?? null, email: email ?? null });
}

export function changePassword(sid: string, oldPw: string, nextPw: string): Promise<void> {
  return invoke<void>("change_password", { sid, old: oldPw, next: nextPw });
}

export function setApiKey(sid: string, orKey: string): Promise<void> {
  return invoke<void>("set_api_key", { sid, orKey });
}

export function getApiKeyInfo(sid?: string): Promise<{
  hasUserKey: boolean;
  userKeyTail: string;
  hasServerKey: boolean;
  serverKeyTail: string;
}> {
  return invoke("get_api_key_info", { sid: sid ?? null });
}

export function listUsers(): Promise<unknown[]> {
  return invoke<unknown[]>("list_users");
}

export function addUser(
  name: string,
  password: string,
  role: string,
  email?: string
): Promise<{ id: string; name: string; role: string }> {
  return invoke("add_user", { name, password, role, email: email ?? null });
}

export function removeUser(id: string): Promise<void> {
  return invoke<void>("remove_user", { id });
}

export function appInfo(): Promise<{
  dataDir: string;
  today: string;
  model: string;
  authOff: boolean;
}> {
  return invoke("app_info");
}
