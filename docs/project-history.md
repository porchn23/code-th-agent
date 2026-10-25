# thai-agentic — เอกสารสรุปโปรเจคและบทสนทนาทั้งหมด

> สรุปทุกอย่างที่คุยกันและสร้างมาตั้งแต่ต้น จนถึงการย้ายโปรเจคมาที่ `D:\Github\thai-agentic`
> วันที่อัปเดตล่าสุด: 2026-10-24

---

## 1. ที่มาของโปรเจค

เริ่มจากคำถามว่า **"การสร้าง AI agent แบบ OpenCode/Manus ยากแค่ไหน?"** — คำตอบคือ หลักการไม่ได้ยากอย่างที่คิด: agent = **LLM + เครื่องมือ (tools) + วงลูป (loop)** เท่านั้น จึงตกลงเรียนรู้แบบลงมือสร้างจริงโดยมี AI ช่วย เดินหน้าทีละขั้นจากเวอร์ชันเล็ก ๆ ส่วนใหญ่ (ผู้ใช้พูดภาษาไทย, ใช้ Windows 11 + PowerShell)

**เงื่อนไขตั้งต้น:** อยากใช้ **โมเดลฟรี** (OpenRouter free tier), **ไม่ติดตั้ง dependency ใด ๆ เลย** (ไม่มี npm install — ใช้ Node.js build-in เท่านั้น, Node v24)

---

## 2. ไฟล์และสถาปัตยกรรม

ทุกไฟล์เป็น zero-dependency Node.js:

| ไฟล์ | หน้าที่ |
|---|---|
| `research-agent.js` | core agent — LLM + 10 tools + agent loop (OpenAI-compatible chat/completions ผ่าน OpenRouter) |
| `server.js` | web backend, port **8787** — SSE streaming, model list, concurrent guard |
| `ui.html` | หน้า UI สไตล์ OpenCode — dark theme, sidebar sessions, streaming answer, chips |
| `js-eval-runner.js` | runner ฝั่ง sandbox ของ `js_eval` (child process → `node:vm`) |
| `test-mock.js` | ทดสอบ agent loop แบบ offline (13 assert: sub-agent / error recovery / sandbox / XSS) |
| `test-server-mock.js` | ทดสอบ server + SSE + guard + Stop + ลำดับ tool (8 assert) |
| `test-smoke.js` | smoke test HTTP surface จริง (5 assert) — ไม่ใช้เครดิต |
| `.openrouter_key` | API key ของผู้ใช้ (ถูก ignore แล้วด้วย `.gitignore`) |
| `.gitignore` | กัน key / memory / reports / events หลุดเข้า git |

### สถาปัตยกรรมแกน: LLM + Tools + Loop

```
ผู้ใช้ → task → [ System Prompt + History ] → LLM
                    ↓ (โมเดลเรียก tool_calls)
              runToolCalls (parallel + dedupe cache)
                    ↓ ผลลัพธ์กลับเข้า history
              วน loop จนได้ final answer หรือครบ maxSteps
```

### CONFIG สำคัญ (research-agent.js)

- โมเดล default: **`nvidia/nemotron-3.5-super-vl:free`** (ฟรี, รองรับ tools)
- `maxSteps = 12` (orchestrator), subagent ได้ 6 steps
- Fetch truncation: 4000 chars, subagent 2600 chars
- ประหยัด token: `maxHistoryMsgs 8`, `keepToolResults 2`, trim tool เก่าเหลือ 300 chars
- ไฟล์ state: `.agent_memory.json` (โน้ตสูงสุด 50 อัน), `reports/` (รายงาน)

### 10 เครื่องมือ

1. `web_search` — ค้นเว็บ (ใช้ OpenRouter `:online` suffix — **ต้องมีเครดิต** ดูข้อจำกัดด้านล่าง)
2. `web_fetch` — ดึงหน้าเว็บ, strip HTML, ตัดความยาว
3. `get_datetime` — วันเวลาปัจจุบัน
4. `calculator` — คุมด้วย allowlist ตัวอักษร
5. `js_eval` — รัน JS ใน sandbox จริง (`node:vm`, ปิด codeGeneration, ไม่มี require/process/fs — timeout 4s)
6. `file_read` — อ่านไฟล์เฉพาะนามสกุลข้อความ + ป้องกัน path traversal + ห้ามอ่าน key/data ลับ
7. `file_write` — เขียนได้เฉพาะใน `reports/`
8. `memory_save` / `memory_recall` — จำสิ่งสำคัญข้าม session
9. `research_subagent` — มอบงานย่อยให้ agent ตัวลูก (context สด ไม่ติดเศษมลพิษของงานหลัก) — **ใช้เมื่อจำเป็นเท่านั้น** (คำถามแตกเป็น 2+ ประเด็นที่ไม่เกี่ยวกันจริง ๆ ถึงใช้)

### ระบบประหยัด token (เน้นตามคำขอ "ใช้น้อยที่สุด")

- Streaming (`stream: true`) + อ่าน usage จริงจาก OpenRouter → log `⛁ ~N tok in/out`
- Trim ผล tool เก่าเกิน 2 ล่าสุด เหลือ 300 chars
- Dedupe cache: ไม่ยิง call ซ้ำเดิม (`name::args`) → log `↻ cached — reused to save cost`
- ประวัติแชตส่งแค่ 8 ล่าสุด, ตัดเหลือ 1200 chars/ข้อความ
- Retry 4 ครั้งด้วย backoff 1s/2s/4s/8s เฉพาะ error ชั่วคราว (429/5xx); error เชิงชะตา (401/403/402) ไม่รีไทร์เพื่อไม่เปลือง

### Server + UI

- **SSE streaming:** `/api/ask` ส่ง event `log` / `answer-delta` / `answer-reset` / `answer` / `error` — แสดงคำตอบทยอยตัวอักษร
- **UI:** sidebar จัดการ session (ค้นหา/เปลี่ยนชื่อ/ลบ, เก็บ 30 session ใน localStorage), ปุ่ม Stop, ปุ่ม Copy, ส่งออก .md, ตั้งค่า temp/steps, dropdown เลือกโมเดล (ดึงจาก `/api/models` 468 models, แยกกลุ่มฟรี+รองรับ tools เรียงตาม context)
- **Chips สถิติ:** แถวไอคอนแสดงจำนวน step ⚡ / search 🔍 / fetch 🌐 / subagent 👥 / error ⚠ / token ⛁ — แทนการ์ด AGENT ACTIVITY เดิม
- Concurrent guard: รันซ้อนคนละ request → 429 ทันที

---

## 3. ปัญหาจริงที่เจอจากการใช้งาน (สำคัญ!)

| อาการ | สาเหตุ | สถานะ/ทางแก้ |
|---|---|---|
| `web_search` ล้ม **HTTP 402** "Insufficient credits" | plugin `:online` ของ OpenRouter **ต้องมีเครดิตในบัญชี** (key ฟรีไม่มี) | ปิด/เลี่ยง — เติม ~$10 จะปลดล็อกทั้ง search และโควตา |
| **429 `free-models-per-day`** | โควตาฟรีรายวัน 50 requests/day — เติม $10 ปลดล็อก 1000/day | retry ช่วยได้ระยะสั้นเท่านั้น; เกินคือต้องรอ reset รายวัน |
| **502 จาก Nvidia provider** ถี่ | free model ของ Nvidia ไม่เสถียร ("Failed to generate completions") | agent retry รอดมาได้เอง; ถ้าโดนต่อเนื่อง เปลี่ยนโมเดลจาก dropdown |
| คำตอบอ้างแหล่งเก่า (Firefox "ยังไม่รองรับ" ทั้งที่สถานการณ์เปลี่ยนไปแล้ว) | หน้า web ที่เก่าหลบอยู่อันดับต้น ๆ | เพิ่ม rule ใน system prompt: ตรวจวันที่เนื้อหา และหาแหล่งที่สดกว่า |
| URL บางเว็บ "fetch failed" (arxiv, github หน้า HTML) | สภาพแวดล้อม network / bot-block | ลองแหล่งอื่น; raw.githubusercontent.com โอเค |

การกราด 404 จากการเดาชื่อ repo จนหมด maxSteps (เคสค้นหาโปรเจค self-evolving agent) กลายเป็น **บทเรียนสำคัญ** ที่หล่อหลอมแนวคิด Circuit 1 ด้านล่าง

---

## 3.1 Audit ความปลอดภัย + การแก้ไข (2026-10-24)

ตรวจระบบทั้งหมดแบบรันจริง (ไม่ใช่อ่านโค้ดอย่างเดียว) แล้วแก้ 7 จุด — ทุกจุดมี test ครอบไว้แล้ว

| # | บั๊ก | วิธีแก้ | test ที่ครอบ |
|---|---|---|---|
| 1 | **`js_eval` ไม่ใช่ sandbox** — โค้ดโมเดล `require('fs')` ได้, อ่าน API key จากดิสก์, exec shell ได้ (tool description บอก "no imports/require" แต่ไม่บังคับ) | ย้ายไป `node:vm` + `codeGeneration:{strings:false,wasm:false}` + ตัด `WebAssembly` + สร้าง `console` ภายใน context (ห้ามส่ง host function เข้าไป) + timeout 4s | `test-mock` C1–C6 |
| 2 | **ไม่มี `.gitignore`** ทั้งที่มี `.openrouter_key` ในโฟลเดอร์ `D:\Github\...` | เพิ่ม `.gitignore` (key / memory / reports / events) | — |
| 3 | **XSS ใน markdown renderer** — `esc()` ไม่ escape `"` → `[x](https://evil.com/"onmouseover="alert)` หลุดเป็น handler ใน `innerHTML` | escape ครบ `& < > " '` + `rel="noopener noreferrer"` | `test-mock` D1–D3 |
| 4 | **`test-mock.js` เป็น no-op** — `require.main === module` ทำให้ `main()` ไม่เคยรัน (exit 0 = false green) | เขียนใหม่: เรียก `agentLoop` จริง + assert 13 ข้อ | ตัวไฟล์เอง |
| 5 | **ปุ่ม Stop ไม่หยุด agent จริง** — abort แค่ UI, agent ยังยิง LLM ต่อ (เปลืองโควตา) | `AbortSignal` ต่อ client → `agentLoop` → `sendRequest`/`web_fetch`/`js_eval`; ยกเลิก retry เมื่อ aborted | `test-server-mock` 5a/5b |
| 6 | **`console.log` ถูก patch แบบ global** — restore แบบ nested → request ที่ถูก abort มาทับ patch ของ request ที่วิ่งอยู่ → log หายกลาง stream | เลิก patch global: `agentLoop` รับ `onLog` callback | `test-server-mock` 4 |
| 7 | **ลำดับ parallel tool สลับ** — sort ตาม `id` (string สุ่ม) แทน `index` | เก็บ `index` ตอน parse แล้ว sort ตามนั้น (ตัด field ออกก่อนส่ง API) | `test-server-mock` 6 |

**สิ่งที่เพิ่งรู้จากการ audit** (ยังไม่ได้แก้ เพราะอยู่นอกขอบเขต 7 ข้อ):

- `web_search` ใช้ LLM เรียกอีกครั้งผ่าน `:online` plugin → ต้องมีเครดิต (free key ได้ 402) และกิน 1 completion ต่อ 1 ครั้งที่ search — ตรวจแล้ว slug `:free:online` resolve ได้จริง ปัญหาคือโควตา ไม่ใช่ slug
- `CONFIG.model` / `CONFIG.apiKey` เป็น global mutable — ถ้ามี request ซ้อนกันได้ (ตอนนี้ guard ดันแล้ว เพราะ Stop หยุดจริง) ค่าอาจถูกสลับกลางคัน
- tool output ถูกตัดหนัก (`web_fetch` 4000 chars → tool message 8000) ทั้งที่ prompt สั่งให้ cross-check 2 sources
- UI re-render DOM ทั้งก้อนทุก token → O(n²) และ selection หาย

**ข้อสังเกตสำคัญ:** `test-mock.js` เดิมเป็น false green มานาน — playbook ใน Circuit 1 ถ้าเรียนรู้จากระบบที่ไม่มี test จะเรียนรู้ของผิด ตอนนี้มี test แล้ว

---

## 4. ประเด็นความรู้ที่คุยกัน

### ทำไม agent บางตัวดีกว่ากัน (codex vs antigravity vs opencode vs hermes)

สรุป 5 ชั้นที่ต่อกันเป็นคุณภาพ:
1. **โมเดล** (~50% ของเกม) — ความฉลาดพื้นฐาน
2. **Harness/scaffolding** — agent loop, prompt, retry, tool spec
3. **Context engineering** — จัดหน้าจอให้โมเดลเห็นของที่เป็นประโยชน์พอดี ๆ
4. **Tools/sandbox** — ขอบเขตและความแข็งแรงของเครื่องมือ
5. **Eval/UX loop** — วัดผล, เรียนรู้จากการล้ม

Benchmark สำหรับเทียบ: SWE-bench Verified, τ-bench, Terminal-bench, BrowseComp
**ข้อสรุป:** คุณภาพ "แบรนด์ agent" = โมเดล ✕ harness ร่วมกัน — ไม่ใช่โมเดลอย่างเดียว

### ทำให้ agent นี้เก่ง "เขียนโค้ด" ด้วยโมเดลธรรมดา → แนวคิด Code Mode (ยังไม่ได้สร้าง)

`run_command` (sandbox, timeout), grep tool, อ่านไฟล์เป็นบรรทัด, edit แบบ exact-match, task_plan, critic_review, **verification gate** — ห้ามประกาศงานเสร็จโดยไม่มีหลักฐานว่ารันผ่านจริง

### ไอเดียหลักที่เสนอ: **Compounding Agent** 🧬

หัวใจ: **ความฉลาดใส่อยู่ใน "สินทรัพย์" (Assets) ที่ harness สร้างเอง ไม่ใช่ในโมเดล** — ยิ่งใช้ ยิ่งฉลาดขึ้น ต่างจากฝั่งใหญ่ที่รีเซ็ตเป็นศูนย์ทุก session และ "เช่าฉลาด" จากโมเดล

3 วงจรรวมตัว (compounding circuits):
1. **ความล้มเหลว → กฎ** (Failure→Rule playbook)
2. **ความต้องการ → เครื่องมือ** (Need→Tool — agent ต่อเครื่องมือเองเมื่อขาด)
3. **งาน → checklist ตรวจ** (Task→Eval)

### การค้นโปรเจคที่ทำไว้แล้ว + สิ่งที่ยืมมาใช้

| โปรเจค | หลักการหลัก | โยงมายังวงจร |
|---|---|---|
| **Alita** (arxiv 2508.08636) | agent จิ๋วสร้าง MCP tool เองตอนจำเป็น (GAIA ดีขึ้น) | วงจร 2 |
| **ACE** (arxiv 2510.04618) | playbook ปรับด้วย Generator / Reflector / Curator แบบ delta ทีละน้อย (AppWorld +10%) | **พิมพ์เขียวของวงจร 1** |
| **Voyager** (arxiv 2305.16291) | หลักสูตรอัตโนมัติ + skill library เก็บโค้ดที่รันผ่าน | วงจร 2 / หลักสูตร |
| **SWE-agent** (arxiv 2405.15793) | ACI design — ออกแบบ tool ให้ทำพลาดแบบที่มนุษย์/โมเดลชอบทำ **ไม่ได้เลย** | Code Mode |
| **OpenHands** (github.com/OpenHands/OpenHands) | event stream + condensers + microagents กระตุ้นด้วย keyword โดยไม่ต้อง embedding | event log / replay |
| **Letta/MemGPT** (github.com/letta-ai/letta) | memory แบบแบ่งหน้าจอ ตัว agent แก้เองได้ | เจาะลึก memory |

---

## 5. งานถัดไปที่รออยู่

### Circuit 1 MVP — Failure→Rule playbook (ผู้ใช้อนุมัติแล้ว, ยังไม่ได้ implements)

- **ไฟล์:** `agent-events.jsonl` (event log append-only: run, ts, task, steps, tools, outcome, errors[], playbookDelta[]) + `agent_playbook.json` (กฎ + tag + จำนวนครั้งที่ใช้)
- **กลไก:** `logEvent()` เขียนเหตุการณ์; `sessionReflector` = LLM call **เดียว**ตอนจบ run สกัดเป็นกฎ+tag; `curator` = dedupe ด้วย string เปรียบเทียบ (ไม่ใช้ LLM) + bump usageCount; `loadPlaybookForTask` ฉีดกฎ ~10 ข้อที่จับกับงานได้ (~400 tok) ครั้งเดียวต่อ system prompt ของหัวหน้าเท่านั้น (subagent ไม่รับ)
- Guard: cap events 500 เส้น, dedupe กันบวม
- UI: `/api/playbook` + badge "playbook: N rules"; CLI flag `--playbook`
- **ตัวอย่างกฎแรกที่ต้องเกิดจากการล้มจริง:** "โดน 402 → ห้ามยิง `:online`, สลับไป web_fetch (raw.githubusercontent.com โอเค)" — tag: provider/402
- **ตรวจรับ:** (a) จำนวนบรรทัด event ตรงจริง, (b) รันล้มแล้วกฎถูกค้นเจอ, (c) dedupe ทำงาน, (d) UI แสดงจำนวน

### ต่อจากนั้น (คิวงานที่เคยคุย)

- Circuit 2: Need→Tool — ต่อเครื่องมือเองเมื่อขาด (แรงบันดาลใจ Alita/Voyager)
- Circuit 3: Task→Eval — checklist ตรวจงานต่อชนิดงาน
- Code Mode: tool ชุดเขียนโค้ด + verification gate

---

## 6. วิธีลุกใช้

```powershell
# วิธีรัน UI
node server.js           # → http://localhost:8787  (key โหลดจาก .openrouter_key อัตโนมัติ)

# วิธีรันผ่าน command line
node research-agent.js "โจทย์ของคุณที่นี่"

# ทดสอบ offline (ไม่ใช้เน็ต/เครดิต)
node test-mock.js         # 13 assert — agent loop + sub-agent + error recovery + sandbox + XSS
node test-server-mock.js  # 8 assert  — server + SSE + guard + Stop + ลำดับ tool
node test-smoke.js        # 5 assert  — HTTP surface จริง (boot server จริง, ไม่ยิง LLM)
```

---

## 7. ประวัติเวอร์ชัน (จากการคุยกัน)

1. **เริ่มต้น:** prototype agent (search + fetch + subagent) + อธิบายหลัก LLM/tools/loop
2. **โมเดลฟรี:** ตรวจแล้วสลับ default เป็น `nvidia/nemotron-3.5-super-vl:free` (ยืนยันแล้วว่าฟรี + รองรับ tools)
3. **Server + UI:** ขึ้น backend 8787 + SSE + หน้า UI แรก
4. **UI สไตล์ OpenCode:** sidebar sessions + activity card (คำขอ "ออกแบบเหมือน opencode ก็ได้")
5. **Activity → chips:** ยุบ activity การ์ดเป็นแถวไอคอน + กติกาใช้ subagent เฉพาะกรณีจำเป็น (คำขอ @114)
6. **จัดเต็ม / ประหยัด token** (คำขอ "เอาทุกอย่างที่ทำได้จริง ยัดลงไปเลย เน้นเรื่อง จัดการ token ให้ใช้น้อยที่สุด"): 10 tools + streaming + Stop + memory + sandbox js_eval + file/report + dedupe cache + token log + จัดการ session ใน UI
7. **ย้ายโปรเจค:** จาก `C:\Users\porchn\Documents\Default Project` มา **`D:\Github\thai-agentic`** (copy → verify → delete → ย้าย working dir → server กลับมาพร้อม compute ใหม่) — ปัจจุบัน `GET /` 200, `/api/models` 468 models
8. **Audit + แก้ 7 บั๊ก (2026-10-24):** sandbox จริง, XSS, `.gitignore`, test ที่ทำงานจริง, Stop ที่หยุดจริง, เลิก patch `console.log`, ลำดับ tool ถูกต้อง — รายละเอียดในหัวข้อ 3.1
9. **Circuit 1 — Playbook (2026-10-25):** agent เรียนกฎจาก run ที่ล้มเหลว — `agent-events.jsonl` (event log cap 500) + `agent_playbook.json` (กฎ tag/usageCount/lastSeen, cap 50, seed 3 กฎจาก incident จริง) + Reflector 1 LLM call เฉพาะ run ที่มี error + Curator dedupe code-only (token overlap ≥0.6 → bump usageCount) + inject ≤5 กฎ ~400 tok เฉพาะ orchestrator + `GET /api/playbook` + badge 📓 ใน UI (คลิกดูกฎได้) + CLI `node research-agent.js --playbook` + scrub secret ทุกจุด + test-playbook.js 15 asserts (all pass) + แก้ addRule bug (double-tok) — state ทั้งหมด isolation ผ่าน env `AGENT_EVENTS_FILE`/`AGENT_PLAYBOOK_FILE`; หมายเหตุ key: `:online` ใช้ได้เฉพาะคีย์ที่ซื้อ credit แล้วเท่านั้น (402 = เพดาน $50 ของ key free ไม่ใช่เงินจริง)
10. **Code Mode + แก้ 3 ปัญหาที่รีวิวเจอ (2026-10-25):** mode 💻 — `run_command` (บล็อกคำสั่งอันตราย) / `file_edit` (exact match + replace_all) / `file_grep` (regex+include) + **VERIFICATION GATE** (ห้ามบอกเสร็จถ้าไม่รันให้เห็นผลจริง) + research=10 tools / code=13 + test-codemode.js 12 asserts + test-smoke.js EADDRINUSE guard + UI chips นับครบ 10 tools + streaming render O(n²) fixes
11. **Circuit 2 — Skill Library + UI dev pass (2026-10-25):** agent สร้าง tool ใหม่ให้ตัวเองได้ — `tool_create` (เขียน + ทดสอบจริง `tools/<ชื่อ>.js`, ทดลอง run ก่อน register: ล้มหรือ stderr ไม่ JSON → ยกเลิก session ทันที โดยไม่รอคำยินยอม) + skills/index.json lib (cap 30) + ใช้ได้ทั้ง research/code mode + live spec injection กลับมากในช่วง run เดียวกัน + trait persist (test-tools.js 13 asserts, bad code ยกเลิก session correctly, C1+C2 synergy: playbook เรียน [tools] rule) + UI: skBadge 🧱 N, cblk md fence render, codeMode placeholder swap, `/api/skills` endpoint, chips 🧩 custom — ทำงานตามหลัง Alita/Voyager ย้ำพยายาม + Unifirst ข้อความ + UI ผนวก: suite ผ่าน 6 ไฟล์/74 asserts (mock13+codemode12+tools13+playbook15+servermock8+smoke5)
12. **SPARK — ตัวกระตุ้นของ 3 วงจร (2026-10-25, คำขอ "เอาตัวกระตุ้นที่ทำให้เกิดวงจรทั้ง 3 ไปด้วย"):** ฝัง mission ของ Compounding Agent เป็น `SPARK_RULES` ต่อท้าย system prompt ทุกโหมด (orchestrator เท่านั้น, ~140 tok) — "ทุก run ต้องทำให้ run ถัดไปดีกว่า" ผ่านแนว: (1) Failure→rule: อ่านกฎ playbook ที่ inject ก่อน (2) Need→tool: ความต้องการที่จะเจอซ้ำให้สร้างเป็น tool_create ครั้งเดียว (3) Task→reusable: ลงชื่อ pattern สำเร็จด้วย memory_save (เฉพาะแบบใช้ซ้ำได้จริง) + จูงใจจ่ายโทเค็นต่ำเพื่อให้วงจรคุ้มทุน — ผ่าน test ตระกูล mock ทั้ง 4 ไฟล์ (mock 13, codemode 12, tools 13, playbook 15)
13. **ขึ้น GitHub (2026-10-25):** ติดตั้ง Git 2.56 ผ่าน winget (ก่อนหน้าเครื่องไม่มี git) → init branch `main` → secret scan (`.openrouter_key` ไม่ถูก stage, ไม่มี `sk-or-v1-` ในไฟล์ที่ stage) → ลบไฟล์ probe ตกค้าง (probe-online.js, probe-pipeline.js) → commit `1173d6b` 14 ไฟล์ + commit `e4c89c2` README → push สู่ `https://github.com/porchn23/code-th-agent` สำเร็จ (GCM auth จาก Windows credential ที่อยู่แล้ว)
