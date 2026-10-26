//! CIRCUIT 1: PLAYBOOK — เก็บกฎจากความล้มเหลวของตัวเอง
//!
//! - `agent-events.jsonl`  = event log ต่อรัน (append-only, cap 500)
//! - `agent_playbook.json` = กฎที่เรียนรู้ได้ {rule, tag, usageCount, lastSeen}
//! - Reflector = 1 LLM call เฉพาะตอน run มี error → แปลงความผิดพลาดเป็นกฎ 1 บรรทัด
//! - Curator   = โค้ดล้วน (Jaccard ≥ 0.6 → bump usageCount) ไม่ใช้ LLM
//! - Injection = 5 กฎที่เกี่ยวกับงาน ~400 tok ใส่ system prompt (orchestrator เท่านั้น)

use crate::state::{Rule, Store};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const EVENTS_CAP: usize = 500;
pub const PLAYBOOK_CAP: usize = 50;
pub const RULE_CHARS: usize = 220;
pub const INJECT_BUDGET_TOK: u64 = 400;
pub const RULE_TAGS: &[&str] = &["web", "provider", "tools", "context", "model"];

static SECRET_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"sk-or-[A-Za-z0-9_-]+").expect("secret regex"));
static WS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]+").expect("ws regex"));
static TOKEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[a-z0-9]{3,}").expect("token regex"));

/// ซ่อน key ทุกจุด (ห้ามหลุดลง event/playbook)
pub fn scrub_secrets(s: &str) -> String {
    SECRET_RE.replace_all(s, "sk-or-***").to_string()
}

/// ทำความสะอาดกฎ: ตัด secret + ยุบช่องว่าง + ตัดความยาว
pub fn scrub_rule(s: &str) -> String {
    let scrubbed = scrub_secrets(s);
    let cleaned = WS_RE.replace_all(&scrubbed, " ");
    cleaned.trim().chars().take(RULE_CHARS).collect()
}

/// token สำหรับเทียบความคล้าย (lowercase, [a-z0-9]{3,})
fn tokens(s: &str) -> BTreeSet<String> {
    TOKEN_RE
        .find_iter(&s.to_lowercase())
        .map(|m| m.as_str().to_string())
        .collect()
}

/// Jaccard similarity ของ 2 ชุด token
pub fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    inter / (a.len() as f64 + b.len() as f64 - inter)
}

/// กฎตั้งต้น (เมื่อยังไม่มีไฟล์ playbook)
pub fn seed_rules() -> Vec<Rule> {
    let now = now_ms();
    let raw = [
        (
            "seed-402",
            "web",
            "If web_search returns HTTP 402 (insufficient credits), never retry the same web_search. Fallback: web_fetch stable sources directly (en.wikipedia.org, raw.githubusercontent.com) or tell the user the search backend has no credit.",
        ),
        (
            "seed-404",
            "web",
            "If web_fetch fails on guessed/made-up URLs twice in one run, stop guessing URL patterns — get real URLs from web_search results first.",
        ),
        (
            "seed-502",
            "provider",
            "HTTP 502/429 from the provider is already retried with backoff. After 3 consecutive failures stop and suggest the user switch model in the UI dropdown.",
        ),
    ];
    raw.iter()
        .map(|(id, tag, rule)| Rule {
            id: id.to_string(),
            tag: tag.to_string(),
            rule: rule.to_string(),
            usage_count: 1,
            last_seen: now,
            created: now,
        })
        .collect()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// โหลดกฎ (ถ้าไม่มีไฟล์ → seed)
pub fn load_playbook(store: &Store) -> Vec<Rule> {
    let file = store.load_playbook();
    if !file.rules.is_empty() {
        return file.rules;
    }
    let rules = seed_rules();
    let _ = store.save_playbook(&crate::state::PlaybookFile {
        rules: rules.clone(),
        cap: Some(PLAYBOOK_CAP),
    });
    rules
}

pub fn save_playbook(store: &Store, rules: &[Rule]) {
    let _ = store.save_playbook(&crate::state::PlaybookFile {
        rules: rules.to_vec(),
        cap: Some(PLAYBOOK_CAP),
    });
}

/// Curator — เพิ่มกฎใหม่ หรือ bump ถ้าซ้ำ (Jaccard ≥ 0.6)
/// คืน Some((bumped, rule)) หรือ None ถ้ากฎว่าง
pub fn add_rule(store: &Store, raw_text: &str, tag: &str) -> Option<(bool, Rule)> {
    let rule_text = scrub_rule(raw_text);
    if rule_text.is_empty() {
        return None;
    }
    let mut rules = load_playbook(store);
    let a = tokens(&rule_text);

    let found_idx = rules
        .iter()
        .position(|r| jaccard(&a, &tokens(&r.rule)) >= 0.6);

    let bumped = if let Some(i) = found_idx {
        rules[i].usage_count += 1;
        rules[i].last_seen = now_ms();
        if RULE_TAGS.contains(&tag) {
            rules[i].tag = tag.to_string();
        }
        true
    } else {
        rules.push(Rule {
            id: format!("r-{:x}{}", now_ms(), (now_ms() % 46_656).to_string()),
            rule: rule_text,
            tag: if RULE_TAGS.contains(&tag) {
                tag.to_string()
            } else {
                "tools".to_string()
            },
            usage_count: 1,
            last_seen: now_ms(),
            created: now_ms(),
        });
        if rules.len() > PLAYBOOK_CAP {
            // คงกฎที่ใช้บ่อย + ใหม่ไว้ (เหมือน JS)
            rules.sort_by(|x, y| {
                let xs = (x.usage_count as i64) * 1_000_000_000_000 + x.last_seen as i64;
                let ys = (y.usage_count as i64) * 1_000_000_000_000 + y.last_seen as i64;
                ys.cmp(&xs)
            });
            rules.truncate(PLAYBOOK_CAP);
        }
        false
    };

    save_playbook(store, &rules);
    let rule = if bumped {
        rules
            .iter()
            .find(|r| jaccard(&a, &tokens(&r.rule)) >= 0.6)
            .cloned()
            .unwrap_or_default()
    } else {
        rules.last().cloned().unwrap_or_default()
    };
    Some((bumped, rule))
}

/// เลือกกฎที่เกี่ยวกับงาน → ข้อความสำหรับ inject เข้า system prompt
/// (คะแนน = overlap×10 + min(usageCount,5) + ความสด 7 วัน, สูงสุด 5 กฎ, งบ ~400 tok)
pub fn load_playbook_for_task(store: &Store, task: &str) -> String {
    let rules = load_playbook(store);
    if rules.is_empty() {
        return String::new();
    }
    let t_words = tokens(task);
    let now = now_ms();
    let fresh_window = 7 * 86_400_000u64;

    let mut scored: Vec<(f64, &Rule)> = rules
        .iter()
        .map(|r| {
            let rw = tokens(&r.rule);
            let overlap = rw.intersection(&t_words).count() as f64;
            let fresh = if now.saturating_sub(r.last_seen) < fresh_window {
                1.0
            } else {
                0.0
            };
            let score = overlap * 10.0 + (r.usage_count.min(5) as f64) + fresh;
            (score, r)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut out = String::new();
    let mut n = 0usize;
    for (_, r) in scored.iter() {
        if n >= 5 {
            break;
        }
        let line = format!("- [{}] {}\n", r.tag, r.rule);
        if crate::agent::llm::est_tok(&(out.clone() + &line)) > INJECT_BUDGET_TOK {
            break;
        }
        out.push_str(&line);
        n += 1;
    }
    if n == 0 {
        return String::new();
    }
    format!("Learned rules from past failed runs (playbook) — follow these when relevant:\n{out}")
}

/// สรุป playbook + event ล่าสุด (สำหรับ UI)
pub fn playbook_summary(store: &Store) -> Value {
    let rules = load_playbook(store);
    let events = store.load_events();
    let recent: Vec<Value> = events
        .iter()
        .rev()
        .take(20)
        .map(|e| {
            json!({
                "runId": e.run_id,
                "ts": e.ts,
                "task": e.task,
                "steps": e.steps,
                "outcome": e.outcome,
                "errors": e.errors,
                "tok": e.tok,
                "model": e.model,
            })
        })
        .collect();
    json!({ "rules": rules, "events": recent })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_secrets() {
        assert_eq!(
            scrub_secrets("key is sk-or-v1-abc_DEF-123 ok"),
            "key is sk-or-*** ok"
        );
    }

    #[test]
    fn scrubs_rule_and_trims() {
        let long = "x".repeat(400);
        let r = scrub_rule(&long);
        assert_eq!(r.chars().count(), RULE_CHARS);
    }

    #[test]
    fn jaccard_dedupes_similar_rules() {
        let a = tokens("if web_search returns HTTP 402 never retry the same call");
        let b = tokens("if web_search returns HTTP 402 do not retry the same call");
        assert!(jaccard(&a, &b) >= 0.6);
    }

    #[test]
    fn jaccard_separates_different_rules() {
        let a = tokens("always run the tests before claiming done");
        let b = tokens("the weather in Bangkok is hot during April");
        assert!(jaccard(&a, &b) < 0.6);
    }
}
