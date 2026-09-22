"""Reproduz o caminho do Factory: /v1/messages com ferramentas, tool_use + tool_result e turnos
seguintes. Cada turno deve aparecer no log do adaptador como resumed=true a partir do segundo."""
import json, os, time, urllib.request

D = os.environ["LOCALAPPDATA"] + r"\cliproxy-claude-cli"
KEY = open(D + r"\bridge-key").read().strip()
H = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
SYS = "Você é um agente de testes com ferramentas. " + ("Regra fixa %d: considere esta regra. " * 320) % tuple(range(320))
TOOLS = [{"name": "get_weather", "description": "Clima atual de uma cidade",
          "input_schema": {"type": "object", "properties": {"cidade": {"type": "string"}}, "required": ["cidade"]}}]


def call(msgs):
    body = {"model": "claude-haiku-4-5-20251001", "max_tokens": 16000, "system": SYS, "tools": TOOLS, "messages": msgs}
    t = time.time()
    d = json.load(urllib.request.urlopen(urllib.request.Request(
        "http://127.0.0.1:8320/v1/messages", json.dumps(body).encode(), H), timeout=240))
    u = d["usage"]
    kinds = "+".join(b["type"] for b in d["content"])
    print(f"  novos={u['input_tokens']:5d} cache={u['cache_read_input_tokens']:5d} "
          f"out={u['output_tokens']:4d} {time.time()-t:4.1f}s blocos={kinds}")
    return d


msgs = [{"role": "user", "content": "Qual o clima em Salvador? Use a ferramenta get_weather."}]
print("turno 1 (espera tool_use):")
r1 = call(msgs)
use = next((b for b in r1["content"] if b["type"] == "tool_use"), None)
assert use, "o modelo não pediu a ferramenta"
msgs += [{"role": "assistant", "content": r1["content"]},
         {"role": "user", "content": [{"type": "tool_result", "tool_use_id": use["id"], "content": "28 graus, sol"}]}]
print("turno 2 (resultado da ferramenta, espera resumed):")
r2 = call(msgs)
msgs += [{"role": "assistant", "content": r2["content"]}, {"role": "user", "content": "E em Fortaleza? Responda sem ferramenta."}]
print("turno 3 (espera resumed):")
call(msgs)
