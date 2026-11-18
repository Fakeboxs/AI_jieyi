"""Tiny OpenAI-compatible mock so the real capture→translate path can be tested
without spending tokens. Returns a fixed translated paragraph with LaTeX.

    python scripts/mock_server.py 8899
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKDOWN = """## 鞍点法近似

在最后一步我们应用了鞍点法 [50, 51]。构型熵 $\\Sigma$ 表示总状态数的对数；在具有 $f^{*}$（对配分函数 $Z$ 贡献最大）的状态处，配分函数近似为

$$Z \\approx \\frac{e^{S(f^{*})}}{\\sqrt{2\\pi\\,\\det(-H)}}$$

其中 $H = \\nabla^{2} S(f^{*})$ 是熵的 Hessian 矩阵。**关键条件**是 $f^{*}$ 为极大值点且 $\\det(-H) > 0$。

| 符号 | 含义 |
| --- | --- |
| $S$ | 构型熵 |
| $H$ | 熵的 Hessian |
| $Z$ | 配分函数 |

> 这是本地 mock 服务返回的示例译文，用于验证截图 → 编码 → 请求 → 渲染的完整链路。"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._send(200, {"object": "list", "data": [{"id": "mock-vl", "object": "model"}]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        images = 0
        for msg in body.get("messages", []):
            for part in msg.get("content", []) if isinstance(msg.get("content"), list) else []:
                if part.get("type") == "image_url":
                    images += 1
        auth = self.headers.get("authorization", "")
        streaming = bool(body.get("stream"))
        sys.stderr.write(
            f"[mock] POST {self.path} auth={auth[:12]}… images={images} bytes={length} stream={streaming}\n"
        )
        if images == 0:
            self._send(400, {"error": {"message": "no image in request"}})
            return
        if streaming:
            self._stream(body)
            return
        # Simulate a slow one-shot completion so the non-streaming UI state is visible.
        time.sleep(0.9)
        self._send(
            200,
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": body.get("model", "mock-vl"),
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": MARKDOWN},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 812, "completion_tokens": 233, "total_tokens": 1045},
            },
        )

    def _stream(self, body):
        """SSE: emit the markdown in ~12-char deltas so the UI visibly types."""
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        text = MARKDOWN
        step = 12
        for i in range(0, len(text), step):
            piece = text[i : i + step]
            payload = {"choices": [{"index": 0, "delta": {"content": piece}}]}
            self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.035)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f"mock provider on http://127.0.0.1:{port}/v1", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
