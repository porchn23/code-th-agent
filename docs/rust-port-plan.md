# 🦀 แผนพอร์ตเป็น Rust Desktop App

> อัพเดต: 2026-10-25 · สถานะ: **Rust core เขียนเสร็จ M1 (ยังไม่ได้ compile — รอติดตั้ง toolchain)**
> เป้าหมาย: จาก Node.js zero-dep → desktop app ที่เขียนด้วย Rust
> ทิศทางที่เลือก: **Tauri v2 + เขียน UI ใหม่** · ฐานข้อมูล: SQLite แบบ hybrid (ยังรอผู้ใช้ยืนยัน)

## สถานะปัจจุบัน (อัปเดตล่าสุด)

| ส่วน | สถานะ | ไฟล์ |
|---|---|---|
| Tauri scaffold (Cargo.toml, tauri.conf.json, capabilities) | ✅ | `desktop/src-tauri/` |
| security guards (SSRF + path/symlink) | ✅ port ครบ + unit test | `src/guards.rs` |
| state files (users/sessions/workspaces/playbook/evals/skills/plan/memory/events) | ✅ format เดียวกับ JS | `src/state.rs` |
| LLM client (JSON + SSE streaming + retry 4 ครั้ง) | ✅ | `src/agent/llm.rs` |
| system prompts (คัดลอกทุกตัวอักษร) | ✅ | `src/agent/prompt.rs` |
| tool specs (11 + 3 + tool_create + 2 plan) | ✅ + unit test | `src/agent/tools.rs` |
| circuit 1 playbook / circuit 2 skills / circuit 3 evals | ✅ + unit test | `src/agent/playbook.rs`, `skills.rs`, `evals.rs` |
| agent loop (orchestrator + sub-agent) | ✅ | `src/agent/mod.rs` |
| tool execution (ทุกตัว) | ✅ | `src/agent/exec.rs` |
| calculator (แทน new Function ของ JS) | ✅ + unit test | `src/agent/calc.rs` |
| auth (scrypt เข้าคอมแพติเบิลกับ Node — มี test vector) | ✅ | `src/auth.rs` |
| workspace + git worktree | ✅ | `src/workspace.rs` |
| Tauri commands (แทน server.js) | ✅ 28 commands | `src/commands.rs` |
| **compile + cargo test** | ⏳ รอติดตั้ง rustup + MSVC | — |
| UI ใหม่ | ⏳ รอเลือกสแต็ค (React/Vue/Vanilla) | `desktop/src/` |
| checkpoint module (diff/restore) | ⏳ คิวไว้ถัดไป | — |

**รวม: 18 ไฟล์ Rust / ~5,560 บรรทัด** · ผ่าน static bracket-balance check ทั้งหมด (`desktop/tools/check-rust-syntax.js`)

> ⚠️ ยัง **ไม่ได้** compile จริง — ต้องติดตั้ง rustup + VS Build Tools ก่อน (เครื่องนี้ยังไม่มี)


## 0. สรุปสถานะปัจจุบัน (baseline ที่ต้องรักษาไว้)

โปรเจกต์เป็น **AI agent framework** แบบ zero-dependency Node.js:

| ไฟล์ | บรรทัด | หน้าที่ |
|---|---|---|
| `research-agent.js` | ~1718 | หัวใจ: LLM loop + 11 tools + playbook + skill library + evals + checkpoints + plan mode |
| `server.js` | ~810 | HTTP backend: ~35 endpoint, SSE streaming, auth/member, workspace, git worktree, task queue |
| `ui.html` | ~2600 | UI ทั้งหมดในไฟล์เดียว (sessions sidebar, streaming bubble, activity chips, settings) |
| `security-guards.js` | 124 | SSRF guard (public IP + redirect + DNS pin) + path escape/symlink guard |
| `js-eval-runner.js` | ~110 | sandbox ของ `js_eval` (node:vm) |
| `workspace-files.js` | ~40 | ตัวช่วยอ่านไฟล์ workspace |
| `agent-app.vbs` | ~80 | desktop launcher ปัจจุบัน (probe server → boot → `msedge --app`) |

**สถานะ test ปัจจุบัน (รันแล้วผ่าน):** test-security-guards ✓ · test-playbook 15/15 ✓ · test-evals 8/8 ✓ · test-workspace 7/7 ✓ · test-codemode ALL PASS ✓

> ⚠️ เกณฑ์ของงานพอร์ต: **ต้องได้พฤติกรรมเดียวกัน** ไม่ใช่ "แค่คอมไพล์ผ่าน" — test suite คือสเปก

## 1. แผนที่โค้ด JS → โมดูล Rust

```
desktop/src-tauri/src/
├── main.rs              ← entry point, ต่อกับ UI + register command
├── agent/
│   ├── mod.rs           ← agentLoopCore (วน LLM↔tool), ctx, run lifecycle
│   ├── llm.rs           ← callLLM / callLLMStream (SSE จาก OpenRouter), retry 4 ครั้ง
│   ├── tools/
│   │   ├── mod.rs       ← getTools(mode, planExtra) — registry ของ tool
│   │   ├── web.rs       ← web_search, web_fetch (+stripHtml)
│   │   ├── files.rs     ← file_read, file_write, file_edit, file_grep
│   │   ├── exec.rs      ← run_command, js_eval
│   │   ├── memory.rs    ← memory_save, memory_recall
│   │   ├── plan.rs      ← save_plan, plan_done
│   │   └── create.rs    ← tool_create + รัน custom tool
│   ├── prompt.rs        ← SYSTEM_PROMPT + CODE_RULES + TOOL_RULES + SPARK_RULES
│   ├── playbook.rs      ← circuit 1: event log → Reflector → Curator → inject
│   ├── evals.rs         ← circuit 3: eval curator + dedupe + inject
│   ├── skills.rs        ← circuit 2: skills/index.json + live-spec injection
│   ├── checkpoint.rs    ← snapshot + diff + restore
│   └── plan.rs          ← plan state machine
├── server/
│   ├── mod.rs           ← HTTP router + SSE
│   ├── auth.rs          ← scrypt, session cookie, rate-limit, member CRUD
│   ├── workspace.rs     ← workspace registry, ownership, git worktree
│   └── files.rs         ← tree / file preview / file write
├── guards.rs            ← security-guards.js → is_public_address, safe_path_in_root, pinned fetch
├── state.rs             ← ไฟล์ JSON state (ดู §2)
└── error.rs
```

## 2. Contract ที่ต้องคงเดิม (สำคัญที่สุด)

### 2.1 ไฟล์ state (JSON บนดิสก์ — ใช้ร่วมกับเวอร์ชัน JS ได้)
| ไฟล์ | รูปแบบ | ผู้ใช้ |
|---|---|---|
| `agent_playbook.json` | `{id, rule, tag, usageCount, lastSeen}` cap 50 | circuit 1 |
| `agent_evals.json` | `{keywords[], check[], usageCount}` cap 20 | circuit 3 |
| `skills/index.json` | `{name, description, params, calls}` cap 30 | circuit 2 |
| `agent-events.jsonl` | append-only event log, cap 500 บรรทัด | circuit 1 |
| `agent_users.json` | user + scrypt hash + per-user OpenRouter key | ระบบสมาชิก |
| `agent_sessions.json` | session cookie → user (7 วัน) | auth |
| `agent_workspaces.json` | workspace registry (cap 20) | workspace |
| `agent_plan.json` | `{title, steps:[{text,done}]}` | plan mode |
| `.agent_memory.json` | `[{key, note}]` | memory |

> ข้อตกลง: Rust อ่าน/เขียน JSON เดียวกัน → ผู้ใช้สลับกลับไปใช้เวอร์ชัน JS ได้โดยไม่เสีย state

### 2.2 SSE protocol (POST /api/ask)
```
data: {"type":"log"|"answer"|"answer-delta"|"answer-reset"|"error"|"run"|"plan"|"queued", "data": ...}
```
- `answer-delta` = สตริมคำตอบ · `answer-reset` = โมเดลสลับไปเรียก tool (ล้างบับเบิลค้าง)
- `plan` = การ์ดแผน (save_plan/plan_done) · `run` = ผล run_command จริง

### 2.3 HTTP API ที่ UI พึ่ง (35 endpoint)
- **auth**: `/api/setup` `/api/login` `/api/register` `/api/logout` `/api/me` `/api/profile` `/api/password` `/api/key` `/api/users` `/api/users/remove`
- **agent**: `/api/ask` (SSE) `/api/models` `/api/playbook` `/api/skills` `/api/evals` `/api/agents` (AGENTS.md) `/api/plan` `/api/checkpoints` `/api/checkpoints/diff` `/api/checkpoints/restore`
- **workspace**: `/api/workspaces` `/api/workspaces/remove` `/api/directories` `/api/tree` `/api/file` (GET/PUT) `/api/worktrees` `/api/worktrees/create` `/api/worktrees/remove`

### 2.4 Security invariants (ห้ามตก)
1. bind เฉพาะ `127.0.0.1`
2. `web_fetch`: บล็อก private/reserved IP ทุก redirect + pin DNS ตอน connect
3. file tools: ปฏิเสธ symlink + path escape (ทั้ง lexical และ realpath)
4. `run_command` / custom tools = admin-only
5. ไม่ log key: scrub `sk-or-***` ก่อนเขียน event/playbook
6. `AGENT_NO_AUTH=1` / `AGENT_NO_CHECKPOINTS=1` / `AGENT_NO_EVALS=1` = สวิตช์ปิด (ต้องมีในเวอร์ชัน Rust ด้วย เพื่อให้ test เดิมใช้ได้)

## 3. เส้นทาง UI (3 ทาง — เลือก 1)

### ทาง A — Tauri v2 (แนะนำ)
- ใช้ `ui.html` เดิมเกือบทั้งหมด → ลดงาน UI เหลือศูนย์
- Rust ทำแทน `server.js` (Tauri command/IPC แทน HTTP+SSE)
- ข้อดี: binary เล็ก (~5-10MB), ได้ tray/native dialog/notification ฟรี, WebView2 มีอยู่แล้วในเครื่อง
- ข้อเสีย: ต้อง rewrite จุดเรียก `fetch('/api/...')` ใน ui.html → `invoke('...')` (≈ 28 จุด)
- ต้องแก้ `EventSource` → Tauri event channel

### ทาง B — egui/iced (native ล้วน Rust)
- เขียน UI ใหม่ทั้งหมด ≈ 2600 บรรทัด HTML/JS → Rust widget
- ได้ native look จริง, single binary ไม่ต้องมี WebView2
- ข้อเสีย: งาน UI ใหม่ทั้งหมด + streaming bubble/activity chips/ไฟล์ explorer ยากกว่ามาก, เสีย feature parity เร็ว

### ทาง C — Hybrid (Tauri + Node sidecar)
- Tauri เป็น shell, spawn `node server.js` เป็น sidecar, UI ยังคุย HTTP เดิม
- ได้ desktop app เร็วที่สุด และ UI ไม่ต้องแตะเลย
- ข้อเสีย: ยังต้องมี Node ในเครื่อง, ไม่ใช่ "พัฒนาด้วย Rust" เต็มรูปแบบ

## 4. ประเมินงาน (คน-วัน, โดยประมาณ)

| ส่วน | ทาง A (Tauri, full port) | ทาง C (Hybrid) |
|---|---|---|
| scaffold + build + bundler | 0.5 | 0.5 |
| Rust: LLM client + streaming | 1.5 | — |
| Rust: tools ทั้งชุด | 3 | — |
| Rust: playbook/evals/skills | 2 | — |
| Rust: checkpoint/plan | 1 | — |
| Rust: auth/member/workspace/worktree | 2.5 | — |
| Rust: server/router/SSE (หรือ IPC) | 1.5 | — |
| UI glue (ui.html → invoke/events) | 1 | 0.3 |
| test port (12 ชุด → Rust) | 3 | 0.5 |
| **รวม** | **~16** | **~1.3** |

> ควรลำดับเป็น **vertical slice** ไม่ใช่ layer-by-layer: เพื่อให้ทุกสัปดาห์มีของที่รันได้จริง

## 5. Milestone (แนะนำ)

- **M1 — Rust core ยังไม่มี UI**: LLM client + agent loop + 3 tool (web_fetch, file_read, file_write) + CLI เดียวกับ `research-agent.js` → รันเทียบผลกับ JS ได้
- **M2 — tools ครบ + circuit 1/2/3**: playbook, skills, evals พร้อมไฟล์ state ร่วมกับ JS
- **M3 — Tier 1**: checkpoint/diff/restore, plan mode, AGENTS.md inject
- **M4 — shell + UI**: Tauri, ย้าย `ui.html` มา, แทน fetch → invoke
- **M5 — multi-user**: auth/member/workspace/worktree
- **M6 — paritiy + regression**: port test suite ทั้ง 12 ชุด, build .msi/.exe

## 6. ความเสี่ยง

| ความเสี่ยง | ผลกระทบ | การรับมือ |
|---|---|---|
| `js_eval` ใช้ `node:vm` + `child_process` | sandbox semantics ต่างจาก Rust | เลือก: ใช้ `boa_engine` แทน JS หรือรัน node เป็น subprocess (รักษา parity ง่ายกว่า) |
| `tool_create` เขียน JS runtime | Rust ไม่รองรับ JS ตรง ๆ | ทางเลือก: เปลี่ยน custom tool เป็น **Rust dynamic lib** หรือ **WASM** — เป็นการเปลี่ยนสัญญา API ของ circuit 2 ต้องตัดสินใจ |
| Streaming SSE จาก OpenRouter | ต้อง parse chunk ถูกต้อง | ใช้ `reqwest` + `eventsource` crate, ทดสอบด้วย mock server (test-server-mock.js เป็นต้นแบบ) |
| `scrypt` hash + cookie session | ต้องเข้าคอมแพติเบิลกับ JS | `scrypt` crate + `sha2` — ค่า hash เก่าต้องอ่านได้ (ตรวจ format เดิม) |
| ขนาด UI 107KB | บรรทัดเดียว | แยกเป็นไฟล์/โมดูลตอนย้ายเข้า Tauri |
| ไม่มี Rust/MSVC ในเครื่อง | build ไม่ได้ | ติดตั้ง rustup + VS Build Tools (ต้องอนุมัติ) |

## 7. สิ่งที่ *ไม่* ต้องพอร์ต (ตัดออกได้)

- `agent-app.vbs` — Tauri ทำแทน (native window + autostart)
- `check-key.js` — ทำเป็นหน้า settings ใน UI แทน
- `js-eval-runner.js` — ถ้าเลือก WASM/boa จะไม่ต้องมี node:vm

## 8. เอกสารอ้างอิงโค้ดเดิม

- `research-agent.js:1477` `agentLoopCore` — หัวใจที่ต้อง port 1:1
- `research-agent.js:284` `getTools` — registry tool ตามโหมด/trust
- `research-agent.js:1640` `trimToolResults` — กติกา token thrift
- `server.js:192` `runTask` — SSE producer + queue
- `security-guards.js:97` `safePathInRoot` — path/symlink guard
- `ui.html:1614` — ตัว consume SSE (สัญญา event ที่ต้องเหมือนเดิม)
