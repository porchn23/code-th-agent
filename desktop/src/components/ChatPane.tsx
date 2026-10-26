import { useEffect, useRef, useState } from "react";
import { store, type StoreState } from "../store";
import Markdown from "./Markdown";
import type { ChatEntry, RunResult } from "../types";

function ActivityCard({ entry }: { entry: Extract<ChatEntry, { kind: "activity" }> }) {
  const [open, setOpen] = useState(false);
  const c = entry.counts;
  const chips: { cls: string; text: string }[] = [];
  if (c.steps) chips.push({ cls: "", text: `⚡ ${c.steps}` });
  if (c.tools) chips.push({ cls: "", text: `🛠 ${c.tools}` });
  if (c.web) chips.push({ cls: "", text: `🌐 ${c.web}` });
  if (c.agents) chips.push({ cls: "", text: `👥 ${c.agents}` });
  if (c.tokens) chips.push({ cls: "tok", text: `⛁ ${c.tokens}` });
  if (c.errors) chips.push({ cls: "err", text: `⚠ ${c.errors}` });
  if (c.queued) chips.push({ cls: "", text: `⏳ ${c.queued}` });

  return (
    <div className="activity">
      <div className="activity-head" onClick={() => setOpen(!open)}>
        <span className="chips">
          {chips.length ? (
            chips.map((ch, i) => (
              <span key={i} className={`chip ${ch.cls}`}>
                {ch.text}
              </span>
            ))
          ) : (
            <span className="chip">กำลังทำงาน…</span>
          )}
        </span>
        <span className="spacer" />
        <span className="chip">{open ? "▲ ซ่อน" : "▼ ดู"}</span>
      </div>
      {open && (
        <div className="activity-body">
          {entry.logs.join("\n")}
          {entry.runs.map((r: RunResult, i: number) => (
            <div className="run-block" key={i}>
              🧪 {r.cmd} → exit {r.code} ({r.ms} ms)
              {r.text ? `\n${r.text}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCard({
  entry,
  state,
}: {
  entry: Extract<ChatEntry, { kind: "plan" }>;
  state: StoreState;
}) {
  const done = entry.plan.steps.filter((s) => s.done).length;
  return (
    <div className="plan-card">
      <h4>📋 {entry.plan.title || "แผนงาน"}</h4>
      <ol>
        {entry.plan.steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : ""}>
            {s.text}
          </li>
        ))}
      </ol>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="badge">
          {done}/{entry.plan.steps.length} เสร็จแล้ว
        </span>
        {state.plan && (
          <button className="primary" onClick={() => store.approvePlan()}>
            ✅ อนุมัติแผนแล้วเริ่มทำ
          </button>
        )}
      </div>
    </div>
  );
}

export default function ChatPane({ state }: { state: StoreState }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.entries.length, state.entries]);

  if (!state.entries.length) {
    return (
      <div className="chat">
        <div className="empty">
          <div style={{ fontSize: 34, marginBottom: 10 }}>🤖</div>
          <div>ถามอะไรก็ได้ — agent จะค้นคว้า วิเคราะห์ และสะสมบทเรียนไว้ให้รอบหน้า</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            โหมด 💻 code เปิดเครื่องมือแก้ไฟล์ / รันคำสั่ง (admin เท่านั้น)
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-inner">
        {state.entries.map((e) => {
          if (e.kind === "user")
            return (
              <div key={e.id} className="msg-user">
                {e.text}
              </div>
            );
          if (e.kind === "answer")
            return (
              <div key={e.id} className="msg-answer">
                <Markdown text={e.text} />
              </div>
            );
          if (e.kind === "error")
            return (
              <div key={e.id} className="msg-error">
                ❌ {e.text}
              </div>
            );
          if (e.kind === "plan")
            return <PlanCard key={e.id} entry={e} state={state} />;
          return <ActivityCard key={e.id} entry={e} />;
        })}
        {state.running && (
          <div className="chip" style={{ alignSelf: "flex-start" }}>
            <span className="spin" /> กำลังคิด…
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
