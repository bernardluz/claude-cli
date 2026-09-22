"""Validação real do adaptador claude-cli, chamando-o direto (127.0.0.1:8320) com o login local do Claude Code.

Uso: python e2e-direct.py [modelo]
"""
import json, os, sys, urllib.request, urllib.error

D = os.path.dirname(os.path.abspath(__file__))
MODEL = sys.argv[1] if len(sys.argv) > 1 else "claude-haiku-4-5-20251001"
KEY = open(os.path.join(D, "bridge-key")).read().strip()
URL = "http://127.0.0.1:8320/v1/chat/completions"
H = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
results = []


def call(body, stream=False, timeout=240):
    req = urllib.request.Request(URL, json.dumps(body).encode(), H)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, (r.read().decode() if stream else json.load(r))
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return e.code, (body if stream else json.loads(body))


def check(name, ok, detail):
    results.append(ok); print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -> {str(detail)[:400]}"))


# 1. texto
st, d = call({"model": MODEL, "max_tokens": 32, "messages": [{"role": "user", "content": "Responda só a palavra: banana"}]})
c = (d.get("choices") or [{}])[0].get("message", {}).get("content") if st == 200 else d
check("1 texto simples", st == 200 and "banana" in str(c).lower(), d)
if st == 200: print("   usage:", d.get("usage"))

# 2. streaming
st, raw = call({"model": MODEL, "stream": True, "max_tokens": 150, "messages": [{"role": "user", "content": "Conte de 1 a 30 separando por vírgula."}]}, stream=True)
chunks = [l for l in raw.splitlines() if l.startswith("data: {")]
check("2 streaming (>3 chunks)", st == 200 and len(chunks) > 3, f"{st} {len(chunks)} chunks {raw[:200]}")

# 3. tool call + resultado
tools = [{"type": "function", "function": {"name": "get_weather", "description": "Clima atual de uma cidade", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
msgs = [{"role": "user", "content": "Qual o clima em Salvador agora? Use a ferramenta."}]
st, d = call({"model": MODEL, "max_tokens": 200, "tools": tools, "messages": msgs})
tc = ((d.get("choices") or [{}])[0].get("message", {}).get("tool_calls") or []) if st == 200 else []
ok = bool(tc) and tc[0]["function"]["name"] == "get_weather" and "Salvador" in tc[0]["function"]["arguments"]
check("3a tool call get_weather(city=Salvador)", ok, d)
if ok:
    msgs += [{"role": "assistant", "content": None, "tool_calls": tc}, {"role": "tool", "tool_call_id": tc[0]["id"], "content": json.dumps({"temp_c": 29, "sky": "ensolarado"})}]
    st, d = call({"model": MODEL, "max_tokens": 120, "tools": tools, "messages": msgs})
    c = (d.get("choices") or [{}])[0].get("message", {}).get("content") if st == 200 else d
    check("3b resposta final usa o resultado (29)", st == 200 and "29" in str(c), d)

# 4. streaming com tools (delta único de tool_calls)
st, raw = call({"model": MODEL, "stream": True, "max_tokens": 200, "tools": tools, "messages": [{"role": "user", "content": "Clima em Recife? Use a ferramenta."}]}, stream=True)
check("4 streaming com tool_calls", st == 200 and '"tool_calls"' in raw and "[DONE]" in raw, raw[:300])

# 5. imagem
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
st, d = call({"model": MODEL, "max_tokens": 40, "messages": [{"role": "user", "content": [{"type": "text", "text": "Qual a cor predominante desta imagem? Responda com uma palavra."}, {"type": "image_url", "image_url": {"url": "data:image/png;base64," + PNG}}]}]})
c = (d.get("choices") or [{}])[0].get("message", {}).get("content") if st == 200 else d
check("5 imagem (vermelho/red)", st == 200 and any(w in str(c).lower() for w in ("vermelh", "red")), d)

# 6. dedupe de system prompt não altera resposta
st, d = call({"model": MODEL, "max_tokens": 16, "messages": [{"role": "developer", "content": "Responda sempre em maiúsculas."}, {"role": "user", "content": "diga oi"}, {"role": "assistant", "content": "OI"}, {"role": "developer", "content": "Responda sempre em maiúsculas."}, {"role": "user", "content": "diga tchau"}]})
c = (d.get("choices") or [{}])[0].get("message", {}).get("content") if st == 200 else d
check("6 histórico + system repetido", st == 200 and "TCHAU" in str(c).upper(), d)

print(f"\nRESULTADO: {sum(results)} passaram, {len(results) - sum(results)} falharam")
sys.exit(0 if all(results) else 1)
