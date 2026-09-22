# claude-cli

Adaptador local que expõe o **Claude Code CLI** (`claude -p`) como uma API HTTP
compatível com OpenAI (`/v1/chat/completions`) e com Anthropic (`/v1/messages`).
Serve para que clientes que falam essas APIs, como Factory ou Codex, usem a
assinatura já autenticada no Claude Code, sem chave de API.

Roda apenas em `127.0.0.1`, protegido por uma chave local.

## O que ele resolve

**Cache de prompt.** Clientes de chat reenviam o histórico inteiro a cada turno,
e o Claude Code, chamado assim, só mantém o prompt de sistema em cache. O
adaptador mapeia cada conversa para uma sessão do Claude Code e retoma essa
sessão nos turnos seguintes, enviando apenas os registros novos. Em uso real o
cache passou de 30% para mais de 90% da entrada.

**Isolamento.** O Claude Code é executado sem nada do ambiente do usuário: sem
hooks, sem skills, sem comandos, sem MCP, sem memória de projeto e sem nenhuma
ferramenta executável. Quem controla a conversa é o cliente, não a instalação
local. Se uma atualização do CLI reabrir alguma ferramenta, a requisição falha
em vez de continuar em silêncio.

**Ferramentas.** As funções declaradas pelo cliente viajam como definições e
voltam como saída estruturada, nunca como chamadas nativas. Um modelo que
insistir em chamar ferramentas inexistentes é cortado na segunda tentativa, em
vez de consumir a assinatura por dezenas de turnos.

## Recursos

- `/v1/chat/completions` e `/v1/messages`, com streaming em ambos.
- Chamadas de função, `tool_choice`, paralelismo e imagens.
- Sessões com retomada, TTL configurável e limpeza dos transcritos.
- Painel em `/panel`: consumo da assinatura, requisições, cache, erros e últimas
  chamadas. Dados somente leitura, sem nenhum texto de prompt.
- `/health` com verificação periódica das flags exigidas do CLI.
- Erros temporários do provedor viram 503 retentável, e não 502 definitivo.

## Instalação

Requer Node 22 ou superior e o Claude Code CLI autenticado.

```bash
npm install
cp config.example.json config.json   # ajuste caminhos, porta e modelos
head -c 32 /dev/urandom | base64 > bridge-key
CLAUDE_BRIDGE_CONFIG=$PWD/config.json npm start
```

Cliente compatível com OpenAI aponta para `http://127.0.0.1:8320/v1` usando o
conteúdo de `bridge-key` como token. Cliente Anthropic usa a mesma chave em
`x-api-key`.

## Configuração

| campo | função |
| --- | --- |
| `host`, `port` | endereço de escuta; `host` precisa ser `127.0.0.1` |
| `keyFile` | arquivo com a chave local, mínimo de 24 caracteres |
| `executable` | caminho do binário `claude` |
| `configDir` | diretório de configuração do Claude Code a usar |
| `tempRoot` | raiz dos diretórios temporários e das sessões |
| `maxConcurrent` | requisições simultâneas aceitas |
| `timeoutMs` | tempo máximo de uma chamada ao CLI |
| `sessions` | `enabled` e `ttlMinutes` da retomada de sessão |
| `models` | modelos aceitos; qualquer outro recebe 404 |

## Testes

```bash
npm test
```

Cobrem isolamento, compatibilidade de flags, streaming, cancelamento, sessões,
métricas, consulta de assinatura e o painel. Nenhum teste chama a API real.

## Segurança

- A chave local nunca aparece em log, resposta ou mensagem de erro.
- O ambiente repassado ao CLI é limpo de variáveis de credencial.
- O token da assinatura é lido apenas na consulta de consumo e nunca é devolvido.
- Prompts não entram em métricas nem no painel.

O histórico de implantação em servidor está em
[docs/historico-vps.md](docs/historico-vps.md).
