import { useEffect, useState } from "react";
import { store, type StoreState } from "../store";
import * as api from "../api";

export default function TopBar({
  state,
  onOpenPanel,
}: {
  state: StoreState;
  onOpenPanel: (p: string) => void;
}) {
  const [counts, setCounts] = useState({ rules: 0, skills: 0, evals: 0 });

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [pb, sk, ev] = await Promise.all([
          api.getPlaybook(),
          api.getSkills(),
          api.getEvals(),
        ]);
        if (!alive) return;
        setCounts({
          rules: pb.rules?.length ?? 0,
          skills: sk.tools?.length ?? 0,
          evals: ev.evals?.length ?? 0,
        });
      } catch {
        /* ยังไม่พร้อม — ไม่ต้องแสดง */
      }
    };
    refresh();
    const t = setInterval(refresh, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const toolModels = state.models.filter((m) => m.tools);

  return (
    <header className="topbar">
      <select
        value={state.settings.model}
        onChange={(e) => store.updateSettings({ model: e.target.value })}
        title="โมเดล (ต้องรองรับ tool calling)"
      >
        <option value="">โมเดลเริ่มต้น</option>
        {toolModels.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.free ? " · free" : ""}
          </option>
        ))}
      </select>

      <select
        value={state.settings.workspaceId ?? ""}
        onChange={(e) => store.updateSettings({ workspaceId: e.target.value || null })}
        title="พื้นที่ทำงาน"
      >
        {state.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            📁 {w.name}
          </option>
        ))}
      </select>

      <div className="toggle" title="โหมดการทำงาน">
        <button
          className={state.settings.mode === "research" ? "on" : ""}
          onClick={() => store.updateSettings({ mode: "research" })}
        >
          🔎 research
        </button>
        <button
          className={state.settings.mode === "code" ? "on" : ""}
          onClick={() => store.updateSettings({ mode: "code" })}
        >
          💻 code
        </button>
      </div>

      <label
        className="badge"
        title="temperature (ว่าง = ใช้ค่าเริ่มต้นของโมเดล)"
      >
        temp{" "}
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          style={{
            width: 46,
            background: "transparent",
            border: "none",
            padding: 0,
          }}
          value={state.settings.temp ?? ""}
          placeholder="auto"
          onChange={(e) =>
            store.updateSettings({
              temp: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
      </label>

      <label className="badge" title="จำนวนขั้นตอนสูงสุดต่อ run">
        steps{" "}
        <input
          type="number"
          min="4"
          max="24"
          style={{
            width: 40,
            background: "transparent",
            border: "none",
            padding: 0,
          }}
          value={state.settings.maxSteps}
          onChange={(e) =>
            store.updateSettings({ maxSteps: Number(e.target.value) || 12 })
          }
        />
      </label>

      <span className="spacer" />

      <button className="ghost" onClick={() => onOpenPanel("playbook")}>
        📓 playbook <span className="badge">{counts.rules}</span>
      </button>
      <button className="ghost" onClick={() => onOpenPanel("skills")}>
        🧱 skills <span className="badge">{counts.skills}</span>
      </button>
      <button className="ghost" onClick={() => onOpenPanel("evals")}>
        🎯 evals <span className="badge">{counts.evals}</span>
      </button>
      <button className="ghost" onClick={() => onOpenPanel("rules")}>
        📝 กฎของฉัน
      </button>
      <button className="ghost" onClick={() => onOpenPanel("files")}>
        🗂 ไฟล์
      </button>
      <button className="ghost" onClick={() => onOpenPanel("checkpoints")}>
        🔒 checkpoints
      </button>
    </header>
  );
}
