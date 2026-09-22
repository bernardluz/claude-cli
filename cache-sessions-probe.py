"""Mede o cache com sessões: 4 turnos no modo Anthropic; espera-se resume a partir do 2º e cache cobrindo o histórico."""
import json, os, time, urllib.request
D = os.environ["LOCALAPPDATA"] + r"\cliproxy-claude-cli"
KEY = open(D + r"\bridge-key").read().strip()
H = {"x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
SYS = "Você é um assistente de testes. Responda em uma frase curta. " + ("Regra fixa %d: considere esta regra ao responder. " * 320) % tuple(range(320))
msgs = []
for i, q in enumerate(["Meu número secreto é 4242. Confirme.", "Capital da Bahia?", "E do Ceará?", "Qual era meu número secreto?"], 1):
    msgs.append({"role": "user", "content": q}); t = time.time()
    d = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8320/v1/messages", json.dumps({"model": "claude-haiku-4-5-20251001", "max_tokens": 16000, "system": SYS, "messages": msgs}).encode(), H), timeout=240))
    txt = d["content"][0]["text"]; msgs.append({"role": "assistant", "content": txt}); u = d["usage"]
    print(f"turno {i}: novos={u['input_tokens']:5d}  cache={u['cache_read_input_tokens']:5d}  out={u['output_tokens']:4d}  {time.time()-t:4.1f}s | {txt[:60]}")
