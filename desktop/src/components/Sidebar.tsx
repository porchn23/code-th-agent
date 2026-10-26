import { useState } from "react";
import { store, type StoreState } from "../store";

export default function Sidebar({ state }: { state: StoreState }) {
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  const sessions = state.sessions.filter((s) =>
    filter ? s.title.toLowerCase().includes(filter.toLowerCase()) : true
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">🤖 Thai Agentic</span>
        <button className="primary" onClick={() => store.newChat()} title="แชทใหม่">
          ＋
        </button>
      </div>

      <div style={{ padding: "6px 8px" }}>
        <input
          className="ghost"
          style={{
            width: "100%",
            background: "var(--bg-elev2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "5px 8px",
          }}
          placeholder="ค้นหาแชท…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="session-list">
        {sessions.length === 0 && <div className="empty">ยังไม่มีแชท</div>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === state.currentSessionId ? "active" : ""}`}
            onClick={() => store.selectSession(s.id)}
            onDoubleClick={() => setRenaming(s.id)}
            title={s.title}
          >
            {renaming === s.id ? (
              <input
                autoFocus
                defaultValue={s.title}
                style={{
                  flex: 1,
                  background: "var(--bg)",
                  border: "1px solid var(--accent)",
                  borderRadius: 4,
                  padding: "2px 5px",
                }}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  store.renameSession(s.id, e.target.value);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <>
                <span className="title">{s.title}</span>
                <span
                  className="icon"
                  title="export .md"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.exportSession(s.id);
                  }}
                >
                  ⭳
                </span>
                <span
                  className="icon"
                  title="ลบ"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.deleteSession(s.id);
                  }}
                >
                  ✕
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <div className="row">
          <span>โหมด</span>
          <span>{state.settings.mode === "code" ? "💻 code" : "🔎 research"}</span>
        </div>
        <div className="row">
          <span>workspace</span>
          <span>
            {state.workspaces.find((w) => w.id === state.settings.workspaceId)?.name ??
              "—"}
          </span>
        </div>
      </div>
    </aside>
  );
}
