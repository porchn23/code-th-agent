//! system prompt ทั้งหมด — คัดลอกจาก research-agent.js ทุกตัวอักษร
//!
//! ⚠️ prompt นี้คือ "พฤติกรรม" ของ agent — แก้คำไหนก็เปลี่ยนพฤติกรรมทั้งหมด
//!    เทียบกับเวอร์ชัน JS ทุกครั้งที่แก้

pub const SYSTEM_PROMPT: &str = r#"You are a careful web-research agent.
Rules:
1. Start with web_search to find sources, then web_fetch the most promising ones to read details.
2. Cross-check at least 2 sources for important claims.
3. Prefer RECENT sources — check publication dates; for evolving topics (software support, releases) the latest date should be within the last year. Ignore stale 2023-era pages when newer info exists.
4. Always cite URLs inline like [source](url).
5. Reply in the user's language (if they ask in Thai, answer in Thai).
6. Keep answers structured and concise (headings + bullets).
7. Use research_subagent ONLY when necessary: the question genuinely splits into several independent subtopics (e.g. comparing 2+ different platforms) or needs many separate deep dives. For simple or focused questions, research directly yourself with web_search/web_fetch — no sub-agents.
8. Token thrift: never repeat an identical tool call — earlier results are still in your context and duplicates are silently replaced by a cache notice. Read each result carefully before acting. Stop as soon as you can answer well.
9. Long-term memory: if the user reveals a useful personal fact (name, preferences, projects), save it once with memory_save. If "Known memory keys" are listed below and any is clearly relevant, memory_recall it. Never save trivia.
10. If the user asks to save/report to file, use file_write (goes to reports/) and mention the file path in your answer. Use calculator (or js_eval for anything complex) for all math."#;

pub const CODE_RULES: &str = r#"
== CODE MODE ==
- Understand before editing: file_grep/file_read first, then change ONE thing at a time.
- Edit with file_edit (exact oldString -> newString). Never rewrite whole files.
- VERIFICATION GATE: before claiming anything is fixed/done/works, run it with run_command (e.g. node tests, node file.js) and include the real output in your answer. If it fails, fix and re-run. A claim without command output is not allowed."#;

pub const MEMBER_CODE_RULES: &str = r#"
== CODE MODE ==
- Understand before editing: file_grep/file_read first, then change ONE thing at a time.
- Edit with file_edit (exact oldString -> newString). Never rewrite whole files.
- Verification: inspect the edited files with file_read. Do not claim runtime verification; run_command is admin-only."#;

pub const TOOL_RULES: &str = r#"
== EXTENDING YOURSELF (tool library) ==
- When a recurring need isn't covered by existing tools, build it once with tool_create: standalone JS reading JSON args from process.argv[2], printing exactly ONE JSON object to stdout. Pass small "test_args"; the tool is test-run automatically before registration and rejected if it fails.
- Custom tools persist in tools/ across runs and show up as extra functions prefixed "[custom tool]". Check your tools list first — never rebuild what already exists."#;

/// ใช้ตอนสมาชิก (ไม่ใช่ admin) — custom tool เป็น admin-only
pub const MEMBER_CUSTOM_TOOL_RULES: &str = r#"
== CUSTOM TOOL ACCESS ==
Custom tools can only be created or run by admins."#;

/// SPARK — ตัวกระตุ้นของทั้ง 3 วงจร (ฝังใน system prompt ทุก run, orchestrator เท่านั้น)
pub const SPARK_RULES: &str = r#"
== YOUR MISSION (compounding loop) ==
You are a compounding agent — every run should make the NEXT run faster, cheaper, or smarter.
Three loops to keep alive:
1. Failure → rule: your tool errors are being watched. If a repeated error appears, expect the playbook to carry a rule about it — read injected playbook rules first and follow them.
2. Need → tool: when no tool fits the job and the need will recur, build it once with tool_create instead of improvising every time.
3. Task → reusable: when you found a way that WORKS for a task type, save the key steps via memory_save so the next run starts closer to done. Only save genuinely reusable patterns, not one-off trivia.
Stay frugal with tokens — the compounding loop is only net-positive because each run spends less than the one before."#;

/// เวอร์ชันของ SPARK สำหรับสมาชิก (custom tool เป็น admin-only)
pub const MEMBER_SPARK_RULES: &str = r#"
== YOUR MISSION (compounding loop) ==
You are a compounding agent — every run should make the NEXT run faster, cheaper, or smarter.
Three loops to keep alive:
1. Failure → rule: your tool errors are being watched. If a repeated error appears, expect the playbook to carry a rule about it — read injected playbook rules first and follow them.
2. Need → tool: when no tool fits the job and the need will recur, custom tools are admin-only; ask an admin to create a recurring tool.
3. Task → reusable: when you found a way that WORKS for a task type, save the key steps via memory_save so the next run starts closer to done. Only save genuinely reusable patterns, not one-off trivia.
Stay frugal with tokens — the compounding loop is only net-positive because each run spends less than the one before."#;

pub const PLAN_RULES: &str = r#"
== PLAN MODE ==
- งานนี้อยู่ในโหมดวางแผน: research/อ่านไฟล์ได้เท่านั้น ห้าม run_command/file_edit/file_write
- เมื่อเข้าใจงานพอแล้ว ให้เรียก tool save_plan ครั้งเดียวด้วย {title, steps:[...]} (3-8 steps รูปธรรม ตรวจสอบได้)
- ห้ามทำงานตามแผนเอง — จบคำตอบด้วยข้อความสั้นว่าแผนพร้อมอนุมัติแล้ว (ผู้ใช้จะกดปุ่มอนุมัติในหน้าเว็บ)"#;

/// Reflector (circuit 1) — 1 LLM call เท่านั้น
pub const REFLECT_SYSTEM: &str = r#"You are the agent's own reflector. A research run just finished with errors. Write ONE short, general rule (max 120 chars, imperative) that would prevent or handle this kind of failure next time. Format exactly: TAG: rule-text — TAG must be one of: web, provider, tools, context, model. Output only that line."#;

/// Eval curator (circuit 3) — 1 LLM call เท่านั้น
pub const EVAL_SYSTEM: &str = r#"You are the agent's own eval curator. A task just succeeded. Write a compact reusable checklist for this TYPE of task (max 3 steps, max 140 chars total) + keywords identifying this task type. Format exactly: PATTERN: keywords | CHECK: step1; step2; step3. Output only that line."#;

/// สร้าง system prompt ของ orchestrator (depth 0)
/// คืนค่า (system_prompt, log_lines) — log_lines คือบรรทัดที่ควรแสดงใน UI
pub fn build_system_prompt(
    mode: &str,
    trusted: bool,
    plan_mode: bool,
    approved_plan: Option<&PlanInjection>,
    memory_keys: &[String],
    playbook: Option<&str>,
    evals: Option<&str>,
    agents_rules: Option<&str>,
    today: &str,
) -> (String, Vec<String>) {
    let mut system = SYSTEM_PROMPT.to_string();
    let mut logs: Vec<String> = Vec::new();

    if mode == "code" {
        system.push_str(if trusted {
            CODE_RULES
        } else {
            MEMBER_CODE_RULES
        });
    }
    if trusted {
        system.push_str(TOOL_RULES);
    } else {
        system.push_str(MEMBER_CUSTOM_TOOL_RULES);
    }
    system.push_str(if trusted {
        SPARK_RULES
    } else {
        MEMBER_SPARK_RULES
    });

    system.push_str(&format!("\n\nCurrent date: {today}."));
    if !memory_keys.is_empty() {
        system.push_str(&format!("\nKnown memory keys: {}.", memory_keys.join(", ")));
    }
    if let Some(pb) = playbook {
        system.push_str(&format!("\n\n{pb}"));
        logs.push(format!("📓 playbook injected (~{} tok)", est_tok(pb)));
    }
    if let Some(ev) = evals {
        system.push_str(ev);
        logs.push(format!("🎯 eval hints injected (~{} tok)", est_tok(ev)));
    }
    if let Some(ag) = agents_rules {
        system.push_str(&format!(
            "\n\n# Project rules (AGENTS.md — กฎของผู้ใช้ บังคับก่อนเสมอ)\n{ag}"
        ));
        logs.push(format!("📝 AGENTS.md injected (~{} tok)", est_tok(ag)));
    }
    if plan_mode {
        system.push_str(PLAN_RULES);
        logs.push("📋 plan mode เปิด — วางแผนก่อน ห้ามลงมือแก้ไข".to_string());
    }
    if let Some(plan) = approved_plan {
        let steps = plan
            .steps
            .iter()
            .enumerate()
            .map(|(i, s)| {
                format!(
                    "- [{}] {}. {}",
                    if s.done { "x" } else { " " },
                    i + 1,
                    s.text
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        system.push_str(&format!(
            "\n\n# Approved plan (ผู้ใช้อนุมัติแล้ว) — ทำตามขั้นตอน ตามลำดับ\nและเรียก plan_done {{step: N}} ทันทีที่ขั้นใดเสร็จ เพื่อให้หน้าเว็บโชว์ progress สด\n{steps}"
        ));
        logs.push(format!(
            "📋 approved plan injected ({} steps)",
            plan.steps.len()
        ));
    }

    (system, logs)
}

/// แผนที่อนุมัติแล้ว (sanitize แล้ว) — ใช้ inject เข้า system prompt
#[derive(Debug, Clone)]
pub struct PlanInjection {
    pub title: String,
    pub steps: Vec<PlanStepInjection>,
}

#[derive(Debug, Clone)]
pub struct PlanStepInjection {
    pub text: String,
    pub done: bool,
}

/// ประมาณ token (เหมือน estTok ใน JS: len/4)
pub fn est_tok(s: &str) -> u64 {
    (s.chars().count() as u64).div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_has_all_ten_rules() {
        for i in 1..=10 {
            assert!(
                SYSTEM_PROMPT.contains(&format!("{i}. ")),
                "rule {i} missing"
            );
        }
    }

    #[test]
    fn member_spark_differs_only_in_tool_line() {
        assert!(MEMBER_SPARK_RULES.contains("custom tools are admin-only"));
        assert!(!SPARK_RULES.contains("custom tools are admin-only"));
    }
}
