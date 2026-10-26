//! ตัวคำนวณเลข — แทน `new Function("return (expr)")` ของ JS
//!
//! รองรับ: + - * / % ** วงเล็บ เลขทศนิยม เลขยกกำลัง (1e5) · ปฏิเสธทุกอย่างอื่น
//! (JS ก็ปฏิเสธด้วย regex เดียวกัน: ^[-+*/%().\d eE]+$ , max 200 chars)

/// แปลงนิพจน์ → ค่า (f64) พร้อมข้อความ error แบบเดียวกับ JS
pub fn eval(expr: &str) -> Result<f64, String> {
    let cleaned = expr.replace('^', "**");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 200 {
        return Err(
            "Only plain arithmetic allowed (+ - * / % ** parentheses), max 200 chars".into(),
        );
    }
    // allowlist เหมือน JS: ตัวเลข ตัวดำเนินการ วงเล็บ และ e/E (สำหรับเลขยกกำลัง)
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || "+-*/%().eE ".contains(c))
    {
        return Err(
            "Only plain arithmetic allowed (+ - * / % ** parentheses), max 200 chars".into(),
        );
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let mut p = Parser { chars, pos: 0 };
    let value = p.parse_expr()?;
    p.skip_ws();
    if p.pos != p.chars.len() {
        return Err(format!("Unexpected character in expression: {:?}", trimmed));
    }
    if value.is_nan() || value.is_infinite() {
        return Err("Result is not a finite number".into());
    }
    Ok(value)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn skip_ws(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos].is_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.skip_ws();
        self.chars.get(self.pos).copied()
    }

    fn parse_expr(&mut self) -> Result<f64, String> {
        let mut left = self.parse_term()?;
        loop {
            match self.peek() {
                Some('+') => {
                    self.pos += 1;
                    let right = self.parse_term()?;
                    left += right;
                }
                Some('-') => {
                    self.pos += 1;
                    let right = self.parse_term()?;
                    left -= right;
                }
                _ => return Ok(left),
            }
        }
    }

    fn parse_term(&mut self) -> Result<f64, String> {
        let mut left = self.parse_factor()?;
        loop {
            match self.peek() {
                Some('*') => {
                    self.pos += 1;
                    let right = self.parse_factor()?;
                    left *= right;
                }
                Some('/') => {
                    self.pos += 1;
                    let right = self.parse_factor()?;
                    if right == 0.0 {
                        return Err("Division by zero".into());
                    }
                    left /= right;
                }
                Some('%') => {
                    self.pos += 1;
                    let right = self.parse_factor()?;
                    if right == 0.0 {
                        return Err("Division by zero".into());
                    }
                    left = left % right; // Rust % = remainder (ตัดเศษเหมือน JS)
                }
                _ => return Ok(left),
            }
        }
    }

    fn parse_factor(&mut self) -> Result<f64, String> {
        let base = self.parse_unary()?;
        if self.peek() == Some('*') {
            // ต้องเป็น "**" ไม่ใช่ "*" เดี่ยวๆ (เครื่องหมายคูณไปจัดการใน parse_term แล้ว)
            if self.chars.get(self.pos + 1) == Some(&'*') {
                self.pos += 2;
                let exp = self.parse_factor()?; // right-associative
                return Ok(base.powf(exp));
            }
        }
        Ok(base)
    }

    fn parse_unary(&mut self) -> Result<f64, String> {
        match self.peek() {
            Some('-') => {
                self.pos += 1;
                Ok(-self.parse_unary()?)
            }
            Some('+') => {
                self.pos += 1;
                self.parse_unary()
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<f64, String> {
        self.skip_ws();
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                let v = self.parse_expr()?;
                if self.peek() != Some(')') {
                    return Err("Missing closing parenthesis".into());
                }
                self.pos += 1;
                Ok(v)
            }
            Some(c) if c.is_ascii_digit() || c == '.' => self.parse_number(),
            Some(c) => Err(format!("Unexpected character: {c:?}")),
            None => Err("Unexpected end of expression".into()),
        }
    }

    fn parse_number(&mut self) -> Result<f64, String> {
        self.skip_ws();
        let start = self.pos;
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
        if self.pos < self.chars.len() && self.chars[self.pos] == '.' {
            self.pos += 1;
            while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
        }
        // เลขยกกำลังแบบ 1e5 / 1.2E-3
        if self.pos < self.chars.len()
            && (self.chars[self.pos] == 'e' || self.chars[self.pos] == 'E')
        {
            let save = self.pos;
            self.pos += 1;
            if self.pos < self.chars.len()
                && (self.chars[self.pos] == '+' || self.chars[self.pos] == '-')
            {
                self.pos += 1;
            }
            let digits_start = self.pos;
            while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
            if self.pos == digits_start {
                self.pos = save; // ไม่ใช่เลขยกกำลังจริง → คืนตำแหน่งเดิม
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        text.parse::<f64>()
            .map_err(|_| format!("Invalid number: {text}"))
    }
}

/// ฟอร์แมตตัวเลขแบบ JS (ไม่มี trailing .0)
pub fn format_number(v: f64) -> String {
    if v == v.trunc() && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        let s = format!("{v}");
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_arithmetic() {
        assert_eq!(eval("1+2").unwrap(), 3.0);
        assert_eq!(eval("(1200 * 1.07) / 3").unwrap(), 428.0);
        assert_eq!(eval("10 - 4 - 3").unwrap(), 3.0); // left assoc
        assert_eq!(eval("2 ** 10").unwrap(), 1024.0);
        assert_eq!(eval("2 ^ 10").unwrap(), 1024.0); // ^ → **
        assert_eq!(eval("-5 + 3").unwrap(), -2.0);
        assert_eq!(eval("7 % 3").unwrap(), 1.0);
    }

    #[test]
    fn exponent_is_right_associative() {
        assert_eq!(eval("2 ** 3 ** 2").unwrap(), 512.0);
    }

    #[test]
    fn scientific_notation() {
        assert_eq!(eval("1e5").unwrap(), 100000.0);
        assert_eq!(eval("1.5e2").unwrap(), 150.0);
    }

    #[test]
    fn rejects_non_arithmetic() {
        assert!(eval("process.exit(1)").is_err());
        assert!(eval("require('fs')").is_err());
        assert!(eval("alert(1)").is_err());
    }

    #[test]
    fn rejects_overlong() {
        let long = "1+".repeat(200);
        assert!(eval(&long).is_err());
    }

    #[test]
    fn divides_by_zero_errors() {
        assert!(eval("1/0").is_err());
    }
}
