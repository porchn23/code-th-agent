/**
 * Store กลางของ UI — ไม่มี import จาก React (ถ้าเปลี่ยน stack ก็ย้ายไปใช้ต่อได้)
 * ใช้ useSyncExternalStore ต่อได้เลย
 */
import * as api from "./api";
import type {
  AgentEvent,
  ChatEntry,
  ChatSession,
  ModelInfo,
  PlanPayload,
  RunResult,
  Settings,
  Workspace,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

const LS_SETTINGS = "ra_set";
const LS_SESSIONS = "ra_sessions";

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function emptyCounts() {
  return { steps: 0, tools: 0, web: 0, agents: 0, tokens: 0, errors: 0, queued: 0 };
}

export interface StoreState {
  settings: Settings;
  entries: ChatEntry[];
  sessions: ChatSession[];
  currentSessionId: string;
  models: ModelInfo[];
  workspaces: Workspace[];
  running: boolean;
  plan: PlanPayload | null;
  error: string | null;
  loaded: boolean;
}

type Listener = () => void;

class Store {
  private state: StoreState = {
    settings: { ...DEFAULT_SETTINGS },
    entries: [],
    sessions: [],
    currentSessionId: "",
    models: [],
    workspaces: [],
    running: false,
    plan: null,
    error: null,
    loaded: false,
  };

  private listeners = new Set<Listener>();
  private unlisten: (() => void) | null = null;
  private activity: Extract<ChatEntry, { kind: "activity" }> | null = null;
  private live: Extract<ChatEntry, { kind: "answer" }> | null = null;

  // ---- พื้นฐาน ----
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): StoreState => this.state;

  private set(patch: Partial<StoreState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
    this.persist();
  }

  private persist() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(this.state.settings));
      localStorage.setItem(
        LS_SESSIONS,
        JSON.stringify(this.state.sessions.slice(0, 30))
      );
    } catch {
      /* localStorage ใช้ไม่ได้ → ไม่ persist (ไม่ crash) */
    }
  }

  private restore() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) {
        const s = JSON.parse(raw);
        this.state.settings = { ...DEFAULT_SETTINGS, ...s };
      }
      const sraw = localStorage.getItem(LS_SESSIONS);
      if (sraw) {
        const list = JSON.parse(sraw);
        if (Array.isArray(list) && list.length) {
          this.state.sessions = list;
          this.state.currentSessionId = list[0].id;
          this.state.entries = list[0].entries;
        }
      }
    } catch {
      /* ข้อมูลเสีย → ใช้ค่าเริ่มต้น */
    }
    if (!this.state.currentSessionId) {
      const s = this.newSession();
      this.state.sessions = [s];
      this.state.currentSessionId = s.id;
      this.state.entries = s.entries;
    }
  }

  // ---- bootstrap ----
  async init() {
    this.restore();
    try {
      const [models, workspaces] = await Promise.all([
        api.getModels().catch(() => [] as ModelInfo[]),
        api.getWorkspaces().catch(() => [] as Workspace[]),
      ]);
      const ws = this.state.settings.workspaceId;
      this.set({
        models,
        workspaces,
        loaded: true,
        settings: {
          ...this.state.settings,
          workspaceId:
            ws && workspaces.some((w) => w.id === ws)
              ? ws
              : workspaces[0]?.id ?? null,
        },
      });
    } catch (e) {
      this.set({ loaded: true, error: String(e) });
    }

    this.unlisten = await api.onAgentEvent((ev) => this.handleEvent(ev));
  }

  dispose() {
    this.unlisten?.();
    this.unlisten = null;
  }

  // ---- settings ----
  updateSettings(patch: Partial<Settings>) {
    this.set({ settings: { ...this.state.settings, ...patch } });
  }

  // ---- sessions ----
  private newSession(): ChatSession {
    return {
      id: uid("s"),
      title: "แชทใหม่",
      ts: Date.now(),
      entries: [],
      workspaceId: this.state.settings.workspaceId,
    };
  }

  newChat() {
    const s = this.newSession();
    this.set({
      sessions: [s, ...this.state.sessions].slice(0, 30),
      currentSessionId: s.id,
      entries: [],
      plan: null,
    });
  }

  selectSession(id: string) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return;
    this.set({ currentSessionId: id, entries: s.entries });
  }

  deleteSession(id: string) {
    const sessions = this.state.sessions.filter((s) => s.id !== id);
    const list = sessions.length ? sessions : [this.newSession()];
    this.set({
      sessions: list,
      currentSessionId: list[0].id,
      entries: list[0].entries,
    });
  }

  renameSession(id: string, title: string) {
    const sessions = this.state.sessions.map((s) =>
      s.id === id ? { ...s, title: title.slice(0, 80) } : s
    );
    this.set({ sessions });
  }

  exportSession(id: string) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return;
    let out = `# ${s.title}\n\n`;
    for (const e of s.entries) {
      if (e.kind === "user") out += `## 🧑 ผู้ใช้\n\n${e.text}\n\n`;
      else if (e.kind === "answer")
        out += `## 🤖 Agent\n\n${e.text}\n\n`;
      else if (e.kind === "error") out += `> ❌ ${e.text}\n\n`;
    }
    const blob = new Blob([out], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private pushEntry(entry: ChatEntry) {
    const entries = [...this.state.entries, entry];
    this.state.entries = entries;
    const sessions = this.state.sessions.map((s) =>
      s.id === this.state.currentSessionId ? { ...s, entries } : s
    );
    this.state.sessions = sessions;
    this.listeners.forEach((l) => l());
  }

  private updateLastEntry(fn: (e: ChatEntry) => ChatEntry) {
    const entries = [...this.state.entries];
    if (!entries.length) return;
    entries[entries.length - 1] = fn(entries[entries.length - 1]);
    this.state.entries = entries;
    const sessions = this.state.sessions.map((s) =>
      s.id === this.state.currentSessionId ? { ...s, entries } : s
    );
    this.state.sessions = sessions;
    this.listeners.forEach((l) => l());
  }

  // ---- ส่งงาน ----
  async send(task: string) {
    const trimmed = task.trim();
    if (!trimmed || this.state.running) return;

    const userEntry: ChatEntry = {
      kind: "user",
      id: uid("e"),
      ts: Date.now(),
      text: trimmed,
    };
    this.pushEntry(userEntry);

    // ไตเติลแชทจากงานแรก
    const cur = this.state.sessions.find((s) => s.id === this.state.currentSessionId);
    if (cur && cur.title === "แชทใหม่") {
      this.renameSession(cur.id, trimmed.slice(0, 48));
    }

    const history = this.state.entries
      .filter((e): e is Extract<ChatEntry, { kind: "user" | "answer" }> =>
        e.kind === "user" || e.kind === "answer"
      )
      .map((e) => ({ role: e.kind === "user" ? "user" : "assistant", content: e.text }));

    this.set({ running: true, error: null });
    try {
      await api.ask({
        task: trimmed,
        model: this.state.settings.model || undefined,
        temp: this.state.settings.temp,
        maxSteps: this.state.settings.maxSteps,
        history: history.slice(0, -1), // ไม่ต้องส่งข้อความล่าสุดซ้ำ (agent เติมเอง)
        mode: this.state.settings.mode,
        planMode: false,
        ws: this.state.settings.workspaceId ?? undefined,
      });
    } catch (e) {
      this.pushEntry({
        kind: "error",
        id: uid("e"),
        ts: Date.now(),
        text: String(e),
      });
      this.set({ running: false });
    }
  }

  async stop() {
    try {
      await api.stopRun();
    } catch {
      /* ไม่มีงานรันอยู่ */
    }
  }

  /** อนุมัติแผน → รันตามแผน */
  async approvePlan() {
    try {
      const plan = await api.approvePlan();
      this.set({ plan });
      await this.send(
        `ทำตามแผนนี้:\n${plan.steps
          .map((s, i) => `${i + 1}. ${s.text}`)
          .join("\n")}\n\nเรียก plan_done ทีละขั้นตอนเมื่อเสร็จ`
      );
    } catch (e) {
      this.pushEntry({
        kind: "error",
        id: uid("e"),
        ts: Date.now(),
        text: String(e),
      });
    }
  }

  // ---- event จาก agent ----
  private handleEvent(ev: AgentEvent) {
    switch (ev.type) {
      case "log": {
        const line = String(ev.data ?? "");
        this.tallyLog(line);
        break;
      }
      case "answer-delta": {
        const chunk = String(ev.data ?? "");
        if (!this.live) {
          const entry: Extract<ChatEntry, { kind: "answer" }> = {
            kind: "answer",
            id: uid("e"),
            ts: Date.now(),
            text: "",
          };
          this.live = entry;
          this.pushEntry(entry);
        }
        this.updateLastEntry((e) =>
          e.kind === "answer" ? { ...e, text: e.text + chunk } : e
        );
        break;
      }
      case "answer-reset": {
        this.live = null;
        break;
      }
      case "answer": {
        const text = String(ev.data ?? "");
        const entry: ChatEntry = {
          kind: "answer",
          id: uid("e"),
          ts: Date.now(),
          text,
        };
        this.live = null;
        this.pushEntry(entry);
        break;
      }
      case "error": {
        this.pushEntry({
          kind: "error",
          id: uid("e"),
          ts: Date.now(),
          text: String(ev.data ?? ""),
        });
        this.set({ running: false });
        break;
      }
      case "run": {
        const r = ev.data as RunResult;
        this.updateLastEntry((e) =>
          e.kind === "activity" ? { ...e, runs: [...e.runs, r] } : e
        );
        break;
      }
      case "plan": {
        const p = ev.data as PlanPayload;
        this.set({ plan: p });
        this.pushEntry({
          kind: "plan",
          id: uid("e"),
          ts: Date.now(),
          plan: p,
        });
        break;
      }
      case "queued": {
        this.set({ running: false });
        this.tallyLog("⏳ งานเข้าคิว — รอรองานก่อนหน้าเสร็จ");
        break;
      }
      default:
        break;
    }
  }

  /** นับ activity chips จากบรรทัด log (ตรรกะเดียวกับ UI เวอร์ชัน JS) */
  private tallyLog(line: string) {
    if (!this.activity) {
      const entry: Extract<ChatEntry, { kind: "activity" }> = {
        kind: "activity",
        id: uid("e"),
        ts: Date.now(),
        counts: emptyCounts(),
        logs: [],
        runs: [],
      };
      this.activity = entry;
      this.pushEntry(entry);
    }
    const activity = this.activity;
    const counts = activity.counts;
    const logs = activity.logs;

    if (/── step \d+/.test(line)) counts.steps++;
    if (/→\s+\w+\(/.test(line)) counts.tools++;
    if (/search|fetch|http/i.test(line)) counts.web++;
    if (/sub-?agent|spawning/i.test(line)) counts.agents++;
    if (/tok in/.test(line)) {
      const m = line.match(/~\s*(\d+)\s*tok in/);
      if (m) counts.tokens += Number(m[1]);
    }
    if (/✗|Error:|error/i.test(line)) counts.errors++;

    logs.push(line);
    if (logs.length > 400) logs.splice(0, logs.length - 400);

    this.updateLastEntry((e) =>
      e.kind === "activity"
        ? { ...e, counts: { ...counts }, logs: [...logs], runs: e.runs }
        : e
    );
  }
}

export const store = new Store();
