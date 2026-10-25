# code-th-agent — Compounding Agent 🤖

**Agent ที่ "เก่งขึ้นทุกวันด้วยตัวเอง"** — AI agent framework น้ำหนักเบา เขียนด้วย JavaScript ล้วน **ไม่มี dependencies เลย (zero-dependency)** รันด้วย Node.js ตรง ๆ ไม่ต้อง npm install

> หลักคิด: Agent เก่งหรือไม่เก่ง ไม่ได้อยู่ที่โมเดลอย่างเดียว — อยู่ที่ **harness** รอบโมเดล (retry/context/tools/verification) รวมถึง **ความสามารถในการสะสมประสบการณ์ข้ามรอบ** 🔁

## 🔄 วงจรสะสม (Compounding Circuits)

| วงจร | กลไก | สถานะ |
|---|---|---|
| **1. Failure→Rule** (Playbook) | ทุก run ถูกบันทึกลง `agent-events.jsonl` · run ที่มี error → Reflector ถอดเป็นกฎ 1 บรรทัด → Curator dedupe (code-only) → run ถัดไป inject กฎที่เกี่ยวเข้า system prompt (งบ ~400 tok) | ✅ |
| **2. Need→Tool** (Skill Library) | Agent มี `tool_create` — เขียน tool ใหม่เป็นไฟล์ JS เอง test-run ใน sandbox ก่อน → ถ้าผ่าน ลงทะเบียนถาวรใน `skills/` ใช้ข้าม run ได้ + inject spec เข้า run ปัจจุบันทันที | ✅ |
| **3. Task→Eval** | งานสำเร็จแบบมีขั้นตอน (≥3 steps + ใช้ tool) → Eval curator ถอด checklist (PATTERN keywords | CHECK ≤3 steps) ลง `agent_evals.json` (cap 20, dedupe Jaccard ≥0.5 → bump usage) → งานคล้ายกันถัดไปได้ eval hints inject (~300 tok) ต่อท้าย playbook | ✅ |

SPARK — ภารกิจของ agent ถูกฝังใน system prompt ทุก run: *"every run should make the NEXT run faster, cheaper, or smarter"*

## ✨ ฟีเจอร์หลัก (v16)

- **2 โหมด**: 🔎 Research (web_search + web_fetch + citation + freshness rule) / 💻 Code (`run_command` + `file_edit` exact-match + `file_grep` + **VERIFICATION GATE** — ห้ามบอกว่า "เสร็จ" โดยไม่รันจริง)
- **🧑‍💼 ระบบสมาชิก (v16)**: บัญชี admin/member + scrypt password hash (node:crypto) + session cookie HttpOnly 7 วัน — เปิดครั้งแรกจะให้สร้างบัญชีเจ้าของก่อน; login พลาด 5 ครั้ง → ล็อก 30 วิ; admin เพิ่ม/ลบสมาชิกผ่านปุ่ม 👤 (`AGENT_NO_AUTH=1` ปิด — โหมด local trust)
- **📦 พื้นที่ทำงาน / Workspaces (v16)**: เลือกโฟลเดอร์โปรเจคผ่านปุ่ม 📁 — ทุก tool (file_read/file_write/file_edit/file_grep/run_command) และ checkpoint ทำงานในพื้นที่ที่เลือก ไม่แตะ repo ตัว agent (`agent_workspaces.json`, สูงสุด 20)
- **🌿 Git worktrees (v16)**: ปุ่ม 🌿 สร้าง/ลบ worktree ต้นแบบ repo เพื่อทดลองแก้แยกกิ่ง — สร้างแล้ว auto-ลงทะเบียนเป็น workspace ให้เลย (ต้องเป็น git repo)
- **🗂 ตัวสำรวจไฟล์ (v16)**: ปุ่ม 🗂 เปิด drawer โครงสร้างโปรเจคของพื้นที่ทำงาน (ต้นไม้ lazy-load, คลิกไฟล์ → preview ≤120KB) + 🧪 แผงผล run_command (exit code, ms, output) ใน activity card
- **🔒 Checkpoints + ย้อนกลับได้ (Tier 1)**: ก่อนทุก `file_edit`/`file_write`/`run_command` จะ snapshot ไฟล์ที่จะโดนแก้ (งานระดับโปรเจกต์ ถึง 120 ไฟล์ย่อ ≤300KB/ไฟล์) → UI ปุ่ม 🔒 ดู **diff แยกสีเป็นบล็อก** + กด **ย้อนกลับ** คืนไฟล์ได้ทันที (หน้าต่าง 30 checkpoint ล่าสุด, `AGENT_NO_CHECKPOINTS=1` ปิด) — v16 เก็บ per-workspace แล้ว
- **📋 Plan mode (Tier 1)**: สลับปุ่ม 📋 ใน UI → agent ทำแผน (research/อ่านอย่างเดียวห้ามแก้ไฟล์) → เสนอแผนผ่าน SSE เป็นการ์ด ✅/□ ในแชต → ผู้ใช้กด "อนุมัติแผน" → รูป agent ทำทีละขั้นกด `plan_done` เช็คขั้นที่เสร็จจริง
- **📝 AGENTS.md (Tier 1)**: กฎของผู้ใช้ในไฟล์ `AGENTS.md` (อ่านทุก run, บังคับก่อน) — แก้ผ่านปุ่ม 📝 ใน UI ได้เลย (UTF-8, จำกัด 30k chars, `AGENT_AGENTS_FILE` เปลี่ยนตำแหน่งได้)
- **⛁ ตัวชี้วัด token/บริบท (Tier 1)**: badge ใน UI แสดง token ที่ใช้รวม เทียบ % ของ context window โมเดลที่เลือก ทันทีที่ run จบ
- **🖥 Desktop app (zero-dep)**: `agent-app.vbs` ดับเบิลคลิกเดียว → ยังไม่มี server จะบูตเองตามหลัง → รอ server พร้อม → เปิด **msedge --app** เป็นหน้าต่างสแตนด์อโลนไม่มี address bar (`Research Agent.lnk` บน Desktop สร้างให้แล้ว ไม่ใช้ npm/Electron ใด ๆ)
- **Streaming UI** (SSE): เห็นคำตอบไหลทีละคำ + activity chips (⚡ steps 🔍 🌐 👥 🛠 ⛁ tokens ⚠ errors) + เลข token จริงจาก API ทุก step
- **Multi-agent**: `research_subagent` spawn ได้ (sub-agent ได้ context สดใหม่ + งบ token ต่ำกว่า) — ใช้เฉพาะเมื่อจำเป็นจริง
- **Token thrift**: parallel tool calls + dedupe ซ้ำ + trim tool results เก่า (300 chars) + history cap การจัดการ token อย่างเข้มงวด
- **Security**: js_eval รันผ่าน `node:vm` sandbox (บล็อก eval/Function/WASM escape), run_command บล็อก command อันตราย (rm -rf/format/del /s), ทุก output scrub secret อัตโนมัติ (`sk-or-***`), XSS-safe markdown renderer
- **Memory**: long-term memory tool (`memory_save`/`memory_recall` ลง `.agent_memory.json`) + session history (สนทนาต่อเนื่องใน UI)
- **UI สไตล์ OpenCode**: sessions sidebar (ค้นหา/เปลี่ยนชื่อ/ลบ/export .md), model dropdown จาก OpenRouter, settings (temp/maxSteps/โหมด code), 📓 playbook badge, 🧱 custom tools badge, 🎯 evals badge
- **🎯 Eval checklists (วงจร 3)**: งานที่สำเร็จแบบมีขั้นตอนถูกสังเคราะห์เป็น checklist ต่อชนิดงาน (1 LLM call, gate ≥3 steps + มี tool) — งานชนิดเดียวกันถัดไปได้ "จุดเริ่ม/สิ่งที่ต้องตรวจ" ฟรีใน system prompt (`--evals` ดูสรุป, `AGENT_NO_EVALS=1` ปิด)
- **⏳ คิวงาน**: UI ส่งงานตอน agent กำลังรัน → ไม่โดน 429 เปล่า ๆ — งานเข้าคิว (ลึก 1) และเริ่มเองทันทีเมื่องานก่อนหน้าจบ (SSE event `queued` + chip ⏳ ใน activity card)

## 🏁 Quick Start

```bash
# 1. ใส่ OpenRouter API key
#    สร้างไฟล์ .openrouter_key (ดูวิธีที่จอหลักตอนรันครั้งแรก)
#    หรือตั้ง env OPENROUTER_API_KEY
node check-key.js   # (optional) ตรวจ key ตัวไหนใช้ web search (:online) ได้

# 2. เปิด web UI
node server.js      # → http://localhost:8787

# หรือใช้ CLI
node research-agent.js "หัวข้อ research ที่อยากรู้"
node research-agent.js --playbook   # ดูกฎที่ agent เรียนรู้มา
node research-agent.js --evals      # ดู checklist ที่ agent เก็บจากงานที่สำเร็จ
```

## 🧪 Tests (offline, ไม่กิน API quota — ผ่าน 104 asserts ครบ 10 ไฟล์)

```bash
node test-mock.js          # multi-agent + error self-recovery + sandbox escape + XSS (13)
node test-codemode.js      # verification gate + file_edit + destructive cmd block (12)
node test-tools.js         # tool_create: register/test-run/persist/reject (13)
node test-playbook.js      # event log + reflector + dedupe + prompt injection (15)
node test-server-mock.js   # SSE streaming + queue (200/200/429) + Stop + tool order (8)  ※ปิด dev server ก่อน
node test-smoke.js         # จริง: boot + route + validation (5)
node test-evals.js         # วงจร 3: eval สร้างจากงานสำเร็จ + dedupe bump + inject hints + off-switch (8)
node test-tier1.js         # Tier 1: AGENTS.md inject + plan mode + checkpoint/diff/restore (15)
node test-auth.js          # v16: setup/login/rate-limit/session + worktree create/remove + tree escape guard (25)  ※ปิด dev server ก่อน
node test-workspace.js     # v16: per-run root — file_edit/checkpoint/run cwd ลง workspace ที่เลือก (7)
```

## 🗂 โครงสร้าง

```
research-agent.js   ← หัวใจ: LLM + tools + loop + playbook + skill library + evals + Tier1 (ckpt/plan/AGENTS)
server.js           ← web backend (SSE + task queue + checkpoints/plan/AGENTS routes, port 8787)
ui.html             ← UI ทั้งหมด (single file)
js-eval-runner.js   ← sandbox runner ของ js_eval (node:vm)
agent-app.vbs       ← desktop launcher (ตรวจ server → auto บูต → เปิด Edge app window)
test-*.js           ← 10 ชุดทดสอบ offline
docs/project-history.md  ← index เอกสาร + version history
AGENT-ROADMAP.md    ← roadmap ของระบบ (วงจร 1-3 + Code Mode)
```

## 🔗 การอ้างอิงแนวคิด

ดีไซน์นี้ดึงแรงบันดาลใจและหลักการจาก: **ACE** (playbook Reflector/Curator), **Alita** (self-evolving tools), **Voyager** (skill library), **SWE-agent** (ACI/guardrails), **OpenHands** (event stream), **Letta/MemGPT** (memory)

---
*โปรเจ็คต์เรียนรู้ — สร้างด้วยวิธี "talk-driven development" สรุปทุกการพัฒนาไว้ขั้นต่ำ 1 เอกสาร และไม่ลงที่ต้องพึ่ง framework ภายนอก*
