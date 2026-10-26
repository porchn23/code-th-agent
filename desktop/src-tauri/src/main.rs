//! จุดเริ่มต้นของแอป (binary เล็ก — โหลด lib ที่เขียนเป็นโมดูล)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    thai_agentic_lib::run()
}
