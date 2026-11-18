use crate::config::Config;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Instant;

pub struct Translation {
    pub text: String,
    pub elapsed_ms: u64,
}

fn join_parts(parts: &Value) -> Option<String> {
    let arr = parts.as_array()?;
    let mut out = String::new();
    for p in arr {
        if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
            out.push_str(t);
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

fn parse_response(provider: &str, body: &Value) -> Result<String, String> {
    match provider {
        "anthropic" => join_parts(body.get("content").unwrap_or(&Value::Null))
            .ok_or_else(|| format!("响应里没有文本内容：{}", short(body))),
        "gemini" => body
            .pointer("/candidates/0/content/parts")
            .and_then(join_parts)
            .ok_or_else(|| format!("响应里没有文本内容：{}", short(body))),
        _ => {
            let msg = body.pointer("/choices/0/message/content");
            match msg {
                Some(Value::String(s)) => Ok(s.clone()),
                Some(other) => {
                    join_parts(other).ok_or_else(|| format!("响应里没有文本内容：{}", short(body)))
                }
                None => Err(format!("响应里没有 choices：{}", short(body))),
            }
        }
    }
}

/// Pull the incremental text out of one SSE `data:` payload.
fn delta_text(provider: &str, v: &Value) -> Option<String> {
    match provider {
        "anthropic" => v
            .pointer("/delta/text")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        "gemini" => v.pointer("/candidates/0/content/parts").and_then(join_parts),
        _ => v
            .pointer("/choices/0/delta/content")
            .and_then(|x| x.as_str())
            .or_else(|| v.pointer("/choices/0/message/content").and_then(|x| x.as_str()))
            .map(str::to_string),
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 360 {
        format!("{}…", &s[..360])
    } else {
        s
    }
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.pointer("/message"))
                .and_then(|x| x.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(240).collect());
    format!("HTTP {} · {}", status.as_u16(), detail)
}

fn build_request(
    client: &reqwest::Client,
    cfg: &Config,
    images_b64: &[String],
    stream: bool,
) -> Result<reqwest::RequestBuilder, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("还没有填写 API Key（设置 → 模型服务）".into());
    }
    let base = cfg.trimmed_base();
    let model = cfg.model();

    Ok(match cfg.provider.as_str() {
        "anthropic" => {
            let url = if base.ends_with("/v1") {
                format!("{base}/messages")
            } else {
                format!("{base}/v1/messages")
            };
            let mut content: Vec<Value> = images_b64
                .iter()
                .map(|b| {
                    json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": "image/png", "data": b }
                    })
                })
                .collect();
            content.push(json!({ "type": "text", "text": cfg.prompt }));
            let mut body = json!({
                "model": model,
                "max_tokens": cfg.max_tokens,
                "temperature": cfg.temperature,
                "messages": [{ "role": "user", "content": content }]
            });
            if stream {
                body["stream"] = json!(true);
            }
            client
                .post(url)
                .header("x-api-key", cfg.api_key.trim())
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
        }
        "gemini" => {
            let action = if stream {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            let sep = if stream { "&" } else { "?" };
            let url = format!(
                "{base}/models/{model}:{action}{sep}key={}",
                cfg.api_key.trim()
            );
            let mut parts: Vec<Value> = images_b64
                .iter()
                .map(|b| json!({ "inline_data": { "mime_type": "image/png", "data": b } }))
                .collect();
            parts.push(json!({ "text": cfg.prompt }));
            client.post(url).json(&json!({
                "contents": [{ "role": "user", "parts": parts }],
                "generationConfig": {
                    "maxOutputTokens": cfg.max_tokens,
                    "temperature": cfg.temperature
                }
            }))
        }
        _ => {
            let url = format!("{base}/chat/completions");
            let mut content: Vec<Value> = images_b64
                .iter()
                .map(|b| {
                    json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:image/png;base64,{b}") }
                    })
                })
                .collect();
            content.push(json!({ "type": "text", "text": cfg.prompt }));
            let mut body = json!({
                "model": model,
                "max_tokens": cfg.max_tokens,
                "temperature": cfg.temperature,
                "messages": [{ "role": "user", "content": content }]
            });
            if stream {
                body["stream"] = json!(true);
            }
            client
                .post(url)
                .header("authorization", format!("Bearer {}", cfg.api_key.trim()))
                .header("content-type", "application/json")
                .json(&body)
        }
    })
}

/// One-shot request (used when streaming is switched off).
pub async fn translate(
    client: &reqwest::Client,
    cfg: &Config,
    images_b64: &[String],
) -> Result<Translation, String> {
    let started = Instant::now();
    let resp = build_request(client, cfg, images_b64, false)?
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(api_error(status, &text));
    }
    let body: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是 JSON：{e}"))?;
    if let Some(err) = body.pointer("/error/message").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    let text = parse_response(&cfg.provider, &body)?;
    Ok(Translation {
        text: text.trim().to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// SSE request: every delta is pushed through `on_delta`, the full text is returned at the end.
pub async fn translate_stream<F: FnMut(&str)>(
    client: &reqwest::Client,
    cfg: &Config,
    images_b64: &[String],
    mut on_delta: F,
) -> Result<Translation, String> {
    let started = Instant::now();
    let resp = build_request(client, cfg, images_b64, true)?
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(api_error(status, &body));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut out = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败：{e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));

        // SSE events are separated by a blank line.
        while let Some(pos) = buf.find("\n\n") {
            let event: String = buf.drain(..pos + 2).collect();
            for line in event.lines() {
                let Some(raw) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = raw.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let value: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue, // keep-alive or partial noise
                };
                if let Some(msg) = value.pointer("/error/message").and_then(|x| x.as_str()) {
                    return Err(msg.to_string());
                }
                if let Some(delta) = delta_text(&cfg.provider, &value) {
                    if !delta.is_empty() {
                        out.push_str(&delta);
                        on_delta(&delta);
                    }
                }
            }
        }
    }

    if out.trim().is_empty() {
        return Err("模型没有返回内容（流已结束）".into());
    }
    Ok(Translation {
        text: out.trim().to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Lightweight reachability probe: GET /models where the API exposes one.
pub async fn probe(client: &reqwest::Client, cfg: &Config) -> Result<String, String> {
    if cfg.api_key.trim().is_empty() {
        return Err("还没有填写 API Key".into());
    }
    let base = cfg.trimmed_base();
    let req = match cfg.provider.as_str() {
        "anthropic" => client
            .get(format!("{base}/v1/models"))
            .header("x-api-key", cfg.api_key.trim())
            .header("anthropic-version", "2023-06-01"),
        "gemini" => client.get(format!("{base}/models?key={}", cfg.api_key.trim())),
        _ => client
            .get(format!("{base}/models"))
            .header("authorization", format!("Bearer {}", cfg.api_key.trim())),
    };
    let resp = req.send().await.map_err(|e| format!("连接失败：{e}"))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(format!("连接正常 · {}", cfg.model()));
    }
    let body = resp.text().await.unwrap_or_default();
    if status.as_u16() == 404 || status.as_u16() == 405 {
        return Ok("端点可达（该服务未提供 /models 列表）".into());
    }
    Err(api_error(status, &body))
}
