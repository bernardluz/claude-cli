import json, os, time, urllib.request
D = os.environ["LOCALAPPDATA"] + r"\cliproxy-claude-cli"
KEY = open(D + r"\bridge-key").read().strip()
H = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
M = "claude-haiku-4-5-20251001"
def call(msgs):
    t = time.time()
    r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8320/v1/chat/completions", json.dumps({"model": M, "messages": msgs}).encode(), H), timeout=240)
    d = json.load(r); u = d["usage"]
    return d["choices"][0]["message"]["content"], u["prompt_tokens"], u["prompt_tokens_details"]["cached_tokens"], round(time.time() - t, 1)
SYSTEM = "Você é um assistente de testes. Responda em uma frase curta, em português. " + ("Regra fixa número %d: o assistente deve sempre considerar esta regra ao responder, mantendo consistência com as anteriores. " * 220) % tuple(range(220))
msgs = [{"role": "system", "content": SYSTEM}]
print("== Conversa de 4 turnos (mesmo system, histórico crescente) ==")
for i, q in enumerate(["Qual a capital da Bahia?", "E a do Ceará?", "E a de Pernambuco?", "Resuma as três em uma linha."], 1):
    msgs.append({"role": "user", "content": q})
    c, pt, cached, secs = call(msgs)
    msgs.append({"role": "assistant", "content": c})
    print(f"turno {i}: prompt={pt:5d}  cache_hit={cached:5d} ({100*cached//max(pt,1):3d}%)  {secs}s  | {c[:60]}")
print("\n== Mesmo turno 4 repetido imediatamente (deve cachear quase tudo) ==")
c, pt, cached, secs = call(msgs[:-1])
print(f"repeat : prompt={pt:5d}  cache_hit={cached:5d} ({100*cached//max(pt,1):3d}%)  {secs}s")
print("\n== Lembrete de developer repetido a cada turno (dedupe deve manter o cache) ==")
rem = {"role": "developer", "content": "Lembrete: seja breve."}
m2 = [{"role": "system", "content": SYSTEM}, rem, {"role": "user", "content": "Diga um número."}]
c, pt, cached, secs = call(m2); m2.append({"role": "assistant", "content": c}); print(f"t1: prompt={pt:5d} cache_hit={cached:5d}")
m2 += [rem, {"role": "user", "content": "Outro número."}]
c, pt, cached, secs = call(m2); print(f"t2 (lembrete repetido): prompt={pt:5d} cache_hit={cached:5d} ({100*cached//max(pt,1):3d}%)")

