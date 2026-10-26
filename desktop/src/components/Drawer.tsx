import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import { store, type StoreState } from "../store";
import type { EvalEntry, Rule, SkillEntry, TreeEntry } from "../types";

const TITLES: Record<string, string> = {
  playbook: "📓 Playbook — กฎที่เรียนรู้จากความล้มเหลว",
  skills: "🧱 Skill library — tool ที่สร้างเอง",
  evals: "🎯 Eval checklists — รูปแบบงานที่ผ่านแล้ว",
  rules: "📝 กฎของฉัน (AGENTS.md)",
  files: "🗂 โครงสร้างไฟล์",
  checkpoints: "🔒 Checkpoints — ดู diff / ย้อนกลับ",
};

export default function Drawer({
  state,
  panel,
  onClose,
}: {
  state: StoreState;
  panel: string | null;
  onClose: () => void;
}) {
  if (!panel) return null;

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <h3>{TITLES[panel] ?? panel}</h3>
        <button className="ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="drawer-body">
        {panel === "playbook" && <PlaybookPanel />}
        {panel === "skills" && <SkillsPanel />}
        {panel === "evals" && <EvalsPanel />}
        {panel === "rules" && <RulesPanel />}
        {panel === "files" && <FilesPanel state={state} />}
        {panel === "checkpoints" && <CheckpointsPanel />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------
function CheckpointsPanel() {
  const [list, setList] = useState<api.CheckpointInfo[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [diff, setDiff] = useState<
    { rel: string; diff: api.DiffLine[] }[] | null
  >(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setList(await api.getCheckpoints());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setOpenId(id);
    setDiff(null);
    try {
      const r = await api.diffCheckpoint(id);
      setDiff(r.files);
    } catch (e) {
      setMsg(String(e));
    }
  };

  const restore = async (id: string) => {
    try {
      const r = await api.restoreCheckpoint(id);
      setMsg(`ย้อนกลับ ${r.restored.length} ไฟล์แล้ว`);
      setDiff(null);
      setOpenId(null);
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <>
      {msg && <div className="badge" style={{ marginBottom: 8 }}>{msg}</div>}
      {openId && diff === null && <div className="empty">กำลังโหลด diff…</div>}
      {openId && diff && (
        <button className="ghost" onClick={() => (setOpenId(null), setDiff(null))}>
          ← กลับไปรายการ
        </button>
      )}
      {openId &&
        diff?.map((f) => (
          <div className="card" key={f.rel}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              {f.rel}
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                marginTop: 6,
                whiteSpace: "pre-wrap",
              }}
            >
              {f.diff.map((l, i) => (
                <div
                  key={i}
                  style={{
                    color:
                      l.t === "add"
                        ? "var(--green)"
                        : l.t === "del"
                          ? "var(--red)"
                          : l.t === "mod"
                            ? "var(--yellow)"
                            : "var(--text-dim)",
                  }}
                >
                  {l.t === "add" ? "+ " : l.t === "del" ? "- " : "  "}
                  {l.text}
                </div>
              ))}
            </div>
          </div>
        ))}
      {!openId &&
        list.map((c) => (
          <div className="card" key={c.id}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1 }}>
                {c.kind === "run" ? "🧪 run" : "📄 file"} · {c.fileCount} ไฟล์
              </span>
              <button className="ghost" onClick={() => void open(c.id)}>
                ดู diff
              </button>
              <button className="ghost" onClick={() => void restore(c.id)}>
                ↩ ย้อนกลับ
              </button>
            </div>
            <div className="meta">
              {new Date(c.ts).toLocaleString("th-TH")} · {c.root}
            </div>
          </div>
        ))}
      {!openId && list.length === 0 && (
        <div className="empty">
          ยังไม่มี checkpoint — จะถูกสร้างอัตโนมัติก่อนแก้ไฟล์/รันคำสั่ง
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
function PlaybookPanel() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [events, setEvents] = useState<unknown[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await api.getPlaybook();
      setRules(r.rules ?? []);
      setEvents(r.events ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h4>กฎที่ agent เรียนรู้ ({rules.length})</h4>
      {rules.map((r) => (
        <div className="card" key={r.id}>
          <div>{r.rule}</div>
          <div className="meta">
            [{r.tag}] ใช้ {r.usage_count} ครั้ง · {new Date(r.last_seen).toLocaleString("th-TH")}
          </div>
        </div>
      ))}

      <h4>run ล่าสุด ({events.length})</h4>
      {events.map((ev, i) => {
        const e = ev as {
          run_id: string;
          task: string;
          outcome: string;
          steps: number;
          tok: number;
        };
        return (
          <div className="card" key={i}>
            <div>{e.task}</div>
            <div className="meta">
              {e.outcome} · {e.steps} steps · {e.tok} tok
            </div>
          </div>
        );
      })}
    </>
  );
}

function SkillsPanel() {
  const [tools, setTools] = useState<SkillEntry[]>([]);
  useEffect(() => {
    api
      .getSkills()
      .then((r) => setTools(r.tools ?? []))
      .catch(() => {});
  }, []);

  if (!tools.length)
    return <div className="empty">ยังไม่มี custom tool — agent จะสร้างเองเมื่อเจองานที่ต้องใช้ซ้ำ</div>;

  return (
    <>
      {tools.map((t) => (
        <div className="card" key={t.name}>
          <div>
            <b>{t.name}</b>
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>{t.description}</div>
          <div className="meta">
            เรียก {t.calls} ครั้ง · ลงทะเบียน{" "}
            {new Date(t.created_at).toLocaleString("th-TH")}
          </div>
        </div>
      ))}
    </>
  );
}

function EvalsPanel() {
  const [evals, setEvals] = useState<EvalEntry[]>([]);
  const [runs, setRuns] = useState({ ok: 0, avgTok: 0 });

  useEffect(() => {
    api
      .getEvals()
      .then((r) => {
        setEvals(r.evals ?? []);
        setRuns(r.runs);
      })
      .catch(() => {});
  }, []);

  return (
    <>
      <h4>KPI</h4>
      <div className="card">
        run สำเร็จ: <b>{runs.ok}</b> · token เฉลี่ย/run: <b>{runs.avgTok}</b>
      </div>

      <h4>checklist ({evals.length})</h4>
      {evals.map((e) => (
        <div className="card" key={e.id}>
          <ol style={{ margin: "0 0 6px", paddingLeft: 18 }}>
            {e.check.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
          <div className="meta">
            ชนิดงาน: {e.keywords.join(", ")} · ใช้ {e.usage_count} ครั้ง
          </div>
        </div>
      ))}
    </>
  );
}

function RulesPanel() {
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getAgentsRules()
      .then((r) => setContent(r.content ?? ""))
      .catch(() => {});
  }, []);

  const save = async () => {
    try {
      await api.setAgentsRules(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch {
      setSaved(false);
    }
  };

  return (
    <>
      <p style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: 0 }}>
        กฎนี้จะถูกอ่านทุก run และฝังเข้า system prompt (สูงสุด 30,000 ตัวอักษร)
      </p>
      <textarea
        className="editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="# กฎของฉัน&#10;- ตอบเป็นภาษาไทยเสมอ"
      />
      <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
        <button className="primary" onClick={() => void save()}>
          💾 บันทึก
        </button>
        {saved && <span className="badge">บันทึกแล้ว ✓</span>}
      </div>
    </>
  );
}

function FilesPanel({ state }: { state: StoreState }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const ws = state.settings.workspaceId ?? "";

  const load = useCallback(
    async (p: string) => {
      if (!ws) return;
      try {
        const r = await api.listTree(ws, p);
        setEntries(r.entries ?? []);
        setPath(p);
      } catch {
        setEntries([]);
      }
    },
    [ws]
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const open = async (name: string, isDir: boolean) => {
    const full = path ? `${path}/${name}` : name;
    if (isDir) {
      await load(full);
      return;
    }
    try {
      const r = await api.readFile(ws, full);
      setPreview({ path: full, content: r.content });
    } catch {
      setPreview(null);
    }
  };

  if (preview)
    return (
      <>
        <div style={{ display: "flex", gap: 8, marginBottom: 9 }}>
          <span className="badge" style={{ flex: 1 }}>
            {preview.path}
          </span>
          <button
            className="ghost"
            onClick={() => {
              void api
                .writeFile(ws, preview.path, preview.content)
                .then(() => store.updateSettings({}));
              setPreview(null);
            }}
          >
            💾 บันทึก
          </button>
          <button className="ghost" onClick={() => setPreview(null)}>
            ย้อนกลับ
          </button>
        </div>
        <textarea
          className="editor"
          style={{ minHeight: 420 }}
          value={preview.content}
          onChange={(e) => setPreview({ ...preview, content: e.target.value })}
        />
      </>
    );

  return (
    <>
      {path && (
        <button className="ghost" onClick={() => void load(path.split("/").slice(0, -1).join("/"))}>
          ↑ ขึ้น
        </button>
      )}
      {entries.map((e) => (
        <div className="tree-row" key={e.name} onClick={() => void open(e.name, e.dir)}>
          <span>{e.dir ? "📁" : "📄"}</span>
          <span>{e.name}</span>
          {!e.dir && <span className="size">{e.size} B</span>}
        </div>
      ))}
      {entries.length === 0 && <div className="empty">โฟลเดอร์ว่าง</div>}
    </>
  );
}
