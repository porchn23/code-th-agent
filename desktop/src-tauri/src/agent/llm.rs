//! LLM client — คุยกับ OpenRouter (JSON ปกติ + SSE streaming)
//! เทียบ research-agent.js: callLLM / callLLMStream / makeSSEAccumulator

use crate::config::Config;
use crate::error::{AppError, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ---------------------------------------------------------------------
// รูปแบบข้อความที่โมเดลตอบ
// ---------------------------------------------------------------------
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmMessage {
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "fn_kind")]
    pub kind: String,
    pub function: ToolCallFn,
}

fn fn_kind() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFn {
    pub name: String,
    /// JSON string (ตามสเปก OpenAI function calling)
    pub arguments: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
}

// ---------------------------------------------------------------------
// error แยกชนิด: Fatal = ไม่ต้อง retry (401/403/402/4xx) · Transient = retry ได้ (429/5xx)
// ---------------------------------------------------------------------
#[derive(Debug)]
enum LlmError {
    Fatal(String),
    Transient(String),
}

impl LlmError {
    fn message(&self) -> &str {
        match self {
            LlmError::Fatal(m) | LlmError::Transient(m) => m,
        }
    }
    fn is_fatal(&self) -> bool {
        matches!(self, LlmError::Fatal(_))
    }
}

impl From<LlmError> for AppError {
    fn from(e: LlmError) -> Self {
        AppError::msg(e.message().to_string())
    }
}

/// ตัดข้อความแบบไม่ตัดกลางตัวอักษร (UTF-8 safe)
pub fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

// ---------------------------------------------------------------------
// client
// ---------------------------------------------------------------------
pub struct LlmClient {
    http: reqwest::Client,
}

impl Default for LlmClient {
    fn default() -> Self {
        Self::new()
    }
}

impl LlmClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent("thai-agentic/0.1 (Rust)")
            .build()
            .unwrap_or_default();
        LlmClient { http }
    }

    /// ส่ง request + retry (ชั้นเดียวกับ sendRequest+callLLM ใน JS)
    async fn send(
        &self,
        cfg: &Config,
        body: &Value,
        signal: &Arc<AtomicBool>,
    ) -> std::result::Result<reqwest::Response, LlmError> {
        let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
        let key = cfg.api_key.clone().unwrap_or_default();
        let retries = 4usize;

        for attempt in 1..=retries {
            if signal.load(Ordering::Relaxed) {
                return Err(LlmError::Fatal("aborted".to_string()));
            }

            let result = self
                .http
                .post(&url)
                .bearer_auth(&key)
                .json(body)
                .timeout(Duration::from_secs(60))
                .send()
                .await;

            match result {
                Err(e) => {
                    if attempt == retries {
                        return Err(LlmError::Transient(format!("network error: {e}")));
                    }
                    sleep_ms(1000 * 2u64.pow(attempt as u32 - 1)).await;
                }
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status == 401 || status == 403 {
                        let t = res.text().await.unwrap_or_default();
                        return Err(LlmError::Fatal(format!(
                            "Auth failed (HTTP {status}): {}",
                            clip(&t, 200)
                        )));
                    }
                    if status == 429 || status >= 500 {
                        let t = res.text().await.unwrap_or_default();
                        let msg = format!("Transient HTTP {status}: {}", clip(&t, 200));
                        if attempt == retries {
                            return Err(LlmError::Transient(msg));
                        }
                        sleep_ms(1000 * 2u64.pow(attempt as u32 - 1)).await;
                        continue;
                    }
                    if !res.status().is_success() {
                        let t = res.text().await.unwrap_or_default();
                        return Err(LlmError::Fatal(format!("HTTP {status}: {}", clip(&t, 300))));
                    }
                    return Ok(res);
                }
            }
        }
        Err(LlmError::Transient("retries exhausted".to_string()))
    }

    /// เรียกแบบไม่ stream → คืน message
    pub async fn call(
        &self,
        cfg: &Config,
        body: &Value,
        signal: &Arc<AtomicBool>,
        on_retry: &mut dyn FnMut(&str),
    ) -> Result<LlmMessage> {
        let mut attempt = 1usize;
        loop {
            match self.send(cfg, body, signal).await {
                Ok(res) => {
                    let data: Value = res.json().await?;
                    let msg = data
                        .pointer("/choices/0/message")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    let usage = data.get("usage").and_then(|u| {
                        Some(Usage {
                            prompt_tokens: u
                                .get("prompt_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                            completion_tokens: u
                                .get("completion_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                        })
                    });
                    let mut out = parse_message(&msg);
                    out.usage = usage;
                    return Ok(out);
                }
                Err(e) => {
                    if signal.load(Ordering::Relaxed) {
                        return Err(e.into());
                    }
                    if e.is_fatal() || attempt >= 4 {
                        return Err(e.into());
                    }
                    let wait = 1000u64 * 2u64.pow(attempt as u32 - 1);
                    on_retry(&format!(
                        "  (attempt {attempt} failed: {} — retrying in {wait}ms)",
                        e.message()
                    ));
                    sleep_ms(wait).await;
                    attempt += 1;
                }
            }
        }
    }

    /// เรียกแบบ stream — ปล่อย delta ทีละก้อนให้ UI
    pub async fn call_stream(
        &self,
        cfg: &Config,
        body: &Value,
        signal: &Arc<AtomicBool>,
        on_delta: &mut dyn FnMut(Option<&str>),
        on_retry: &mut dyn FnMut(&str),
    ) -> Result<LlmMessage> {
        let mut attempt = 1usize;
        loop {
            let mut emitted = false;
            let res = match self.send(cfg, &with_stream(body, true), signal).await {
                Ok(r) => r,
                Err(e) => {
                    if emitted {
                        on_delta(None);
                    }
                    if signal.load(Ordering::Relaxed) || e.is_fatal() || attempt >= 4 {
                        return Err(e.into());
                    }
                    let wait = 1000u64 * 2u64.pow(attempt as u32 - 1);
                    on_retry(&format!(
                        "  (attempt {attempt} failed: {} — retrying in {wait}ms)",
                        e.message()
                    ));
                    sleep_ms(wait).await;
                    attempt += 1;
                    continue;
                }
            };

            let mut acc = SseAccumulator::default();
            let mut stream = res.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let mut failed: Option<String> = None;

            while let Some(chunk) = stream.next().await {
                if signal.load(Ordering::Relaxed) {
                    failed = Some("aborted".to_string());
                    break;
                }
                match chunk {
                    Ok(bytes) => {
                        buf.extend_from_slice(&bytes);
                        // แปลงเป็น string แล้วแยกบรรทัด (SSE ขึ้นบรรทัดด้วย \n)
                        let text = String::from_utf8_lossy(&buf).to_string();
                        let mut rest = text;
                        while let Some(idx) = rest.find('\n') {
                            let line = rest[..idx].to_string();
                            rest = rest[idx + 1..].to_string();
                            if acc.feed(&line, on_delta, &mut emitted) {
                                // จบแล้ว
                            }
                        }
                        // เก็บ tail ที่ยังไม่ครบบรรทัดไว้รอบหน้า
                        let keep = rest.len();
                        buf = rest.into_bytes();
                        let _ = keep;
                    }
                    Err(e) => {
                        failed = Some(e.to_string());
                        break;
                    }
                }
            }

            if let Some(err) = failed {
                if emitted {
                    on_delta(None);
                }
                if signal.load(Ordering::Relaxed) {
                    return Err(AppError::msg("aborted"));
                }
                if attempt >= 4 {
                    return Err(AppError::msg(format!("stream failed: {err}")));
                }
                let wait = 1000u64 * 2u64.pow(attempt as u32 - 1);
                on_retry(&format!(
                    "  (attempt {attempt} failed: {err} — retrying in {wait}ms)"
                ));
                sleep_ms(wait).await;
                attempt += 1;
                continue;
            }

            let mut msg = acc.message();
            if let Some(u) = acc.usage {
                msg.usage = Some(u);
            }
            return Ok(msg);
        }
    }
}

fn with_stream(body: &Value, stream: bool) -> Value {
    let mut b = body.clone();
    if let Some(obj) = b.as_object_mut() {
        obj.insert("stream".to_string(), Value::Bool(stream));
    }
    b
}

/// แปลง message ที่ provider ส่งมา → LlmMessage
pub fn parse_message(msg: &Value) -> LlmMessage {
    let content = msg
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut tool_calls = Vec::new();
    if let Some(arr) = msg.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in arr {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let name = tc
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let arguments = tc
                .pointer("/function/arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("{}")
                .to_string();
            tool_calls.push(ToolCall {
                id,
                kind: "function".to_string(),
                function: ToolCallFn { name, arguments },
            });
        }
    }

    LlmMessage {
        content,
        tool_calls,
        usage: None,
    }
}

// ---------------------------------------------------------------------
// SSE accumulator — เทียบ makeSSEAccumulator ใน JS
// ---------------------------------------------------------------------
#[derive(Default)]
struct ToolCallAcc {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct SseAccumulator {
    content: String,
    usage: Option<Usage>,
    tool_calls: std::collections::BTreeMap<u64, ToolCallAcc>,
}

impl SseAccumulator {
    /// กินบรรทัด SSE หนึ่งบรรทัด — คืน true ถ้าเป็น [DONE]
    fn feed(
        &mut self,
        line: &str,
        on_delta: &mut dyn FnMut(Option<&str>),
        emitted: &mut bool,
    ) -> bool {
        let line = line.trim();
        if !line.starts_with("data:") {
            return false;
        }
        let payload = line[5..].trim();
        if payload.is_empty() || payload == "[DONE]" {
            return payload == "[DONE]";
        }
        let ev: Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return false,
        };

        if let Some(content) = ev
            .pointer("/choices/0/delta/content")
            .and_then(|v| v.as_str())
        {
            if !content.is_empty() {
                self.content.push_str(content);
                *emitted = true;
                on_delta(Some(content));
            }
        }

        if let Some(arr) = ev
            .pointer("/choices/0/delta/tool_calls")
            .and_then(|v| v.as_array())
        {
            for tc in arr {
                let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                let entry = self.tool_calls.entry(idx).or_insert_with(|| ToolCallAcc {
                    id: format!("call_{idx}"),
                    name: String::new(),
                    arguments: String::new(),
                });
                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        entry.id = id.to_string();
                    }
                }
                if let Some(n) = tc.pointer("/function/name").and_then(|v| v.as_str()) {
                    entry.name.push_str(n);
                }
                if let Some(a) = tc.pointer("/function/arguments").and_then(|v| v.as_str()) {
                    entry.arguments.push_str(a);
                }
            }
        }

        if let Some(u) = ev.get("usage") {
            if !u.is_null() {
                self.usage = Some(Usage {
                    prompt_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    completion_tokens: u
                        .get("completion_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                });
            }
        }
        false
    }

    fn message(&self) -> LlmMessage {
        let tool_calls = self
            .tool_calls
            .iter()
            .map(|(_, t)| ToolCall {
                id: t.id.clone(),
                kind: "function".to_string(),
                function: ToolCallFn {
                    name: t.name.clone(),
                    arguments: t.arguments.clone(),
                },
            })
            .collect();
        LlmMessage {
            content: self.content.clone(),
            tool_calls,
            usage: None,
        }
    }
}

// ---------------------------------------------------------------------
// ประมาณจำนวน token (heuristic เดียวกับ JS: len/4)
// ---------------------------------------------------------------------
pub fn est_tok(s: &str) -> u64 {
    (s.chars().count() as u64).div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_calls() {
        let msg = serde_json::json!({
            "content": "hi",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": { "name": "web_search", "arguments": "{\"query\":\"x\"}" }
            }]
        });
        let out = parse_message(&msg);
        assert_eq!(out.content, "hi");
        assert_eq!(out.tool_calls.len(), 1);
        assert_eq!(out.tool_calls[0].function.name, "web_search");
    }

    #[test]
    fn sse_accumulator_collects_deltas() {
        let mut acc = SseAccumulator::default();
        let mut emitted = false;
        let mut seen: Vec<String> = Vec::new();
        let mut cb = |t: Option<&str>| {
            if let Some(t) = t {
                seen.push(t.to_string());
            }
        };
        acc.feed(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}",
            &mut cb,
            &mut emitted,
        );
        acc.feed(
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}",
            &mut cb,
            &mut emitted,
        );
        assert_eq!(acc.content, "Hello");
        assert_eq!(seen, vec!["Hel", "lo"]);
    }

    #[test]
    fn sse_accumulator_merges_tool_call_fragments() {
        let mut acc = SseAccumulator::default();
        let mut emitted = false;
        let mut cb = |_: Option<&str>| {};
        acc.feed(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"file_\",\"arguments\":\"{\\\"a\\\":\"}}]}}]}",
            &mut cb,
            &mut emitted,
        );
        acc.feed(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read\",\"arguments\":\"1}\"}}]}}]}",
            &mut cb,
            &mut emitted,
        );
        let m = acc.message();
        assert_eq!(m.tool_calls.len(), 1);
        assert_eq!(m.tool_calls[0].function.name, "file_read");
        assert_eq!(m.tool_calls[0].function.arguments, "{\"a\":1}");
    }
}
