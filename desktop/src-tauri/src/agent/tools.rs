//! เครื่องมือ (tools) — เป็นสเปก OpenAI function calling
//!
//! ⚠️ description คือสิ่งที่ทำให้โมเดล "เลือกถูก" — ต้องตรงกับ JS เดิมทุกตัวอักษร

use crate::state::SkillEntry;
use serde_json::{json, Value};

/// สร้าง tool spec รูปแบบ OpenAI
fn spec(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    let mut params = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        params
            .as_object_mut()
            .unwrap()
            .insert("required".to_string(), json!(required));
    }
    json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": params }
    })
}

/// tool ของโหมด research (ใช้ได้ทุกโหมด)
pub fn base_specs() -> Vec<Value> {
    vec![
        spec(
            "web_search",
            "Search the web. Use this FIRST before fetching. Returns titles, URLs and short summaries of top results. For finding sources on a topic.",
            json!({ "query": { "type": "string", "description": "Search query, English works best" } }),
            &["query"],
        ),
        spec(
            "web_fetch",
            "Fetch a webpage by URL and return its text content (truncated). Use after web_search to read a promising source in detail. Only http/https URLs.",
            json!({ "url": { "type": "string", "description": "Full URL starting with http:// or https://" } }),
            &["url"],
        ),
        spec(
            "get_datetime",
            "Get the current date/time and timezone. Cheap and instant — use it to judge how recent a source is before trusting it.",
            json!({}),
            &[],
        ),
        spec(
            "calculator",
            "Evaluate ONE math expression exactly (floating point). Supports + - * / % and ** (power), parentheses. ALWAYS use this for any arithmetic; never compute in your head.",
            json!({ "expression": { "type": "string", "description": "e.g. \"(1200 * 1.07) / 3\"" } }),
            &["expression"],
        ),
        spec(
            "js_eval",
            "Run short JavaScript offline in a hardened sandbox (hard limit 5s) and receive its console output. The sandbox has NO filesystem, NO network, NO require/process — only plain JS builtins (Math, JSON, Date, Array, Object, Map, Set, ...). Use for text processing, date math, unit conversion, JSON manipulation, quick simulations — anything beyond one-line arithmetic. Your code MUST console.log() the results.",
            json!({ "code": { "type": "string", "description": "JavaScript source. Only plain JS builtins — require/process/fs/network are NOT available. End with console.log(...)" } }),
            &["code"],
        ),
        spec(
            "file_write",
            "Save a text file (markdown/txt/json/csv) into the \"reports/\" folder of the project. Paths outside reports/ are rejected. Use it when the user asks to keep the full report or the note is too long for chat.",
            json!({
                "path": { "type": "string", "description": "relative path inside reports/, e.g. \"webgpu-2026.md\"" },
                "content": { "type": "string", "description": "Full file content" }
            }),
            &["path", "content"],
        ),
        spec(
            "file_read",
            "Read a small text file (md/txt/json/csv/js/html, max ~20k chars) from the project directory. Use to re-read reports/notes you (or the user) saved earlier.",
            json!({ "path": { "type": "string", "description": "Relative path, e.g. reports/webgpu-2026.md" } }),
            &["path"],
        ),
        spec(
            "memory_save",
            "Persist ONE important fact to long-term memory (survives across sessions). key = short unique label (e.g. 'user-birthday'), note = the fact itself. Replaces a note with the same key. Use sparingly — only genuinely useful facts the user gives you, never trivia.",
            json!({
                "key": { "type": "string", "description": "short unique label, e.g. 'user-name'" },
                "note": { "type": "string", "description": "the fact to remember" }
            }),
            &["key", "note"],
        ),
        spec(
            "memory_recall",
            "Search long-term memory by keywords (matches keys and contents). Check 'Known memory keys' in your instructions first — only call this when a key looks relevant to the current task.",
            json!({ "query": { "type": "string", "description": "keywords, e.g. 'user name'" } }),
            &["query"],
        ),
        spec(
            "research_subagent",
            "Delegate ONE focused research sub-topic to a fresh sub-agent that has its own clean context. Use SPARINGLY — only when the task clearly needs it: the question splits into 2+ truly independent subtopics (e.g. compare different platforms), or a source needs deep investigation that would flood the main context. For simple, focused questions, do NOT call this — research directly with web_search/web_fetch yourself. Returns only a short report; the sub-agent's step-by-step work is hidden.",
            json!({ "brief": { "type": "string", "description": "Self-contained research brief: sub-topic, what to find out, and any context the sub-agent needs (it cannot see the main conversation)" } }),
            &["brief"],
        ),
    ]
}

/// tool ของโหมด code (เพิ่มตอน mode == "code")
pub fn code_specs() -> Vec<Value> {
    vec![
        spec(
            "run_command",
            "Run a shell command in the project directory using the server process's full OS permissions. Available to admins only; command-pattern blocking is not an OS sandbox. Only use when the user explicitly asks for command execution or code verification. Returns stdout/stderr + exit code.",
            json!({
                "command": { "type": "string", "description": "Shell command to run, e.g. `node test-mock.js`" },
                "timeoutMs": { "type": "number", "description": "Optional timeout in ms, default 15000, max 60000" }
            }),
            &["command"],
        ),
        spec(
            "file_edit",
            "Edit a text file in the project by exact string replacement. oldString must match the file EXACTLY (including indentation) and be unique; if it matches multiple places provide more surrounding context or set replace_all:true. Prefer several small edits over rewriting whole files.",
            json!({
                "path": { "type": "string", "description": "File path relative to the project directory" },
                "oldString": { "type": "string", "description": "Exact text to find (must be unique in the file unless replace_all)" },
                "newString": { "type": "string", "description": "Replacement text (must differ from oldString)" },
                "replace_all": { "type": "boolean", "description": "Replace every occurrence of oldString" }
            }),
            &["path", "oldString", "newString"],
        ),
        spec(
            "file_grep",
            "Search all text files in the project (regex, case-insensitive by default) for a pattern — use INSTEAD of reading whole files to find where to edit. Returns path:line matches (max 60).",
            json!({
                "pattern": { "type": "string", "description": "Regular expression to search for" },
                "include": { "type": "string", "description": "Optional filename glob filter, e.g. *.js" }
            }),
            &["pattern"],
        ),
    ]
}

/// tool สร้าง tool ใหม่เอง (circuit 2) — admin only
pub fn tool_create_spec() -> Value {
    spec(
        "tool_create",
        "Create a NEW persistent custom tool from JS code you write, e.g. a specific API caller or data transform that none of your existing tools cover. The tool must read its arguments as JSON from process.argv[2] and print exactly ONE JSON object to stdout. It is test-run once with test_args before registration — broken tools are rejected and nothing is registered. Registered tools persist across runs and appear as extra functions ('[custom tool] ...'). Check your tools list first; do not rebuild what already exists.",
        json!({
            "name": { "type": "string", "description": "snake_case tool name, e.g. thai_lottery_check (must NOT collide with built-ins)" },
            "description": { "type": "string", "description": "What it does + when to use it (< 200 chars)" },
            "code": { "type": "string", "description": "Full JS source (Node), max 10000 chars" },
            "test_args": { "type": "object", "description": "Example args used for the mandatory test run" },
            "params": { "type": "object", "description": "Optional JSON-schema of its arguments (object type)" }
        }),
        &["name", "description", "code"],
    )
}

/// spec ของ tool ฝั่งแผน (save_plan / plan_done)
pub fn plan_specs() -> Vec<Value> {
    vec![
        spec(
            "save_plan",
            "PLAN MODE: record the execution plan after finishing your research. Call exactly once, then end with a short 'plan is ready for approval' message. Do NOT execute anything.",
            json!({
                "title": { "type": "string", "description": "Short plan title" },
                "steps": { "type": "array", "items": { "type": "string" }, "description": "Ordered steps (3-8), each concrete and checkable" }
            }),
            &["title", "steps"],
        ),
        spec(
            "plan_done",
            "Mark one step of the APPROVED plan as complete. Call right after finishing that step so the user sees live progress.",
            json!({ "step": { "type": "integer", "description": "Step number, 1-based" } }),
            &["step"],
        ),
    ]
}

/// ตัวเลือกของ get_tools
#[derive(Debug, Clone, Default)]
pub struct ToolOptions {
    /// โหมดแผน: เปิด tool save_plan
    pub save: bool,
    /// รันตามแผนที่อนุมัติแล้ว: เปิด tool plan_done
    pub done: bool,
    /// trusted = admin (หรือ AGENT_NO_AUTH=1) → เข้าถึง run_command / tool_create / custom tool
    pub trusted: bool,
    /// sub-agent ใช้ tool ชุดย่อ (อ่านอย่างเดียว)
    pub subagent: bool,
}

/// tool ที่ sub-agent ใช้ไม่ได้ (เหมือน SUBAGENT_EXCLUDE ใน JS)
const SUBAGENT_EXCLUDE: &[&str] = &[
    "research_subagent",
    "memory_save",
    "memory_recall",
    "file_write",
    "file_read",
    "js_eval",
];

/// รวม tool ทั้งหมดตามโหมด — เทียบ getTools ใน JS
pub fn get_tools(mode: &str, opts: &ToolOptions, skills: &[SkillEntry]) -> Vec<Value> {
    let mut out: Vec<Value> = if mode == "code" {
        let mut v = base_specs();
        v.extend(code_specs());
        v
    } else {
        base_specs()
    };

    if opts.subagent {
        out.retain(|t| {
            let n = t
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            !SUBAGENT_EXCLUDE.contains(&n)
        });
    }

    // run_command / tool_create / custom tool = admin only
    if !opts.trusted {
        out.retain(|t| {
            t.pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                != "run_command"
        });
        return out;
    }

    out.push(tool_create_spec());
    if opts.save {
        out.push(plan_specs()[0].clone());
    }
    if opts.done {
        out.push(plan_specs()[1].clone());
    }
    for s in skills {
        out.push(json!({
            "type": "function",
            "function": {
                "name": s.name,
                "description": format!("[custom tool] {}", s.description),
                "parameters": if s.params.get("type").and_then(|v| v.as_str()) == Some("object") {
                    s.params.clone()
                } else {
                    json!({ "type": "object", "properties": {} })
                }
            }
        }));
    }
    out
}

/// ชื่อ tool ที่ built-in ทั้งหมด — ใช้กันชนกับ custom tool
pub fn built_in_names() -> Vec<String> {
    let mut names: Vec<String> = base_specs()
        .iter()
        .chain(code_specs().iter())
        .filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .collect();
    names.push("tool_create".to_string());
    names.push("save_plan".to_string());
    names.push("plan_done".to_string());
    names
}

/// regex ชื่อ tool ที่อนุญาต (เหมือน TOOL_NAME_RE ใน JS)
pub fn valid_tool_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.len() < 3 || bytes.len() > 30 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_valid() {
        for t in base_specs().into_iter().chain(code_specs()) {
            let n = t.pointer("/function/name").unwrap().as_str().unwrap();
            assert!(valid_tool_name(n), "{n} invalid");
        }
    }

    #[test]
    fn untrusted_hides_run_command() {
        let opts = ToolOptions {
            trusted: false,
            ..Default::default()
        };
        let tools = get_tools("code", &opts, &[]);
        assert!(!tools
            .iter()
            .any(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some("run_command")));
        assert!(!tools
            .iter()
            .any(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some("tool_create")));
    }

    #[test]
    fn trusted_gets_tool_create_and_plan_tools() {
        let opts = ToolOptions {
            trusted: true,
            save: true,
            done: true,
            ..Default::default()
        };
        let tools = get_tools("code", &opts, &[]);
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str()))
            .collect();
        assert!(names.contains(&"tool_create"));
        assert!(names.contains(&"save_plan"));
        assert!(names.contains(&"plan_done"));
        assert!(names.contains(&"run_command"));
    }

    #[test]
    fn subagent_loses_write_tools() {
        let opts = ToolOptions {
            trusted: true,
            subagent: true,
            ..Default::default()
        };
        let tools = get_tools("research", &opts, &[]);
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str()))
            .collect();
        assert!(!names.contains(&"file_write"));
        assert!(!names.contains(&"memory_save"));
        assert!(names.contains(&"web_search"));
    }

    #[test]
    fn tool_name_regex_behaves_like_js() {
        assert!(valid_tool_name("thai_lottery_check"));
        assert!(!valid_tool_name("ab")); // สั้นเกิน
        assert!(!valid_tool_name("Thai_tool")); // ขึ้นต้นด้วยตัวใหญ่
        assert!(!valid_tool_name("tool-with-dash"));
        assert!(!valid_tool_name("1tool"));
    }
}
