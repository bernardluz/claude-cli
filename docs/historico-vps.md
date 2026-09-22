# Histórico de instalação na VPS

Notas de operação acumuladas durante a implantação. Caminhos absolutos foram
substituídos por `~`.

---

# CLIProxy → Claude Code CLI

## Instalação nativa atual — 20/09/2026

**Claude Code CLI v0.2.0 está instalado como plugin nativo**, visível na página
Plugins após atualizar. Fluxo: CLIProxy → `claude-cli.so` → adaptador local →
`claude -p`, usando o login existente na VPS. O serviço lateral continua necessário.

- Biblioteca: `~/.factory/subscription-proxy/plugins/claude-cli.so`.
- Instância principal: logs confirmaram `plugin loaded` e `plugin registered`;
  catálogo publicou 14 modelos `owned_by: claude-cli`.
- Chamada real retornou 429 com a mensagem exclusiva do executor nativo:
  `Claude Code CLI: subscription or concurrency limit reached.`
  O journal confirmou provider `claude-cli` e conta `claude-cli-local.json`.
- A assinatura continua com o limite semanal esgotado. Resposta bem-sucedida,
  streaming de conteúdo e ferramentas com a assinatura real não foram comprovados.
- A entrada HTTP `openai-compatibility` de nome `claude-cli` foi removida.
  Não manter essa entrada junto com o plugin: seu executor pode tomar precedência.
- As três credenciais OAuth diretas de Anthropic continuam preservadas e inativas.
- Instalação sem reinício. Foi preciso reenviar o registro da conta após carregar
  o plugin para corrigir `auth_not_found` na recarga dinâmica.

Configuração ativa:

```yaml
plugins:
  enabled: true
  dir: ~/.factory/subscription-proxy/plugins
  configs:
    claude-cli:
      enabled: true
      priority: 10
```

Registro não secreto em `auth/claude-cli-local.json` (permissão 0600):

```json
{"type":"claude-cli","label":"Claude Code CLI - existing VPS login","disabled":false}
```

O executor lê `config.json` e `bridge-key` privados do adaptador, com destino
limitado a loopback. Não importa os tokens OAuth do CLIProxy.
O campo obrigatório `GitHubRepository` dos metadados aponta para o código local:
`file://~/.local/share/cliproxy-claude-cli/native`.
Não existe repositório GitHub público deste plugin.

### Validação nativa

Cinco testes Go passaram com `-race`. `native/smoke.py` carregou a biblioteca real
numa instância isolada do CLIProxy 7.3.7, comprovou registro na API de gerenciamento,
catálogo e execução com retorno 429. Na instância principal a comprovação foi por
logs, catálogo e chamada real; sua API de gerenciamento não foi consultada.

```sh
export PATH=~/.cache/cliproxy-plugin-build/go/bin:$PATH
cd ~/.local/share/cliproxy-claude-cli/native
go test -race ./...
go build -buildmode=c-shared -o claude-cli.so .
python3 smoke.py
```

Go usado: 1.26.8. O smoke espera a condição atual de HTTP 429; ajustar a expectativa
quando a cota renovar. O executor usa callbacks HTTP do host para cancelamento,
recompõe frames SSE e fecha streams ativos antes do descarregamento.

### Reversão da conversão nativa

Backup privado:
`~/.local/share/cliproxy-claude-cli/backups/native-20260920T132200Z`.
Contém `config.before.yaml` e `state.json` com hashes. Não publicar esses arquivos.

Antes de restaurar, comparar o YAML atual com o hash posterior de `state.json`.
Se houve alterações, mesclar somente a desativação de `plugins.configs.claude-cli`
e a restauração da entrada `openai-compatibility` desse provider, preservando o
restante. Sem alterações posteriores, restaurar o YAML de backup no mesmo inode,
com lock, flush e fsync. Desativar somente `auth/claude-cli-local.json` e manter
o adaptador ativo. A biblioteca pode permanecer descoberta, mas desabilitada.

O helper antigo `activate.py rollback` deve recusar o YAML nativo atual. Aplicá-lo
somente depois de reverter a conversão nativa e confirmar a configuração esperada.
O watcher depende do inode do YAML: não usar substituição atômica nesse arquivo.

Referência ABI: https://github.com/router-for-me/CLIProxyAPI/tree/b773607e/examples/plugin

## Histórico da integração HTTP anterior e limites do adaptador

As instruções de ativação HTTP abaixo documentam a etapa anterior. A configuração
nativa acima é o estado atual e substitui a entrada `openai-compatibility`.

Adaptador local OpenAI Chat Completions que executa `claude -p` usando exclusivamente
o login existente em `~/.claude`. Não lê nem importa os tokens do
CLIProxy. Não usa o Agent SDK. As outras contas não participam da integração.

## Estado em 20/09/2026

- Implementação preparada localmente e copiada para
  `~/.local/share/cliproxy-claude-cli` na VPS.
- **Ativada por autorização explícita do usuário**, mesmo com a cota esgotada.
  Serviço `claude-cli-bridge.service` habilitado, escutando apenas em `127.0.0.1:8320`.
- Os 14 modelos antes publicados por `anthropic` foram registrados em
  `openai-compatibility` como `claude-cli`. As três credenciais OAuth diretas
  receberam `disabled: true`; seus arquivos e campos foram preservados.
  Demais providers e modelos, inclusive os Claude do Antigravity, não foram alterados.
- Os 20 testes Node passaram no Windows e no Linux da VPS.
- O primeiro teste real do Claude Code 2.1.270 na VPS retornou:
  `Failed to authenticate: OAuth session expired and could not be refreshed`.
- `claude auth status` indicava `loggedIn: true`; esse comando sozinho NÃO valida
  a sessão. A chamada real `-p` revelou a expiração.
- O teste HTTP real do adaptador, em porta temporária, chamou o CLI instalado e
  retornou `503 / claude_login_required`. O processo de teste foi encerrado.
- Após o usuário renovar o login, o erro de autenticação desapareceu e o CLI
  retornou `You've hit your weekly limit · resets 11am (Europe/Berlin)`.
  O adaptador foi corrigido para classificar essa mensagem como HTTP 429,
  código `claude_rate_limited`. O texto do CLI não informou o dia da renovação.
- Na instância isolada da versão 7.3.7, os três formatos de API
  (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`) devolveram 429 da rota
  `openai-compatible-claude-cli`, inclusive o cooldown do proxy.
- Após ativação, o catálogo ativo mostrou 14 modelos com `owned_by: claude-cli`.
  A chamada através da instância principal retornou `429 / claude_rate_limited`,
  com o recebimento registrado no journal do adaptador.
- A substituição atômica inicial do YAML não foi detectada pelo watcher do proxy.
  Foi necessário reiniciar somente `factory-chatgpt-proxy.service`. O helper foi
  corrigido para preservar o inode do YAML em futuras alterações e reversões.
- **Ainda não comprovado:** respostas bem-sucedidas, streaming de conteúdo e ciclo
  de ferramentas com a assinatura real, por causa do limite semanal. A ativação
  da rota não deve ser confundida com a validação desses fluxos.

## Backup e reversão

Backup privado da ativação:
`~/.local/share/cliproxy-claude-cli/backups/20260920T125724269595Z`.
Contém YAML original e cópias privadas das credenciais. Não enviar esses arquivos
para logs, chats ou repositórios.

Para reverter somente as mudanças desta ativação:

```sh
python3 ~/.local/share/cliproxy-claude-cli/activate.py rollback
```

O helper verifica se houve mudanças posteriores no YAML e bloqueia a reversão
nessa situação. Restaura os flags `disabled` originais sem sobrescrever tokens
que tenham sido renovados. O serviço lateral fica disponível, sem rota no proxy;
se desejado, pode ser parado separadamente após a reversão.

## Contrato e limites

- `POST /v1/chat/completions`, `GET /v1/models`, `GET /health`.
- `/health` indica apenas que o processo está disponível; não atesta o login.
- API protegida por chave local, listener somente em `127.0.0.1`.
- Conversa textual; entrada de imagem, áudio e parâmetros sem equivalente são
  rejeitados explicitamente. Não prometer paridade completa com a API Anthropic.
- Histórico é serializado em registros JSON com os papéis e IDs das ferramentas.
  Isso é uma adaptação de prompt; não é replay nativo de mensagens da API.
- Ferramentas do cliente são apresentadas ao modelo por saída estruturada
  (`--json-schema`), validadas e devolvidas como `tool_calls`. A execução permanece
  no cliente. As ferramentas nativas, MCPs, hooks e comandos locais são desligados.
- Texto sem ferramentas é enviado incrementalmente. Com ferramentas, o resultado
  estruturado é validado antes de emitir o conteúdo; SSE recebe comentários de
  espera a cada 15 segundos. Não há streaming incremental dos argumentos.
- `tool_choice`, ferramenta forçada e `parallel_tool_calls: false` são validados.
- Não há persistência de sessões/transcrições. Prompt chega por stdin; instruções
  temporárias usam `/dev/shm` na VPS e são removidas ao terminar/cancelar.
- Até três processos simultâneos; cada pedido tem timeout de cinco minutos.
- Logs contêm apenas ID, modelo, status e uso. Credenciais, prompts, ferramentas e
  respostas não são registrados pelo adaptador.
- A conta e os tokens OAuth continuam sendo gerenciados internamente pelo Claude
  Code. “Sem token” significa que o adaptador não usa o token diretamente.

## Validação local

```powershell
npm ci --ignore-scripts
npm test
# Na VPS Linux, para testar o helper de ativação/reversão:
python3 -m unittest discover -s test -p 'test_*.py'
```

Os testes usam processos reais com um CLI simulado para validar ciclo de vida,
isolamento, erros, timeout e cancelamento. Isso não substitui o teste real com a
assinatura Anthropic. O arquivo `fixtures/fake-cli.mjs` nunca é usado em produção.

## Preparação da VPS

Destino: `~/.local/share/cliproxy-claude-cli`. Instalar dependências com o Node 22 já
existente. Copiar `config.example.json` para `config.json`, gerar uma chave local
aleatória com permissão 0600 e instalar a unit separada somente após os testes.
Instalar o serviço lateral não exige reiniciar `factory-chatgpt-proxy`. Nesta
ativação, o proxy precisou de reinício para recuperar seu watcher de configuração.

Renovar a sessão oficial em terminal interativo:

```powershell
ssh -t SEU-SERVIDOR ~/.local/share/brivae-dev/node-22/bin/claude auth login --claudeai
```

## Integração que deve ser validada antes da ativação

1. Testar CLI direto com a conta renovada e cada modelo desejado. A lista exemplo
   foi obtida do catálogo atual do proxy; não comprova acesso pela assinatura.
2. Testar HTTP do adaptador: resposta simples; SSE; seleção de função com argumentos
   corretos; retorno de resultado da ferramenta e resposta final; cancelamento.
3. Subir instância temporária isolada da MESMA versão do CLIProxy, sem credenciais
   dos demais providers, e registrar este endpoint como `openai-compatibility`.
4. Testar através dessa instância `/v1/chat/completions`, `/v1/messages` e
   `/v1/responses`, incluindo ferramentas, sem substituir a instância ativa.
5. Só após sucesso, criar backup privado da configuração ativa e preparar a troca
   dos modelos Claude. Conferir conflitos com modelos de outros providers.
   Não deixar os OAuth Claude diretos concorrendo com as rotas do adaptador.
6. Contas antigas ficam preservadas e inativas; não apagar suas credenciais.
   Aplicar a troca de tráfego apenas após a validação real e autorização de ativação.

Trecho ilustrativo (a chave real nunca deve ir para este arquivo):

```yaml
openai-compatibility:
  - name: claude-cli
    base-url: http://127.0.0.1:8320/v1
    api-key-entries:
      - api-key: <chave-local-do-adaptador>
    models:
      - name: claude-haiku-4-5-20251001
        alias: claude-haiku-4-5-20251001
```

Documentação consultada:
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://github.com/router-for-me/CLIProxyAPI/blob/main/docs/sdk-advanced.md

Não usar `--bare`: a documentação atual informa que esse modo não lê o login OAuth
da assinatura. O isolamento é feito pelos controles específicos do CLI.
