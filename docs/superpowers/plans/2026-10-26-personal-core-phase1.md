# Personal Core — Phase 1 Implementation Plan (v18)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำ agent เป็นเครื่องมือส่วนบุคคล — ตัด admin/member, ผูก chat↔workspace เด็ดขาด, แยกแผน/checkpoint ต่อโปรเจค, เปิด trusted tools ให้ทุก user, ขยาย blacklist ไฟล์ระบบ — บน Node zero-dependency เดิม (v17 → v18)

**Architecture:** backend กลางเดียว `server.js` (พอร์ต 8787, REST/SSE) + engine `research-agent.js` แยกชั้น — client ทุกตัว (ui.html / Edge app) คุย API ชุดเดียว; เพิ่ม registry server-side `agent_chats.json` (chatId → wsId, owner) ผูกแชตกับโปรเจคและตรวจทุก `/api/ask`; แผน/checkpoint สลายจากไฟล์ global เป็นไฟล์ต่อ wsId; สิทธิ์ admin/member ตัดหมด — security คงด้วย file-root boundary + SSRF guard + system-file blocklist

**Tech Stack:** Node.js v24 built-in เท่านั้น · HTTP/SSE · JSON state files

**Spec:** `docs/superpowers/specs/2026-10-26-personal-core-redesign-design.md` (§8 เฟส 2 Supabase ไม่อยู่ในแผนนี้)

## Global Constraints

- zero-dependency เด็ดขาด — ไม่ npm install; Node built-in เท่านั้น (v24)
- ตาม AGENTS.md: **ห้ามแก้ `.env` / `.openrouter_key`** · เอกสารภาษาไทย · ตรวจงาน (`node --check` + รัน suite) ก่อนบอกเสร็จ
- SSE contract คงเดิม: `POST /api/ask` stream `{type:"log"|"answer"|"error", data}`
- state เก่าไม่พัง: อ่าน `agent_users.json` ที่มี `role` ได้ (logic ignore), อ่าน plan/checkpoint global เดิมได้เป็น fallback
- ห้ามแตะ agent loop core / วงจร playbook-evals-skills / SSRF + safePathInRoot ใน security-guards.js (ยกเว้นเพิ่ม helper ตาม Task 1)
- พอร์ตเทส 8787 — ปิด dev server ตัวอื่นก่อนรัน suite

## Review Focus

1. **chat↔ws ไม่แมตช์** → `/api/ask` ต้องส่ง SSE `error` + ไม่เริ่มงานเลย (ห้ามสลับ root ให้เงียบ ๆ) — test ใน test-chats.js (Task 3)
2. **ลบ ws → chat record orphan** ต้องถูกกวาดไม่แสดง (Task 3)
3. **plan/checkpoint global เก่า** → โหลด fallback ได้, บันทึกใหม่ลงไฟล์ต่อ wsId เท่านั้น (Task 4)
4. **run_command เปิดทุก user** → user ไฟล์เก่า role "member" ต้องเรียกได้จริง, blocklist คำสั่งอันตรายยังกันเดิม (Task 5)
5. **ไฟล์ระบบแตะผ่าน `PUT /api/file`** → ต้องถูกปฏิเสธเหมือนทาง engine (Task 1)
6. **UI บังคับเลือกโปรเจคก่อนส่งข้อความแรก** + label "โปรเจค: ชื่อ" ทุกแชต (Task 6 verify ด้วย browser)

---

### Task 1: system-file blocklist ขยายครอบ engine + PUT /api/file

**Files:**
- Modify: `security-guards.js` — เพิ่ม `SYSTEM_FILE_BLOCKLIST` (RegExp) + `assertNotServiceFile(abs)` (throw เมื่อแตะไฟล์ระบบ)
- Modify: `research-agent.js:428-435` safeProjectPath (ใช้ list ร่วม แทน regex :431 เดิม), `:509` code guard, `:632` file-list guard; module.exports (:1718) เพิ่ม `safeProjectPath`
- Modify: `workspace-files.js` workspaceFilePath — เรียก `assertNotServiceFile` ทั้ง read+write
- Create: `test-protected-files.js` (แบบ test-auth.js: set `process.env.*_FILE` → tmpdir ก่อน require; กรณี PUT /api/file ให้ require server.js เหมือน test-auth)

**Interfaces:**
- Produces: `SYSTEM_FILE_BLOCKLIST`, `assertNotServiceFile(abs)` — งานถัดไปได้รับการกันอัตโนมัติ
- ครอบ: agent_users / agent_sessions / agent_chats / agent_workspaces / agent_plan*.json / agent_checkpoints*.json + โฟลเดอร์ agent_checkpoints / agent_evals / agent-events.jsonl / agent_playbook.json / .agent_memory.json / .openrouter_key / agent-app.vbs — **ไม่ block โค้ดระบบ** (server.js/ui.html ฯลฯ — repo ต้องใช้เป็นโปรเจคของ agent เองได้)

- [ ] **Step 1: test ก่อน** — `test-protected-files.js` assert: `safeProjectPath("agent_playbook.json", root)` throw · `agent_chats.json` throw · `agent_plan.w1.json` throw · `agent_users.json` throw · `server.js` **ไม่** throw · `notes.md` ไม่ throw · `writeWorkspaceFile(root, "agent_users.json", "x")` throw
- [ ] **Step 2: run** `node test-protected-files.js` → FAIL (list เก่า + PUT ยังไม่กัน)
- [ ] **Step 3: implement** — เพิ่ม helper ใน security-guards.js → safeProjectPath เรียก list ร่วม → writeWorkspaceFile เรียก assertNotServiceFile → export safeProjectPath
- [ ] **Step 4: run** `node test-protected-files.js` PASS + `node test-security-guards.js` PASS
- [ ] **Step 5: check** `node --check research-agent.js && node --check workspace-files.js`
- [ ] **Step 6: commit** — `git commit -am "feat(v18): extend system-file blocklist across engine + PUT /api/file"`

### Task 2: ตัด role/admin ออกจาก server.js

**Files:**
- Modify: `server.js`:
  - `:76` register — ไม่เขียน `role` ลงไฟล์ใหม่อีก (drop field; อ่านไฟล์เก่าที่มี role ได้ด้วยการ ignore)
  - `:138` canManageWorkspace → true เสมอเมื่อมี user
  - `:141` authorizedWorkspace → `!!ws && (authOff() || !!user)`
  - `:259-260` tools/trusted → ส่ง `trusted: true` เสมอ (ลบเงื่อนไข role)
  - `:436/:439/:462/:465/:484/:487/:501/:511/:537` — ลบ `role` ออกจาก response/session cache ทั้งหมด
  - `:582-614` ลบ `GET/POST /api/users`, `POST /api/users/remove` (คง register/login/logout/profile/change-password)
  - `:617-650` workspaces — เห็น/เพิ่มได้ทุกคน, ชี้โฟลเดอร์ใดก็ได้ในเครื่อง, `owner` = ผู้สร้าง (เก็บเพื่อฉลาก ไม่ใช้เป็น gate)
  - `:666` `/api/directories` — เปิดทุกคน
  - `:714` PUT file gate = authorizedWorkspace ใหม่ + assertNotServiceFile (Task 1)

**Interfaces:**
- Consumes: `assertNotServiceFile` (Task 1)
- Produces: API v18 — responses ไม่มี `role`; 3 routes users หาย (404); แตะระบบต้อง log in (หรือ AGENT_NO_AUTH=1)

- [ ] **Step 1: test ก่อน** — สร้าง `test-accounts.js` (แบบ test-auth.js): ลงทะเบียน 2 คน (userB login แยก) · assert `POST /api/users`, `GET /api/users`, `/api/users/remove` → 404 ทั้งหมด · response ของ register และ `/api/me` ไม่มี key `role` · userB (ไม่ใช่ owner ของ ws ที่เก่า) เพิ่ม/ลบ ws ได้ และสามารถ `POST /api/workspaces` ชี้ tmpdir นอก repo ได้จริง · `/api/directories` จาก userB ไม่ 403 · profile/change-password ใช้ได้จริง
- [ ] **Step 2: run** `node test-accounts.js` → FAIL
- [ ] **Step 3: implement** — ตามไล่ด้านบน
- [ ] **Step 4: run** `node test-accounts.js` → PASS
- [ ] **Step 5: commit** — `"feat(v18): remove admin/member roles from server routes"`

### Task 3: agent_chats.json — chat ↔ workspace binding

**Files:**
- Modify: `server.js` — state ใหม่: `AGENT_CHATS_FILE` (default `agent_chats.json` ข้าง server.js, override ด้วย env ตาม pattern state อื่น) + loadChats/saveChats
- New endpoints:
  - `GET /api/chats` → chats ของ owner ปัจจุบัน: `[{chatId, wsId, title, ts}]` + กวาด orphan (wsId ไม่อยู่แล้ว)
  - `POST /api/chats` `{chatId, wsId, title}` → upsert (owner = ผู้ใช้ปัจจุบัน)
  - `DELETE /api/chat?id=` → ลบ record
- Modify: `:763` `/api/ask` — รับ `chatId` เพิ่ม: lookup registry → ไม่พบ = auto-bind กับ wsId ที่ส่งมา + owner; **found + wsId ไม่ตรง = SSE error + ไม่เริ่มงานเลย**; match = ใช้ wsId จาก registry (ไม่เชื่อ client) — ไม่มี chatId → เดินสายเดิม (compat; UI ใหม่ส่งเสมอ)

**Interfaces:**
- Produces: record `{ chatId, wsId, owner, title, ts }` — Task 6 ใช้

- [ ] **Step 1: test ก่อน** — `test-chats.js` (require server จริง แยกจาก test-accounts.js): สร้าง ws1/ws2 → POST ผูก `chatA`→ws1, `chatB`→ws2 → GET เห็นทั้งคู่ (filter ตาม owner — login คนอื่นไม่เห็น) → `/api/ask` ด้วย chatA + ws: ws2 → ได้ SSE error, ไม่มีข้อความ answer → ลบ ws1 → GET หลังกวาด orphan ไม่เห็น chatA → DELETE chatA → GET ไม่เห็น → `/api/ask` ไม่แนบ chatId → เดิน flow เดิมได้
- [ ] **Step 2: run** `node test-chats.js` → FAIL (ยังไม่มี endpoint)
- [ ] **Step 3: implement** — ตาม interfaces
- [ ] **Step 4: run** `node test-chats.js` → PASS
- [ ] **Step 5: commit** — `"feat(v18): bind chats to workspaces (agent_chats.json + ask validation)"`

### Task 4: plan/checkpoint แยกต่อ workspace (research-agent.js)

**Files:**
- Modify: `research-agent.js`:
  - คง const เดิม (`PLAN_FILE` :980, CKPT :1045-1046) เป็น fallback; เพิ่ม `planPathFor(ctx)` — env override ชนะเสมอ; มี `ctx.ws` → `agent_plan.<wsId>.json` ข้าง server.js; ไม่มี → global เดิม · `ckptPathFor(ctx)` เช่นกัน: โฟลเดอร์ `agent_checkpoints/<wsId>/` + ไฟล์ `agent_checkpoints.<wsId>.json`
  - ปรับ call sites: `loadPlan/savePlan/loadCkpts/checkpointBefore/restoreCheckpoint/diffCheckpoint` รับ ctx แนบเสมอ
  - fallback: ไฟล์ per-ws ยังไม่เกิด + global มีของ → อ่าน global ได้ (ห้ามพังของเก่า)

**Interfaces:**
- Consumes: ctx field `root`/`ws` ส่งจาก server (Task 3)
- Produces: ไฟล์ state ต่อ wsId — Task 6 UI ใช้ได้เลยโดยอัตโนมัติ
- Test: `test-ws-state.js` (แบบ test-mock.js — mock global.fetch, sandbox ไฟล์ state ลง tmpdir กันไปแตะ repo จริง)

- [ ] **Step 1: test ก่อน** — `test-ws-state.js`: (1) savePlan ที่ ctx.ws="wsA" → เกิดไฟล์ `agent_plan.wsA.json` + loadPlan(wsA) อ่านกลับได้ (2) มี global `agent_plan.json` stub อยู่ก่อนและ per-ws ยังไม่เกิด → loadPlan(wsA) อ่านจาก global ได้ (3) checkpoint wsA → `agent_checkpoints.wsA.json` + `agent_checkpoints/wsA/…` (4) ctx wsB ไม่เห็นของ wsA (แยกเด็ดขาด)
- [ ] **Step 2: run** `node test-ws-state.js` → FAIL
- [ ] **Step 3: implement** — ตามไล่ด้านบน
- [ ] **Step 4: run** `node test-ws-state.js` PASS + suite ตัวเก่า (`test-tools / test-tier1 / test-playbook / test-evals / test-smoke / test-mock / test-codemode / test-workspace / test-project-editor / test-server-mock`) → PASS หมด — ต้องยังผ่านแม้ context ว่าง (global path)
- [ ] **Step 5: commit** — `"feat(v18): per-workspace plan and checkpoint state"`

### Task 5: trusted-tools ทุกคน + เคลียร์เศษ role ใน engine

**Files:**
- Modify: `research-agent.js`:
  - `:1421-1422` ลบ throw "available to admins only" ของ runTool (server ส่ง trusted=true เสมอแล้ว — engine ยังกันคำสั่ง blocklist อันตรายเดิมทุกตัว)
  - `:309` MEMBER_CODE_RULES + `:1511` ช่อง admin/member ใน system prompt — เหลือ branch เดียว (CODE_RULES); ลบ MEMBER_CODE_RULES ทิ้ง
  - getTools — ลบ filter ที่กด run_command ตาม role (คง SUBAGENT_EXCLUDE / ตัวกรองตาม mode เดิม)
  - `:215` tool desc — ตัด "Available to admins only; " เหลือ "Only use when the user explicitly asks..."
  - `runSubagent` (`:1404`) — ส่ง `ctx.root` ให้ลูก (sub-agent อยุ่ใต้ root เดียวกับแชตแม่ ตาม design §2.5)

**Interfaces:**
- Consumes: trusted flow จาก server (Task 2)
- Produces: engine นับ trusted เสมอ — การกันคำสั่งอันตรายไม่ผูก role

- [ ] **Step 1: test ก่อน** — เสริม `test-tools.js`: (a) users fixture ที่มี account `role:"member"` เก่า + getTools → list ต้องมี run_command (ไม่กรองตาม role) (b) runTool run_command คำสั่งปลอดภัย (`node --version`) → ออกผลจริง (c) คำสั่งอันตรายที่อยู่ blocklist (เช่น `del`) → ถูกปราบเหมือนเดิม
- [ ] **Step 2: run** `node test-tools.js` → FAIL แล้วแก้จน PASS
- [ ] **Step 3: run** `node test-tools.js && node test-tier1.js && node test-mock.js` → PASS
- [ ] **Step 4: commit** — `"feat(v18): trusted-for-all + strip member-engine branches"`

### Task 6: UI (ui.html) — personal mode + binding + ฉลากโปรเจค

**Files:**
- Modify: `ui.html`:
  - ลบ panel จัดการสมาชิก (👥) + flow setup-admin + ทุกจุดที่แสดง `role`
  - register ทำงานได้ทันทีเป็นผู้ใช้แรก (ไม่มี first-admin gate)
  - `ra_sessions` (localStorage, :500-560): `newSession` (:508) — แชตใหม่ต้องเลือก **โปรเจคก่อน** แล้ว `POST /api/chats` (chatId + wsId) ทันที; แชตไม่มี workspace = บล็อคการส่งข้อความแรกพร้อมข้อความแนะนำเลือกโปรเจค
  - send (:1590) — ส่ง `chatId` ไปด้วยเสมอ (server ยึด root จาก registry)
  - ฉลาก "โปรเจค: <ชื่อ>" ต่อแชตใน sidebar + หัวแชต
  - ลบแชต → `DELETE /api/chat?id=` ตาม
  - ฟอร์มเพิ่มโปรเจค — เพิ่มช่องพิมพ์ path เอง (Edge app เปิด native picker ไม่ได้) + เดิม browse ผ่าน `/api/directories` คงอยู่

**Interfaces:**
- Consumes: `/api/chats` (Task 3) · responses ที่ไม่มี `role` (Task 2)

- [ ] **Step 1: แก้ UI ตามไล่ด้านบน**
- [ ] **Step 2: verify ด้วย browser** — รัน server เปิด ui: register user ใหม่ → ไม่พบ setup-admin → แชตใหม่ → ส่งโดยไม่เลือกโปรเจค = ปฏิเสธพร้อมข้อความแนะนำ → เลือกโปรเจค → ข้อความแรกยิง work สำเร็จ + เห็นฉลาก → ลบแชต → `GET /api/chats` record หาย
- [ ] **Step 3: check** `node --check server.js research-agent.js`
- [ ] **Step 4: commit** — `"feat(v18): ui — personal mode + chat-workspace binding"`

### Task 7: ชุดทดสอบรวม v18 + docs

**Files:**
- Delete: `test-auth.js`, `test-member.js` (ล็อกกับ role/gates v17 — สิ่งที่ต้องรอดย้ายแล้ว: per-user API-key R20 + profile/change-password → ไปยืนใน `test-accounts.js` (Task 2), queue/busy → ฝากใน test-server-mock.js หากไม่มีอยู่)
- Create: `docs/v18-changelog.md` (สรุปการเปลี่ยน + อ้าง spec)
- Modify: `README.md`, `AGENT-ROADMAP.md`, `project-history.md` — บันทึกเป็น v18 (design doc §2-§5 + §8 Supabase = เฟสถัดไป)

- [ ] **Step 1: ยืนยันความครอบคลุม R20/profile/change-password อยู่ใน test-accounts.js ครบก่อนลบ** — ถ้ายังไม่มี ให้เพิ่ม assert สองอันนี้ก่อนแล้วให้ PASS
- [ ] **Step 2: ลบ test-auth.js + test-member.js**
- [ ] **Step 3: รัน suite ทั้งหมดที่เหลือ** — test-server-mock / test-smoke / test-mock / test-tools / test-tier1 / test-playbook / test-evals / test-codemode / test-workspace / test-project-editor / test-security-guards / test-protected-files / test-accounts / test-chats / test-ws-state → PASS ครบ exit 0
- [ ] **Step 4: เขียน changelog + แก้ docs v18** — README/ROADMAP/project-history อ้าง spec + plan
- [ ] **Step 5: commit** — `"docs(v18): changelog + updated roadmap/history"`

---

*หมายเหตุ: Task เรียงลำดับข้ามไฟล์ได้น้อย — Task 1→2→3 ผูก interface กันแน่น (blocklist → gate → binding) แนะนำรันตามลำดับ; Task 4/5 ใน engine อิง ctx จาก Task 3; Task 6 ผูกท้าย เมื่อ API ครบ; Task 7 ปิดด้วย suite สีเขียว + docs*
