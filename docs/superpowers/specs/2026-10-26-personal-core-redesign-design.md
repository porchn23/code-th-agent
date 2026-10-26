# 📐 Design: Personal Core — คอร์กลางเดียว + Chat session↔Workspace + ความรู้กลาง

> วันที่: 2026-10-26 · สถานะ: **อนุมัติแล้ว (แบบแยกเฟส)** — เฟส 1 = local core (งานรอบนี้) · เฟส 2 = Supabase (พัฒนาถัดไป — §8)
> ที่มา: ปัญหาจริงจากการใช้ — web UI แตะไฟล์โปรเจคจริงในเครื่องได้จำกัด
> สาเหตุยืนยันจากโค้ด: ไม่ใช่บั๊ก แต่เป็นแนวคิด role (admin/member) ที่ล็อกไว้โดยดีไซน์ 4 ชั้น

## 1. เจตนา (Why)

- **อาการ:** agent จัดการไฟล์โปรเจคในเครื่องจริงไม่ได้/ติดขัด ทั้งที่ควรทำได้
- **สาเหตุ:** ประตูสิทธิ์ 4 ชั้นที่ฝังไว้ — (1) file tool แตะได้เฉพาะ workspace ที่เลือก (2) เพิ่ม workspace/เลือกโฟลเดอร์เครื่องเฉพาะ admin (3) ownership gate ต่อรายไฟล์ (4) `trusted` flag ล็อก run_command/custom tools ให้ admin
- **ตัดสินใจผู้ใช้:** ระบบนี้ = เครื่องมือส่วนบุคคล — **ไม่มี Admin** ไม่มีใครจัดการ user คนอื่น; ผู้ใช้ใช้เอง ชี้ project dir เอง; ใช้ในเครื่อง (local) first — Cloud dir พัฒนาทีหลัง
- **เป้ารวม:** **คอร์กลางเดียว** — Node engine + HTTP/SSE API ชุดเดียว (`server.js` พอร์ต 8787) — ทุกหน้าจอ/เชล (ui.html, desktop shell, CLI ภายหลัง) เป็นแค่ client

## 2. หลักระบบที่ตกลงแล้ว

1. **ตัด role ทั้งหมด** — ไม่มี admin/member, ไม่มี setup "สร้าง admin", ไม่มีจัดการ user โดยคนอื่น
2. **Workspace ชี้เองได้ทุกโฟลเดอร์ในเครื่อง** — ลบข้อบังคับ "สมาชิกเพิ่มได้เฉพาะใต้โฟลเดอร์ส่วนตัว" + เปิด `/api/directories` ให้ทุกคน (+ รับ path พิมพ์ตรง ๆ ได้ — Edge app เปิด native folder picker ไม่ได้)
3. **Chat session ↔ Workspace ผูกตายตัว** — 1 chat session = 1 โปรเจค · อยากทำโปรเจคใหม่ = **เปิด chat session ใหม่** (sidebar เดิม + label "โปรเจค: X") · ห้ามสลับ workspace กลาง chat session · agent ห้ามสลับ root เองตลอดชีวิต และส่ง root เดียวกันต่อให้ sub-agent · `/api/ask` ตรวจ chatId ↔ wsId ต้องตรงกัน — ไม่แมตช์ไม่รับ
4. **แยกกันเด็ดขาดในระดับงาน** — ไฟล์/ประวัติ/แผน/checkpoint/reports ผูกกับ chat-session/workspace ของงานนั้น · ลบ session หรือลบโปรเจค **ไม่มีผลกับโปรเจคอื่น** · ไม่ใช้ข้อมูลการทำงานร่วมกัน
5. **Sub-agent** — ได้ root เดียวกับงานต้นทางโดยอัตโนมัติ (ส่ง ctx.root ให้ลูก — ตอนนี้ยังไม่ส่ง ต้องแก้หนึ่งจุด) · คงแบบ **web-only** (ไม่มี file tools รอบนี้ — กันหลายตัวเขียนไฟล์ชนกัน) · read-only access ไว้พิจารณาภายหลัง
6. **ความรู้กลาง = global (สำคัญที่สุด)** — playbook (วงจร 1) / skills (วงจร 2) / evals (วงจร 3) / SPARK / memory เป็น**สินทรัพย์เดียวบนดิสก์ ใช้ร่วมทุก user ทุกโปรเจค ทุก agent ทุก sub-agent** — **คลังอยู่กับ "ตัวระบบ" (ไฟล์ข้าง server.js / data dir) ไม่ฝังในโปรเจค**: โปรเจคที่เก็บบน Google Drive ก็เปิดเป็น workspace ทำงานได้ และบทเรียนที่ได้ยังไหลเข้าคลังเดียวกัน · ข้อมูลการทำงานแยก แต่ความฉลาดสะสมรวมศูนย์
7. **Security invariants คงเดิม + เติมให้ประกาศเป็นจริง** — loopback `127.0.0.1` เท่านั้น · SSRF/redirect/DNS-pin · symlink reject · protected-file blacklist · run_command blocklist คำสั่งอันตราย · scrub `sk-or-***` ทุกจุดบันทึก
8. **trusted flag** — tool ทั้งหมดรวม `run_command`/custom tools เปิดให้ "ผู้ใช้ระบบ" ทุกคน (เดิม admin-only) — เดินด้วยสิทธิ์ OS ของ server, blocklist + guards คงอยู่

## 3. ข้อที่ผมเติมให้ (ตัดสินแทน — ผู้ใช้ตรวจสอบได้ทั้งข้อ)

- คงระบบบัญชีแบบเบา: register ทุกคน + login + โปรไฟล์ + เปลี่ยนรหัส + **key ส่วนตัวต่อคน (R20)** (ตัด role และการจัดการคนอื่นออก) — อยากไม่มีบัญชีเลย = ใช้ `AGENT_NO_AUTH=1` ต่อได้
- workspaces คง field `owner` (ผู้สร้าง) แต่ไม่มี admin bypass อีกแล้ว
- migration แบบไม่แตะไฟล์ state เดิม — logic **ignore** `role` (ไฟล์เก่าที่มี role ยังอ่านได้)
- **แก้จากผู้ตรวจโค้ด — ที่ผูก ws ไม่ใช่ `agent_sessions.json`:** ไฟล์นั้นคือ store ของ login cookie ส่วน chat sessions จริงอยู่ฝั่ง UI เท่านั้น → เพิ่ม chat-session registry ฝั่ง server แบบเบา: **`agent_chats.json` (chatId → wsId)** — เปิดงานใหม่/หรง ask แรกโดยยังไม่ผูก → UI บังคับเลือกโปรเจคแล้ว lock · `/api/ask` validate chatId↔wsId · ลบ chat = ลบ record · โหลดครั้งแรกกวาด orphan — แยกชื่อสองความหมายเสมอ: **"login session" ≠ "chat session"**
- **แก้จากผู้ตรวจโค้ด — plan/checkpoint แยกต่อโปรเจค:** `agent_plan.json` + `agent_checkpoints.json` ตอนนี้เป็นไฟล์ global เดียว — สองงานต่างโปรเจคเหยียบข้ามกันได้ ขัดหลักข้อ 4 → **ผูกตาม wsId** (`agent_plan.<wsId>.json`, `agent_checkpoints.<wsId>.json`, โฟลเดอร์ checkpoints แยกต่อ wsId) — เป็นการเปลี่ยนเพียงชื่อ/เส้นทางไฟล์ ไม่แตะ logic วงจร
- **แก้จากผู้ตรวจโค้ด — blacklist ต่อยอด:** ของจริง `safeProjectPath` ไม่ครอบคลุมไฟล์ข้อมูลระบบ และ `PUT /api/file` ฝั่ง UI ไม่มี blacklist เลย (ให้ประกาศข้อ 7 เป็นจริง) → รวม: ไฟล์**ข้อมูล**ทั้งหมดของระบบ (`agent_users.json`/`agent_sessions.json`/`agent_chats.json`/`agent_workspaces.json`/`agent_plan*.json`/`agent_evals.json`/`agent-events.jsonl`/`agent_checkpoints*` + list เดิม .openrouter_key/.git/node_modules/.agent_memory/agent_playbook.json) **ห้ามทั้ง engine ทั้ง tool PUT ของ UI เขียนในทุกกรณี** · ส่วน**โค้ดของระบบ (server.js/ui.html/…) ไม่เข้า blacklist** — repo นี้ใช้เป็นโปรเจคที่ agent แก้โค้ดตัวเองได้ตามปกติ
- **แก้จากผู้ตรวจโค้ด — dead paths รอบ trusted:** engine ทุก path ที่รับสิทธิ์ admin/member (runTool gate ~:1421, ช่อง "admin only" ใน system prompt ~:1511, filter trusted ใน getTools) ตัดทิ้งหมด — ขอย้ำว่าข้อ "แตะ engine น้อยที่สุด" มีรายการเป้าหมายชัดเจนพอตรวจสอบได้
- **desktop shell:** ตอนนี้คง `agent-app.vbs` (Edge app window) — Tauri shell (แบบ spawn `node server.js` เป็น sidecar) ไว้ทีหลังคอร์ดีไซน์เสร็จ — **Rust engine port (`desktop/src-tauri`) ยุติ เก็บ archive (ไม่ลบ)**
- playbook/evals injection คง orchestrator-first (sub-agent ยังไม่รับ rule injection — เป็นงานต่างหากถ้าระบุความจำเป็นชัด)

## 4. ขอบเขตงาน (เขียนเป็น plan ต่อจากนี้)

| ไฟล์ | เปลี่ยนอะไร |
|---|---|
| `server.js` | ลบ `/api/users`, `/api/users/remove` + ลบ role gates ที่ directories/workspaces/ownership/trusted + endpoint จัดการ `agent_chats.json` + `/api/ask` validate chatId↔wsId + ส่ง `trusted` ตรงตามเดิม (admin ออก) |
| `research-agent.js` | ตัด path admin/member ตายตก (runTool gate/ช่อง system prompt/getTools filter) + **plan/checkpoint ต่อ wsId** + `runSubagent` ส่ง ctx.root ให้ลูก + blacklist `safeProjectPath` ต่อยอดไฟล์ข้อมูล — **ไม่แตะ loop/วงจร/circuits นอก 4 จุดนี้** |
| `ui.html` | ลบ 👤 จัดการสมาชิก + setup-admin flow + label "โปรเจค" ต่อ chat session + บังคับเลือก workspace ที่ขอ new chat แล้ว lock · ลบ chat = เรียก server ลบ record |
| `workspace-files.js` | ใส่ blacklist ชุดเดียวกับ engine ให้ PUT แตะไฟล์ข้อมูลระบบไม่ได้ |
| tests | ครอบคลุมเดิมที่ต้องรอด: per-user API-key (R20), profile/เปลี่ยนรหัส, register/login + เพิ่มใหม่: ห้ามสลับ chat session ข้ามโปรเจค / plan-checkpoint แยกต่อ ws / blacklist ต่อยอด / trusted-for-all — รูปแบบจัดไฟล์ว่า rewrite หรือแตกไหม = ของผู้สร้าง — ชุดอื่นต้องยังผ่านทั้งหมด |
| docs | README + AGENT-ROADMAP + project-history บันทึกเป็นเวอร์ชัน 18 |

## 5. กติกากับผู้สร้าง (builder)

- zero-dependency ต่อ (ไม่ npm install, Node built-in เท่านั้น)
- test suite = สเปก — รัน suite ครบก่อนประกาศเสร็จ + verify ผลจริงก่อนเสมอ
- แก้แบบประหยัด ย่อทัน feature กันพอง (ไม่รีเฟรชทั้งไฟล์) — อ่านก่อนแก้เสมอ
- จำ token thrift: playbook/evals/skills injection ส่วนกลางห้ามอ้วนเกินเดิม (~400/~300 tok)
- state JSON ร่วมได้ข้ามเวอร์ชัน — ของที่ user มีแล้วไม่พัง (อ่าน `agent_users.json` เก่าที่มี `role`, workspaces เก่า, plan/checkpoint เก่า global → อ่านได้อย่างน้อยครั้งแรกครั้งเดียวเสมอ)

## 6. งานไม่อยู่ในงานนี้ (idea bank)

- Cloud = **การเก็บ "โปรเจค" บนคลาวด์ (เช่น Google Drive) โดยไม่ต้องมีสำเนาไว้ในเครื่อง** (ผู้ใช้ชี้ความหมายชัดเจน 2026-10-26) — พัฒนาทีหลัง · ต่างจากเรื่อง "ซิงค์คลังความรู้" (ด้านล่าง)
- **การซิงค์/แชร์คลังความรู้สะสม ข้ามเครื่อง — ผู้ใช้เลือกแล้ว: ยกทั้งเรื่องไปเฟส 2 ผ่าน Supabase (แบบแชร์แท้)** — รอบนี้: 1 เครื่อง = 1 คลัง (user ทุกคนบนเครื่องนั้นแชร์คลังเดียว) — ทางเลือก A (export/import) / B (Drive sync) ยกเลิกไม่ทำ (Supabase ครอบคลุมกว่า)
- sub-agent read-only file tools
- playbook/evals แยกต่อ workspace (ถ้าความรู้กลางพิสูจน์ว่ารบกวน) / injection ให้ sub-agent
- MCP client · auto-compaction · hooks · git auto-commit · `-p` headless mode
- Tauri desktop shell (sidecar)
- ~~permission matrix~~ — **anti-goal** ตัดสินว่าไม่ทำ
- **Database (SQLite)** — ยังไม่ใช้รอบนี้: คลังเล็ก (กฎ 50/skill 30/eval 20/event 500) ไม่มีปัญหา scale, JSON = แชร์/สำรอง/แก้มือง่าย และ test suite+archive อ้างรูปแบบไฟล์อยู่ — **เงื่อนไขตื่น:** (1) เฟส Cloud แบบแท้ (server กลาง หลายเครื่องเขียนพร้อมกัน) (2) ผู้ใช้/งานโตจนต้องค้นหาประวัติหลักหมื่น — เมื่อตื่นใช้ `node:sqlite` built-in Node v24 (คง zero-dep)

## 7. ข้อมูลอ้างอิงโค้ด (line refs ที่ผู้ตรวจยืนยันตรงแล้ว)

- `server.js`:82-95 `agent_sessions.json` = login cookie store · `:138` canManageWorkspace · `:143` authorizedWorkspace · `:259-260` trusted · `:620-650` workspaces filter/add · `:668` directories admin-only · `:603-614` users routes · `:714` PUT file gate
- `research-agent.js`: agentLoop default trusted=true (~:1482 — คงเดิมได้) · runTool admin gate (~:1421 — ตัด) · ช่อง admin/member ใน system prompt (~:1511-1513 — เคลียร์) · `:329-331` SUBAGENT_EXCLUDE + MAX_SUBAGENT_DEPTH · `:428-435` safeProjectPath (blacklist ปัจจุบัน ครอบไม่ครบไฟล์ข้อมูล) · `:1404` runSubagent (ยังไม่ส่ง ctx.root — ต้องแก้)
- `security-guards.js:97-122` safePathInRoot (lexical + symlink + realpath) — คงเดิม
- ไฟล์ state: `agent_users.json` คง + ignore `role` · `agent_sessions.json` คง (ไม่แตะ) · `agent_workspaces.json` คง format · **เพิ่ม `agent_chats.json`** · `agent_plan.json`/`agent_checkpoints.json` → แยกต่อ wsId

## 8. เฟส 2 — Supabase (ทิศทางถัดไปที่ผู้ใช้เลือก ไม่อยู่ในงานเฟส 1)

> โครงของผู้ใช้ 26 Oct: "ระบบสมาชิก ลดงานได้เยอะ google login ผ่าน Supabase / ระบบคลังความรู้กลางที่บันทึกและอัพเดทได้เรียลไทม์ / user project"

- **Auth = Google login ผ่าน Supabase** — OAuth Google provider + ตรวจ JWT ผ่าน REST ของ Supabase (fetch ล้วน — คง zero-dependency ไม่ install SDK) — แล้วแทนระบบบัญชี local ของ v17 (register/login/โปรไฟล์เดิมถูกแทนตอนเฟส 2) · **ยังไม่มี role/admin ตามหลักระบบ**
- **คลังความรู้เรียลไทม์ข้ามเครื่อง** — ย้าย playbook/skills/evals ไปตาราง Supabase Postgres + Realtime; ไฟล์ local เป็น cache + fallback ออฟไลน์ (จะคิวกันแก้ไขทมิ่งหลังกลับออนไลน์) — ทุกเครื่องที่ล็อกอินบัญชีเดียวกันเห็นความรู้ชุดเดียวกัน / "Compounding ใช้ข้ามเครื่อง"
- **user project** — meta ของโปรเจค (ชื่อ/เจ้าของ/binding) อยู่ใน Supabase + RLS แยกต่อบัญชี · ไฟล์โปรเจคยังอยู่เครื่อง (ชี้เอง) · โปรเจคไฟล์บนคลาวด์แท้ (Drive/Storage) = ระยะหลังตามนิยาม Cloud ใน §6
- กติกาเฟส 2: ต้องออนไลน์ตอนล็อกอิน (ออฟไลน์ = cache/fallback) · user สมัคร Supabase ฟรี + เปิด Google provider เอง · URL/anon key ใส่ config ไฟล์ใหม่แยก (**ห้ามแตะ .env/.openrouter_key ตาม AGENTS.md**) · ตั้ง RLS ให้ถูกก่อนเปิดใช้ · ผูกบัญชี Supabase กับของเดิม (ย้าย key ต่อคน/โปรไฟล์ครั้งเดียวตอนล็อกอินครั้งแรก)
- **เฟส 2 เริ่มเมื่อเฟส 1 สำเร็จ + ทดสอบผ่านครบเท่านั้น** (จากการตัดสิน: "A ก่อน แล้วพัฒนาเลย" — มีแผนแยกต่อ)

---

*ข้อตกลงฉบับนี้เป็นข้อตกลงเริ่มทำ — ถ้าจะเปลี่ยนหัวข้อใด แก้ที่ไฟล์นี้ก่อนลงมือ เพื่อให้ plan ตรงเสมอ*
