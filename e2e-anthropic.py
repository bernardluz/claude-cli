import json, os, urllib.request, urllib.error
D = os.environ["LOCALAPPDATA"] + r"\cliproxy-claude-cli"; KEY = open(D + r"\bridge-key").read().strip()
M = "claude-haiku-4-5-20251001"; H = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
def call(body, stream=False):
    try:
        r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8320/v1/messages", json.dumps(body).encode(), H), timeout=240)
        return r.status, (r.read().decode() if stream else json.load(r))
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
st, d = call({"model": M, "max_tokens": 16000, "system": "Responda em uma palavra.", "messages": [{"role": "user", "content": "Capital da Bahia?"}]})
print("1 texto:", st, d["content"] if st == 200 else d, "| usage:", d.get("usage") if st == 200 else "")
st, raw = call({"model": M, "max_tokens": 16000, "stream": True, "messages": [{"role": "user", "content": "Conte de 1 a 20 separando por vírgula."}]}, stream=True)
ev = [f.split("\n")[0] for f in raw.split("\n\n") if f.startswith("event:")]
print("2 stream:", st, len([e for e in ev if "content_block_delta" in e]), "deltas | eventos:", sorted(set(ev)))
tools = [{"name": "get_weather", "description": "Clima de uma cidade", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
st, d = call({"model": M, "max_tokens": 16000, "tools": tools, "messages": [{"role": "user", "content": "Clima em Salvador? Use a ferramenta."}]})
tu = [b for b in d.get("content", []) if b["type"] == "tool_use"] if st == 200 else []
print("3a tool_use:", st, tu[0] if tu else d, "| stop:", d.get("stop_reason") if st == 200 else "")
if tu:
    st, d = call({"model": M, "max_tokens": 16000, "tools": tools, "messages": [{"role": "user", "content": "Clima em Salvador? Use a ferramenta."}, {"role": "assistant", "content": d["content"]}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tu[0]["id"], "content": '{"temp_c": 29, "sky": "ensolarado"}'}]}]})
    print("3b final:", st, d["content"][0]["text"][:100] if st == 200 else d)
