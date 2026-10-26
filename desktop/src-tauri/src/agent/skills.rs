//! CIRCUIT 2: SKILL LIBRARY — tool ที่ agent สร้างเอง แล้วใช้ซ้ำข้ามรอบ
//!
//! `skills/index.json` = ทะเบียน persist (cap 30) · ไฟล์ tool อยู่ใน `tools/<name>.js`
//! ตัว tool ต้องเป็น JS ที่รันเป็น child process (อ่าน JSON args จาก argv[2] → พิมพ์ 1 JSON object)

use crate::agent::tools::valid_tool_name;
use crate::state::{SkillEntry, Store};

pub const SKILLS_CAP: usize = 30;

pub fn load_skills(store: &Store) -> Vec<SkillEntry> {
    store
        .load_skills()
        .into_iter()
        .filter(|s| !s.name.is_empty() && valid_tool_name(&s.name))
        .collect()
}

/// upsert + cap (ตัวออก = calls น้อยสุด/เก่าสุด) — กันทะเบียนบวมเหมือน playbook
pub fn save_skill(store: &Store, entry: SkillEntry) {
    let mut list = load_skills(store);
    match list.iter_mut().find(|s| s.name == entry.name) {
        Some(slot) => *slot = entry,
        None => list.push(entry),
    }
    if list.len() > SKILLS_CAP {
        list.sort_by(|a, b| b.calls.cmp(&a.calls).then(b.last_used.cmp(&a.last_used)));
        list.truncate(SKILLS_CAP);
    }
    let _ = store.save_skills(&list);
}

/// บันทึกว่า tool ถูกเรียกใช้ (นับครั้ง + เวลาล่าสุด)
pub fn bump_usage(store: &Store, name: &str) {
    let mut list = load_skills(store);
    if let Some(s) = list.iter_mut().find(|s| s.name == name) {
        s.calls += 1;
        s.last_used = super::playbook::now_ms();
        let _ = store.save_skills(&list);
    }
}

/// มี tool นี้อยู่ในทะเบียนไหม
pub fn has_skill(store: &Store, name: &str) -> bool {
    load_skills(store).iter().any(|s| s.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_invalid_names() {
        assert!(valid_tool_name("my_tool"));
        assert!(!valid_tool_name("My-Tool"));
        assert!(!valid_tool_name("ab"));
    }
}
