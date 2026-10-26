//! ข้อผิดพลาดกลางของแอป — แปลงเป็น string ให้ฝั่ง UI อ่านง่าย

use std::fmt;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    #[error("url: {0}")]
    Url(#[from] url::ParseError),

    #[error("{0}")]
    Guard(#[from] GuardError),

    #[error("ไม่พบผู้ใช้")]
    UserNotFound,

    #[error("รหัสผ่านไม่ถูกต้อง")]
    BadCredentials,

    #[error("ลองใส่รหัสผ่านผิดหลายครั้งเกินไป — ลองอีกครั้งใน {0} วินาที")]
    RateLimited(u64),

    #[error("ยังไม่ได้ตั้งค่า OpenRouter API key")]
    NoApiKey,

    #[error("ต้องเข้าสู่ระบบก่อน")]
    Unauthorized,
}

impl AppError {
    pub fn msg(m: impl Into<String>) -> Self {
        AppError::Msg(m.into())
    }
}

/// ข้อผิดพลาดด้านความปลอดภัย (SSRF / path escape) — แยกชนิดไว้เพราะต้องแสดงข้อความเดียวกับเวอร์ชัน JS
/// (Display เขียนเอง ไม่ใช้ thiserror เพราะข้อความต้องตรงทุกตัวอักษร)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    InvalidUrl,
    SchemeNotAllowed,
    CredentialsNotAllowed,
    PrivateDestination,
    ResolveFailed,
    TooManyRedirects,
    BodyTooLarge,
    PathEscape,
    SymlinkNotAllowed,
    NoExistingParent,
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // ข้อความต้องตรงกับ JS เดิมทุกตัวอักษร เพราะ test-security-guards.js เทียบ string
        let msg = match self {
            GuardError::InvalidUrl => "Invalid URL",
            GuardError::SchemeNotAllowed => "Only http:// or https:// URLs are allowed",
            GuardError::CredentialsNotAllowed => "URL credentials are not allowed",
            GuardError::PrivateDestination => {
                "Private or reserved network destinations are not allowed"
            }
            GuardError::ResolveFailed => "Could not resolve public host",
            GuardError::TooManyRedirects => "Too many redirects",
            GuardError::BodyTooLarge => "Response body exceeds 2 MB",
            GuardError::PathEscape => "Path escapes the project directory",
            GuardError::SymlinkNotAllowed => "Symbolic links are not allowed in workspace paths",
            GuardError::NoExistingParent => "Path has no existing parent",
        };
        write!(f, "{msg}")
    }
}

impl std::error::Error for GuardError {}
