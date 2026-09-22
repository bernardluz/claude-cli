import json, os, urllib.request, urllib.error
D = os.environ["LOCALAPPDATA"] + r"\cliproxy-claude-cli"; KEY = open(D + r"\bridge-key").read().strip()
H = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
tools = [{"name": "get_weather", "description": "Clima atual de uma cidade", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
def call(body):
    try: return json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8320/v1/messages", json.dumps(body).encode(), H), timeout=240))
    except urllib.error.HTTPError as e: return {"error": e.read().decode()}
for model, mt in [("claude-haiku-4-5-20251001", 16000), ("claude-haiku-4-5-20251001", 1000), ("claude-sonnet-5", 16000)]:
    d = call({"model": model, "max_tokens": mt, "tools": tools, "messages": [{"role": "user", "content": "Qual o clima em Salvador agora? Use a ferramenta get_weather."}]})
    tu = [b for b in d.get("content", []) if b.get("type") == "tool_use"]
    print(f"{model:28} max_tokens={mt:5}:", ("tool_use " + json.dumps(tu[0]["input"])) if tu else ("SEM tool_use: " + str(d.get("content") or d)[:140]))
