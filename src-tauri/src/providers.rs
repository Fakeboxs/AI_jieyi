use crate::config::{Advanced, Config};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub struct Translation {
    pub text: String,
    pub elapsed_ms: u64,
    /// time until the first streamed character (0 for one-shot requests)
    pub ttft_ms: u64,
    /// true when the user stopped the stream early
    pub cancelled: bool,
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

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 360 {
        format!("{}…", &s[..360])
    } else {
        s
    }
}

fn parse_response(cfg: &Config, body: &Value) -> Result<String, String> {
    match cfg.provider.as_str() {
        "anthropic" => join_parts(body.get("content").unwrap_or(&Value::Null))
            .ok_or_else(|| format!("响应里没有文本内容：{}", short(body))),
        "gemini" => body
            .pointer("/candidates/0/content/parts")
            .and_then(join_parts)
            .ok_or_else(|| format!("响应里没有文本内容：{}", short(body))),
        "advanced" => parse_advanced(&cfg.advanced, body),
        _ => match body.pointer("/choices/0/message/content") {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(other) => {
                join_parts(other).ok_or_else(|| format!("响应里没有文本内容：{}", short(other)))
            }
            None => Err(format!("响应里没有 choices：{}", short(body))),
        },
    }
}

fn parse_advanced(a: &Advanced, body: &Value) -> Result<String, String> {
    let path = a.response_path.trim();
    if !path.is_empty() {
        let hit = body
            .pointer(path)
            .ok_or_else(|| format!("response_path `{path}` 没有命中：{}", short(body)))?;
        return match hit {
            Value::String(s) => Ok(s.clone()),
            other => join_parts(other)
                .or_else(|| other.as_str().map(str::to_string))
                .ok_or_else(|| format!("`{path}` 命中的内容不是文本：{}", short(other))),
        };
    }
    // No explicit path: try the shapes we know, in order.
    if let Some(Value::String(s)) = body.pointer("/choices/0/message/content") {
        return Ok(s.clone());
    }
    if let Some(text) = body.get("content").and_then(join_parts) {
        return Ok(text);
    }
    if let Some(text) = body.pointer("/candidates/0/content/parts").and_then(join_parts) {
        return Ok(text);
    }
    Err(format!(
        "没能在响应里找到文本，请设置 response_path：{}",
        short(body)
    ))
}

/// Reasoning tokens (DeepSeek `reasoning_content`): shown as "thinking…", never
/// mixed into the translation.
fn delta_reasoning(v: &Value) -> Option<String> {
    v.pointer("/choices/0/delta/reasoning_content")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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

/// Substitute `{{…}}` placeholders inside an advanced-template string.
fn render_template(tpl: &str, cfg: &Config, images_b64: &[String], mime: &str, stream: bool) -> String {
    let data_urls: Vec<String> = images_b64
        .iter()
        .map(|b| format!("data:{mime};base64,{b}"))
        .collect();
    let images_json = serde_json::to_string(&data_urls).unwrap_or_else(|_| "[]".to_string());
    // OpenAI-style content parts, already comma-joined WITHOUT the outer array
    // brackets: templates splice them straight into their own `content: [ … ]`.
    let parts_json = data_urls
        .iter()
        .map(|u| {
            json!({ "type": "image_url", "image_url": { "url": u } }).to_string()
        })
        .collect::<Vec<_>>()
        .join(",");
    let prompt_json = serde_json::to_string(&cfg.prompt).unwrap_or_else(|_| "\"\"".to_string());
    let model = cfg.model();
    let model_json = serde_json::to_string(&model).unwrap_or_else(|_| "\"\"".to_string());

    tpl.replace("{{api_key}}", cfg.api_key.trim())
        .replace("{{model_json}}", &model_json)
        .replace("{{model}}", &model)
        .replace("{{prompt_json}}", &prompt_json)
        .replace("{{prompt}}", &cfg.prompt)
        .replace("{{max_tokens}}", &cfg.max_tokens.to_string())
        .replace("{{temperature}}", &cfg.temperature.to_string())
        .replace("{{stream}}", if stream { "true" } else { "false" })
        .replace("{{image_count}}", &images_b64.len().to_string())
        .replace("{{image_data}}", images_b64.first().map(String::as_str).unwrap_or(""))
        .replace("{{image_parts}}", &parts_json)
        .replace("{{images}}", &images_json)
}

/// Used when the user opens the advanced template without editing it.
pub const ADVANCED_BODY_EXAMPLE: &str = r#"{
  "model": {{model_json}},
  "max_tokens": {{max_tokens}},
  "temperature": {{temperature}},
  "messages": [
    {
      "role": "user",
      "content": [
        {{image_parts}},
        { "type": "text", "text": {{prompt_json}} }
      ]
    }
  ]
}"#;

fn build_request(
    client: &reqwest::Client,
    cfg: &Config,
    images_b64: &[String],
    mime: &str,
    stream: bool,
) -> Result<reqwest::RequestBuilder, String> {
    if cfg.provider != "advanced" && cfg.api_key.trim().is_empty() {
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
                        "source": { "type": "base64", "media_type": mime, "data": b }
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
                .map(|b| json!({ "inline_data": { "mime_type": mime, "data": b } }))
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
        "advanced" => {
            let a = &cfg.advanced;
            if a.endpoint.trim().is_empty() {
                return Err("高级模板还没填 endpoint（设置 → 高级 API）".into());
            }
            let url = render_template(a.endpoint.trim(), cfg, images_b64, mime, stream);
            let body_tpl = if a.body.trim().is_empty() {
                ADVANCED_BODY_EXAMPLE.to_string()
            } else {
                a.body.clone()
            };
            let rendered = render_template(&body_tpl, cfg, images_b64, mime, stream);
            let mut body: Value = serde_json::from_str(&rendered)
                .map_err(|e| format!("模板渲染后的请求体不是合法 JSON：{e}"))?;
            // Streaming is decided by the app, not by the template: inject it only
            // when the author did not write a `stream` field themselves.
            if stream && body.get("stream").is_none() {
                body["stream"] = json!(true);
            }

            let mut req = client.post(url).header("content-type", "application/json");
            for h in &a.headers {
                if h.key.trim().is_empty() {
                    continue;
                }
                req = req.header(h.key.trim(), render_template(&h.value, cfg, images_b64, mime, stream));
            }
            req.json(&body)
        }
        _ => {
            let url = format!("{base}/chat/completions");
            let mut content: Vec<Value> = images_b64
                .iter()
                .map(|b| {
                    json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{mime};base64,{b}") }
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
            // DeepSeek turns thinking ON by default (effort=high), which spends
            // seconds before the first visible character. Translation never needs
            // it, so we ask for it to be switched off unless the user opted in.
            match cfg.thinking.as_str() {
                "off" => {
                    body["thinking"] = json!({ "type": "disabled" });
                }
                "on" => {
                    body["thinking"] = json!({ "type": "enabled" });
                }
                _ => {}
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
    mime: &str,
) -> Result<Translation, String> {
    let started = Instant::now();
    let resp = build_request(client, cfg, images_b64, mime, false)?
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
    let text = parse_response(cfg, &body)?;
    Ok(Translation {
        text: text.trim().to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        ttft_ms: 0,
        cancelled: false,
    })
}

/// SSE request: every delta is pushed through `on_delta`. `cancel` lets the user
/// stop mid-generation — whatever already arrived is kept.
pub async fn translate_stream<F: FnMut(&str), G: FnMut(usize)>(
    client: &reqwest::Client,
    cfg: &Config,
    images_b64: &[String],
    mime: &str,
    cancel: Arc<AtomicBool>,
    mut on_delta: F,
    mut on_thought: G,
) -> Result<Translation, String> {
    let started = Instant::now();
    let resp = build_request(client, cfg, images_b64, mime, true)?
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
    let mut cancelled = false;
    let mut ttft_ms = 0u64;
    let mut reasoning_chars = 0usize;

    'read: while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
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
                if let Some(thought) = delta_reasoning(&value) {
                    if ttft_ms == 0 {
                        reasoning_chars += thought.chars().count();
                        let _ = on_thought(reasoning_chars);
                    }
                    continue;
                }
                if let Some(delta) = delta_text(&cfg.provider, &value) {
                    if !delta.is_empty() {
                        if ttft_ms == 0 {
                            ttft_ms = started.elapsed().as_millis() as u64;
                        }
                        out.push_str(&delta);
                        on_delta(&delta);
                    }
                }
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    break 'read;
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
        ttft_ms,
        cancelled,
    })
}

/// Lightweight reachability probe: GET /models where the API exposes one.
pub async fn probe(client: &reqwest::Client, cfg: &Config) -> Result<String, String> {
    if cfg.provider == "advanced" {
        return Ok("高级模板不做连接探测，直接截图试翻一次即可".into());
    }
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
