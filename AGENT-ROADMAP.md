# 🗺️ AGENT-ROADMAP.md — สิ่งที่มี / จะทำ / ต้องระวัง (กันลืม)

> อัพเดต: 2026-10-25 · สถานะ: Engine v2 พร้อมใช้ · เป้าหมาย: "Compounding Agent" — ความฉลาดสะสมอยู่ใน **harness** ไม่ใช่โมเดล
> หลักคิดเดิมของโปรเจ็คต์: zero-dependency Node.js (ไม่มี npm install) · token thrift (⛁) · model-agnostic (เปลี่ยนโมเดลจาก dropdown)

---

## 1. สิ่งที่ทำแล้ว (ปัจจุบัน — Engine v2)

| ส่วน | รายละเอียด |
|---|---|
| `research-agent.js` | agentLoop เดียวทั้ง orchestrator/sub-agent · retry 4 ครั้ง (401/403/402 = Fatal ไม่ retry) · streaming SSE (`callLLMStream` + `makeSSEAccumulator`, onDelta(null) = ล้างข้อความค้าง) · tool calls ขนาน (Promise.all) + dedupe cache ต่อ run (`↻ cached`) · trimToolResults (เก็บเต็ม 2 ชุดล่าสุด เก่าหั่น 300 chars) · token log ⛁ in/out/total (ใช้ usage จริงจาก stream ถ้าได้) |
| Tools (11 ตัว) | web_search (OpenRouter `:online`) · web_fetch (http/https, stripHtml, fetchMaxChars) · get_datetime · calculator · js_eval (child_process sandbox 5s, tempdir ล้างตัวเอง) · file_read (โปรเจ็คต์เท่านั้น, แบน .openrouter_key/node_modules/.git) · file_write (เฉพาะ `reports/`) · memory_save/recall (`.agent_memory.json`, key≤50) · research_subagent (depth limit 1, งบ fetch 2600) |
| `server.js` | PORT 8787 · key โหลดก่อน listen · GET /api/models (cache 10นาที) · POST /api/ask SSE: log/answer-delta/answer-reset/answer/error · validate {model,temp,maxSteps,history} · body history ≤8 ข้อความ × 1200 chars |
| `ui.html` | sessions sidebar (30 อัน, ค้นหา/ลบ✕/rename dblclick/export .md) · streaming bubble + Stop ⏹ + copy · chips activity: ⚡steps 🔍 🌐 👥 ⛁tok ⚠errors · settings temp/maxSteps (persist localStorage `ra_set`) |
| Memory | `.agent_memory.json` + preload "Known memory keys" ใน system prompt (orchestrator เท่านั้น) |
| Tests | test-mock.js (multi-agent + error self-recovery) · test-server-mock.js (SSE stream mock + 200/429 guard) — ผ่านทั้งคู่ |

## 2. ปัญหาที่รู้ตัวตอนนี้ (ต้องจำ!)

- 🔴 **HTTP 402 Insufficient credits** — แพ็ค `:online` ของ OpenRouter (web_search) **มีค่าใช้จ่าย**: key free-tier ของ user ยิง search ไม่ได้ (web_fetch ยังทำงานปกติ — raw.githubusercontent.com จ่ายใช้ต่าง ๆ แทนได้)
- 🟡 Free provider (Nvidia) พลิก **502 transient** — retry ทนอยู่แล้ว (1s/2s/4s/8s)
- 🟡 **Agent ไล่ 404 repo-name 45 ครั้ง** (ทดสอบค้น "Alita" จริง ใช้ 77k tok 12 steps) — ไม่มีกฎ "ห้ามเดา URL ซ้ำ/เดาชื่อ repo อึกครั้ง"

## 3. Main Idea: "Compounding Agent" — 3 วงจรสะสม

**หลัก:** Failures → กฎ, ความต้องการ → tool ถาวร, งาน → checklist. โมเดลเปลี่ยนได้ ของสะสมไม่หาย

> 🎯 **ตัวกระตุ้น (SPARK)** ถูกฝังใน agent แล้ว (v12): `SPARK_RULES` ต่อท้าย system prompt ทุก run (orchestrator เท่านั้น) พูดถึง "ทุก run ต้องทำให้ run ถัดไปดีกว่า" + แนว 3 วงจร (อ่านกฎ playbook ก่อน / ของที่จะเจอซ้ำสร้างเป็น tool_create / pattern สำเร็จบันทึก memory_save) + จูงใจจ่ายโทเค็นต่ำ เพื่อวงจรคุ้มทุน — ดู project-history.md เวอร์ชัน 12

### วงจร 1: Failure → Rule (Playbook) — ✅ เสร็จแล้ว (2026-10-25, version 9)
Implementation (ตามแผนที่ user อนุมัติ "ทำเลย"):
- [x] `agent-events.jsonl` — append-only event log ต่อ run: {runId, ts, task, steps, tools, outcome, errors[], tok, model}. cap 500 บรรทัด (ใน agentLoopCore + learnFromRun)
- [x] `agent_playbook.json` — {id, rule, tag, usageCount, lastSeen} cap 50 — รองรับ 3 กลไก: bump/dedupe/drop น้อยสุด-เก่าสุด
- [x] Reflector (1 LLM call เท่านั้น, เฉพาะ run ที่มี error): reflectOnRun → "TAG: กฎ 1 บรรทัด" → scrub ทุกจุด (sk-or-***)
- [x] Curator (โค้ดเท่านั้น ไม่ใช้ LLM): dedupe ด้วย Jaccard ≥0.6 + bump usageCount ถ้าซ้ำ — กัน playbook บวม
- [x] `loadPlaybookForTask(task)` — คัด 5 กฎหัวสุดเกี่ยว (overlap × usage × freshness) inject ≤400 tok เฉพาะ system prompt orchestrator
- [x] Seed rules: (a) 402 `:online` → เปลี่ยน web_fetch raw.githubusercontent/wiki แทน (b) 404 URL เดา → stop guessing ใช้ web_search หาก่อน (c) 502/429 → 3 รอบติดให้เสนอเปลี่ยนโมเดล
- [x] UI: chip “📓 playbook N rules.” คลิกเห็น popover กฎรายตัว + refresh หลังทุก run + GET /api/playbook
- [x] CLI: `node research-agent.js --playbook`
- [x] Tests: test-playbook.js 15 asserts — event/กฎใหม่/dedupe-bump/system prompt รับกฎครั้งถัดไป/scrub secret (mock world, isolation ผ่าน env; แก้ addRule bug และแล้ว)

### วงจร 2: Need → Tool (Self-extending tools) — ✅ เสร็จแล้ว (2026-10-25, version 11) ต้นแบบ: Alita + Voyager
- [x] Agent ขาด tool → เรียก `tool_create` (name/description/code/test_args/params) → เขียน `tools/<ชื่อ>.js` + **ทดสอบรันจริงก่อนลงทะเบียน** (timeout 10s, ต้อง print JSON ตาม contract ไม่งั้น reject ทั้งชิ้น; ล้มเหลว = ลบไฟล์ + ส่ง error กลับให้ลองใหม่)
- [x] `skills/index.json` (cap 30, evict lowest-calls) + `GET /api/skills` + badge 🧱 ใน UI; โหลดเป็น spec ปกติเข้า getTools() ทั้ง research/code และ **live-spec injection** — register แล้วใช้ได้ทันทีใน run เดียวกัน (ctx.toolsRef)
- [x] กันรั่ว: ชื่อ regex ^[a-z][a-z0-9_]{2,29}$ + ห้ามชน built-in + code ≤10k + ห้ามพูดถึงไฟล์ key/playbook/events
- [x] Test: test-tools.js 13 asserts (GOOD=register+live+persist+calls, BAD=reject+rm+playbook เรียนกฎ [tools], BUILTIN ถูก block) — suite รวม 6 ไฟล์ 74 asserts ผ่านหมด

### วงจร 3: Task → Eval (Checklist ต่อชิ้นงาน) — ✅ เสร็จแล้ว (2026-10-25, version 14) ต้นแบบ: กระบวนการ mini-SWE-agent + SWE-bench
- [x] งานสำเร็จ (outcome ok + **≥3 steps** + ใช้ tool) → Eval curator 1 LLM call → format `PATTERN: keywords | CHECK: step1; step2; step3` → บันทึก `agent_evals.json` (cap 20, evict usage ต่ำสุด)
- [x] Dedupe code-only (Jaccard keywords ≥0.5 → bump usageCount ไม่สร้าง entry ใหม่) + keywords แยก regex รองรับไทย `[a-zA-Z0-9\u0E00-\u0E7F]{2,}`
- [x] Inject งานคล้ายกันถัดไป: intersection คำ ×10 + usageCount → top ≤3 ในงบ ~300 tok ต่อท้าย playbook injection (orchestrator เท่านั้น) + log `🎯 eval hints injected`
- [x] Off switch สด ๆ: `AGENT_NO_EVALS=1` (อ่าน process.env ทุกครั้ง → toggle runtime ได้ ใช้ใน mock tests เดิมทั้ง 5 ไฟล์) + CLI `--evals` + `GET /api/evals` + badge 🎯 ใน UI
- [x] KPI เริ่มได้จริง: `evalSummary()` สรุป ok runs + avgTok/run (ต่อยอด KPI 📉 tokens/งานสำเร็จ — ให้วัดผลของ eval ว่าลด token ลงจริง); test-evals.js 8 asserts (สร้าง eval/reflector แม่นยำ 1 ครั้ง/inject hints/dedupe bump/งานสั้นข้าม/off switch ปิดจริง)
- [x] คิวงาน: task queue ลึก 1 ใน server.js แทนการ 429 ทันที (SSE event `queued` + chip ⏳ ใน UI + guard `if (!res.headersSent)` กัน ERR_HTTP_HEADERS_SENT เมื่อ runTask ซ้อนกัน); คิวเต็ม (2 ชิ้น) ยัง 429 พร้อมข้อความ

### Code Mode (ทำ Agent เขียนโค้ดเล็มงบ — ไม่พึ่งพาโมเดลแพง — SWE-agent ACI philosophy)
- [ ] `run_command` (cwd โปรเจ็คต์, timeout 15s, sandbox จะแชร์จาก js_eval)
- [ ] `file_read(path, offset, limit)` แบบมีบรรทัดเลข + `grep(pattern, path, include)` (ใช้ Node fs เดินไฟล์เอง)
- [ ] `edit(path, oldString, newString)` exact-match (match ไม่พบ = fail อย่าเขียนทั้งไฟล์ เหมือน ACI ของ SWE-agent)
- [ ] Rule: “แก้แล้วต้องรันจริง — ห้ามบอก “เสร็จ” โดยไม่มี evidence”(verification gate) + critic pass (LLM รอบ 2 ว่าเป็น reviewer)
- [ ] อ่าน/guard AGENTS.md ของโปรเจ็คห้ามิ่งชิง (project rule injection)

## 4. ⚙️ กติการันตีของทุกวงจร (กันตัวเองพัง)
1. playbook inject **≤5 กฎ × ~80 tok** — เกินให้ unique usageCount นำ (never添 open-end)
2. Reflector เพิ่ง 1 call/task (give up power) — ห้ามวนๆ reflective loop กิน token เปลา
3. Curator ต้อง **โค้ด string-match** — ไม่ใช้ LLM (กัน cost บวม)
4. event log = **append-only** + ตัดเก่าตาม cap — ห้ามโหลดทั้งไฟล์เข้า context ทุก run
5. Rule ที่ไม่นำไปใช้ ≥2 run → ติด flag อบตาด (เข้าไม่ แสดงผลเียขนิด)
6. ห้ามบันทึก key/secret/password ลง event/playbook (sanitize ก่อนเขียน)
7. ทุกไฟล์ state ใหม่ต้องเข้า `\.gitignore` (agent-events.jsonl, agent_playbook.json, .agent_memory.json, .openrouter_key, reports/*)

## 5. ขั้นตอนต่อต้องลอง features เพิ่ม (idea bank, ทำทีหลังได้)
- Progressive disclosure: **skills โหลดรายละเอียดเมื่อถูก trigger** (มาจาก Anthropic Skills / OpenHands) — ตัว Topic Fileหลัง events ครั้งว่า refactor
- Spec-driven task แบบ Kiro (requirements → design → tasks) สำหรับงานเขียนโปรแกรมใหญ่
- Streaming tool-output (unท เราแสดงแค่ answer ล่าว)
- DOM/perplexity อยากซื้อ/หาประกาย code search API อิสระ (ตอนติ้งจาก credits หมด)

## 6. ทดสอบเมื่อทำวงจร (ยังต้องทำเมื่อ implement แต่ละอัน)
- mock: (a) push event → jsonl เพิ่มถูกบรรทัด (b) run มี error → regen shot playbook ใหม่จริง: (b2) rule 402 ถูกแทรก tag provider/402 (c) run ซ้ำใน system prompt มี rule จริง (d) dedupe: run เดิมไม่สร้าง rule ซ้ำ (e) UI แสดง playbook chips
- จริง: (ให้ user เทสไอ้มันเมื่อ key กลับมาเส้น :online ทำงานได้ / ทดสอบเฉพาะ file tools กับ run_command โดยไม่ต้อง network)

## 7. ข้อมูลอ้างอิง (หลักการที่ฉุดมาใช้)
| โปรเจ็คต์ | หลักการ | ลิงก์ |
|---|---|---|
| Alita (Princeton 2025) | minimal agent + สร้าง MCP tools เอง + distill ใช้ซ้ำ | arxiv.org/abs/2508.08636 |
| ACE (Stanford 2025) | playbook + Generator/Reflector/Curator + delta update ไม่ทำ fine-tune | arxiv.org/abs/2510.04618 |
| Voyager (2023) | automatic curriculum + skill library + iterative prompting | arxiv.org/abs/2305.16291 |
| SWE-agent (2024) | ACI design: ปิดทางทำพลาดใน tool + compress view | arxiv.org/abs/2405.15793 |
| OpenHands | event stream + condenser + microagents (keyword-trigger) | github.com/OpenHands/OpenHands |
| Letta/MemGPT | แยก main context/external memory, self-editing | github.com/letta-ai/letta |
| Claude Code/Cursor/Cline (2026 survey) | checkpoint/rollback, plan mode + approve, AGENTS.md rules, cost badge — มาตรฐานของ agent ที่ "ใช้งานจริงจูงใจ" | (web research v15) |

## 8. ความสะดวกในการใช้งาน (Tier 1) — ✅ เสร็จรอบเดียวกับ v15 (2026-10-25)
- [x] 🖥 Desktop shell zero-dep: `agent-app.vbs` (probe server → auto บูต → `msedge --app` หน้าต่างสแตนด์อโลน) + `Research Agent.lnk` บน Desktop
- [x] 🔒 Checkpoints + diff review: snapshot อัตโนมัติก่อน file_edit/file_write/run_command → UI 🔒 ดู diff แยกสี + ย้อนกลับ (30 ก้อนล่าสุด, `AGENT_NO_CHECKPOINTS=1` ปิด)
- [x] 📋 Plan mode: ปุ่ม 📋 → research-only → SSE การ์ดแผน → ปุ่มอนุมัติใน UI → `plan_done` ทีละขั้น
- [x] 📝 AGENTS.md: กฎผู้ใช้บังคับก่อน อ่านทุก run — UI แก้ได้ผ่านปุ่ม 📝 (ไม่ต้องแตะไฟล์)
- [x] ⛁ cost/context badge: token ที่ใช้ vs % context window ของโมเดลที่เลือก
- [x] Crash guard: `uncaughtException`/`unhandledRejection` + double-end guard — LLM timeout/บั๊กเล็กไม่ปิด server อีก

**เหลือใน idea bank (Tier 2):** auto-compaction ใกล้ context limit · hooks (ตรวจแบบ deterministic หลัง edit) · permission matrix allow/ask/deny · git auto-commit boundary · `-p` headless one-shot JSON mode · MCP client (stdio JSON-RPC)

---
**ลำดับทำที่แนะนำ:** ~~วงจร 1 MVP → เทส mock → ให้ user ทดสอบจริง → วงจร 2 → Code Mode → วงจร 3~~ **ครบทั้ง 3 วงจรแล้ว (v14)** — วงจรต่อไป:
**กติกากลาง:** ทุก feature ใหม่ต้องตอบได้ว่า "ช่วยโมเดลธรรมดาเก่งขึ้นได้อย่างไร และกิน token เพิ่มเท่าไหร่"
