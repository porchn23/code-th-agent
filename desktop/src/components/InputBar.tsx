import { useEffect, useRef, useState } from "react";
import { store, type StoreState } from "../store";

export default function InputBar({ state }: { state: StoreState }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // ส่งด้วย Enter · ขึ้นบรรทัดใหม่ด้วย Shift+Enter
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const auto = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    };
    auto();
    return auto;
  }, [text]);

  const send = async () => {
    const t = text.trim();
    if (!t || state.running) return;
    setText("");
    await store.send(t);
  };

  return (
    <div className="input-wrap">
      <div className="input-inner">
        <textarea
          ref={ref}
          rows={1}
          placeholder="ถามอะไรก็ได้… (Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {state.running ? (
          <button onClick={() => void store.stop()} title="หยุด">
            ⏹ หยุด
          </button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!text.trim()}>
            ส่ง
          </button>
        )}
      </div>
      <div className="hint">
        workspace:{" "}
        {state.workspaces.find((w) => w.id === state.settings.workspaceId)?.dir ?? "—"}
        {" · "}mode: {state.settings.mode}
        {" · "}maxSteps: {state.settings.maxSteps}
      </div>
    </div>
  );
}
