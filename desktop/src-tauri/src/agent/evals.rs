//! CIRCUIT 3: EVALS — งานที่สำเร็จ → checklist ใช้ซ้ำ
//!
//! งานสำเร็จ (outcome ok + ≥3 steps + ใช้ tool) → Eval curator (1 LLM call) →
//! `agent_evals.json` (cap 20, dedupe Jaccard ≥ 0.5 → bump usage) →
//! งานคล้ายกันถัดไปได้ "จุดเริ่ม/สิ่งที่ต้องตรวจ" ฟรีใน system prompt (~300 tok)

use crate::state::{EvalEntry, Store};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const EVALS_CAP: usize = 20;
pub const EVAL_INJECT_TOK: u64 = 300;

static WORD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[a-zA-Z0-9\u{0E00}-\u{0E7F}]{2,}").expect("word regex"));

/// แตกคำจากภาษาไทย+อังกฤษ (ทุก token ยาวเกิน 2) → เช็คความคล้ายของงาน
pub fn task_words(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in WORD_RE.find_iter(s) {
        let w = m.as_str().to_lowercase();
        if !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// Jaccard ของ 2 อาร์เรย์คำ (ใช้ dedupe checklist ซ้ำ — โค้ดเท่านั้น ไม่ใช่ LLM)
pub fn jac(a: &[String], b: &[String]) -> f64 {
    let a: BTreeSet<&String> = a.iter().collect();
    let b: BTreeSet<&String> = b.iter().collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let n = a.intersection(&b).count() as f64;
    n / (a.len() as f64 + b.len() as f64 - n)
}

pub fn load_evals(store: &Store) -> Vec<EvalEntry> {
    store.load_evals()
}

pub fn save_evals(store: &Store, list: &[EvalEntry]) {
    let _ = store.save_evals(list);
}

/// เพิ่ม checklist (หรือ bump ถ้าคล้าย) → (bumped, entry)
pub fn add_eval(store: &Store, raw_keywords: &[String], raw_check: &[String]) -> (bool, EvalEntry) {
    let joined = raw_keywords.join(" ");
    let mut keywords: Vec<String> = task_words(&joined);
    keywords.dedup();
    keywords.truncate(6);

    let mut check: Vec<String> = raw_check
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    check.truncate(3);
    for s in check.iter_mut() {
        *s = s.chars().take(80).collect();
    }

    let mut list = load_evals(store);
    if let Some(found) = list.iter_mut().find(|e| jac(&keywords, &e.keywords) >= 0.5) {
        found.usage_count += 1;
        found.last_seen = super::playbook::now_ms();
        let entry = found.clone();
        save_evals(store, &list);
        return (true, entry);
    }

    let entry = EvalEntry {
        id: format!(
            "e-{:x}{}",
            super::playbook::now_ms(),
            (super::playbook::now_ms() % 46_656)
        ),
        keywords,
        check,
        usage_count: 1,
        last_seen: super::playbook::now_ms(),
    };
    list.push(entry.clone());
    if list.len() > EVALS_CAP {
        list.sort_by(|a, b| {
            let as_ = (a.usage_count as i64) * 1_000_000_000_000 + a.last_seen as i64;
            let bs = (b.usage_count as i64) * 1_000_000_000_000 + b.last_seen as i64;
            bs.cmp(&as_)
        });
        list.truncate(EVALS_CAP);
    }
    save_evals(store, &list);
    (false, entry)
}

/// เลือก eval ที่ "งานคล้ายกัน" (intersection ของคำ × 10 + usage) → ข้อความ inject
pub fn load_evals_for_task(store: &Store, task: &str) -> String {
    let ws = task_words(task);
    let all = load_evals(store);
    let mut scored: Vec<(f64, &EvalEntry)> = all
        .iter()
        .map(|e| {
            let inter = e.keywords.iter().filter(|k| ws.contains(k)).count() as f64;
            if inter == 0.0 {
                (0.0, e)
            } else {
                (inter * 10.0 + e.usage_count.min(5) as f64, e)
            }
        })
        .filter(|(s, _)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut lines: Vec<String> = Vec::new();
    for (_, e) in scored.iter().take(3) {
        let line = format!(
            "- When done: {} (task type: {})",
            e.check.join("; "),
            e.keywords.join(", ")
        );
        let probe = format!("{}\n{}", lines.join("\n"), line);
        if super::llm::est_tok(&probe) > EVAL_INJECT_TOK {
            break;
        }
        lines.push(line);
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\nEval hints (how similar past tasks were verified):\n{}",
        lines.join("\n")
    )
}

/// สรุป KPI: จำนวน run ที่สำเร็จ + เฉลี่ย token ต่อ run
pub fn eval_summary(store: &Store) -> Value {
    let events = store.load_events();
    let mut ok = 0u64;
    let mut total_tok = 0u64;
    for e in &events {
        if e.outcome == "ok" {
            ok += 1;
            total_tok += e.tok;
        }
    }
    let avg = if ok > 0 { (total_tok / ok) as u64 } else { 0 };
    let evals: Vec<Value> = load_evals(store)
        .iter()
        .map(|e| {
            json!({
                "keywords": e.keywords,
                "check": e.check,
                "usageCount": e.usage_count,
                "lastSeen": e.last_seen,
            })
        })
        .collect();
    json!({ "evals": evals, "runs": { "ok": ok, "avgTok": avg } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_thai_and_english_words() {
        let w = task_words("ทดสอบ Rust API ใหม่");
        assert!(w.contains(&"ทดสอบ".to_string()));
        assert!(w.contains(&"rust".to_string()));
        assert!(w.contains(&"api".to_string()));
    }

    #[test]
    fn drops_single_char_words() {
        let w = task_words("a bb ccc");
        assert_eq!(w, vec!["bb".to_string(), "ccc".to_string()]);
    }

    #[test]
    fn jaccard_dedupes_similar_keywords() {
        let a = task_words("ระบบสมัครสมาชิกล็อกอิน");
        let b = task_words("ระบบสมัครสมาชิก login");
        assert!(jac(&a, &b) >= 0.5);
    }
}
