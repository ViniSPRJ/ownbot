# Integração futura: adaptador Hermes CLI (ACP)

**Estado:** não implementado. Não há perfil ACP Hermes no OpenBot, não há mapeamento de agentes e o default nativo do Hermes permanece Qwen3.6 27B. Este documento descreve o menor adaptador seguro da fase seguinte. Não ativa o binário nativo, não enfraquece o guard HTTP e não substitui a fila de filhos do OpenBot.

O `hermes-acp` nativo já está instalado no Beelink. Não é necessário download.

## Factos verificados pelo operador (SSH)

No Beelink, no repositório `~/.hermes/hermes-agent`:

| Verificação | Resultado |
| --- | --- |
| Commit | `85d4415` |
| `venv/bin/hermes-acp --version` | `0.21.3` |
| `venv/bin/hermes-acp --check` | `Hermes ACP check OK` |

`--check` só importa `acp` e `HermesACPAgent` e imprime essa frase (`acp_adapter/entry.py` 90, 108–112). É verificação de dependências/import, **não** conclusão ponta a ponta. A ajuda instalada de `hermes -z` / oneshot indica auto-bypass de aprovações; oneshot **não** é substituto do adaptador ACP.

O default Qwen3.6 27B do Hermes instalado **não muda**.

## Evidência no código instalado (relativa ao repositório Hermes)

Sessão ACP, persistência, cancelamento e modelo:

- `session/new`: `acp_adapter/server.py` 588–591 chama `SessionManager.create_session` (`acp_adapter/session.py` 167–174).
- Carga persistente: sessões vão para `SessionDB` em `$HERMES_HOME/state.db` (predefinição `~/.hermes/state.db`; `session.py` 1–5, 154–156, 271–283). `get_session` restaura após restart (`session.py` 177–181, 336–371). `session/load` em `server.py` 593–601.
- Restaurar sessão: usar `session/load`, **não** resume. O resume nativo cria uma sessão nova se o id não existir (`acp_adapter/server.py` 603–611).
- Persistência incompleta: modos de edição e opções de config **não** são persistidos; restrições têm de ser reaplicadas na sessão restaurada.
- Cancelamento: `server.py` 613–628 (`cancel_event` + `request_hard_interrupt`).
- Modelo: `server.py` 309–347 (`_switch_model` via `hermes_cli.model_switch.switch_model`) e 952–965 (`session/set_model`). `SetSessionModelResponse()` não devolve o modelo resolvido.

Superfície de ferramentas nativa (além do MCP scoped do OpenBot):

- `_make_agent` activa o toolset `hermes-acp` de forma hardcoded (`session.py` 396–398, via `_expand_acp_enabled_toolsets` 103–108).
- `toolsets.py` 184–191: `hermes-acp` é a postura *coding* sem `clarify`. `_HERMES_CORE_TOOLS` (`toolsets.py` 11–40) inclui `terminal`, `write_file` e `delegate_task`; esses nativos permanecem no ACP.
- `register_session_mcp` (`server.py` 410–447) **acrescenta** `mcp-<nome>` ao toolset existente; não o substitui. Refresh tardio (`server.py` 449–498) pode **adicionar** ferramentas depois do `initialize`.

Capacidade HTTP e arranque:

- `initialize` (`server.py` 502–523) anuncia `load_session`, imagem e fork/list/resume. **Não** anuncia `mcpCapabilities.http`, embora `register_session_mcp` aceite `McpServerHttp`. O anúncio de resume não autoriza o seu uso: o adaptador deve usar `session/load` (ver `server.py` 603–611).
- O OpenBot recusa esse `initialize`: `server/src/acp/agent.ts` 158–160 exige `agentCapabilities.mcpCapabilities.http`.
- `entry.py` 74–85 carrega `.env` de `HERMES_HOME` (predefinição `~/.hermes`). `HERMES_ACP_SKIP_CONFIGURED_MCP=1` (`entry.py` 191–197) só omite a descoberta MCP de `config.yaml` no arranque; **não** é sandbox nem allowlist de ferramentas.

Resolução de provider no ACP nativo pode cair no default (`session.py` 401–410: `except` → “falling back to default provider resolution”). Isolar o home do operador é obrigatório: `get_hermes_home()` (`hermes_constants.py` 101–108) usa `HERMES_HOME` ou `~/.hermes`, com aviso se o perfil activo não for o default. Sessões atendidas pelo mesmo processo compartilham o `HERMES_HOME` e o registry; o desenho exige **um processo filho ACP por tarefa/sessão OpenBot com âmbito**, salvo prova de que o scoping no processo partilhado isola de facto.

## Por que o nativo não pode ser ligado agora

1. **Guard HTTP do OpenBot.** Sem `mcpCapabilities.http` no `initialize`, `agent.ts` 160 falha fechado (`cause: mcp_http` em `server/src/acp/failure.ts`). Não relaxar este guard global.
2. **Ferramentas nativas.** `hermes-acp` traz terminal, escrita e `delegate_task` para além da ponte MCP scoped. Refresh tardio e `session/load` podem alargar a superfície. Modos de edição e opções de config não sobrevivem à persistência; o wrapper precisa reaplicar e verificar as restrições após cada load.
3. **Sem perfil Hermes.** `server/src/acp/config.ts` só admite `provider` `codex` | `claude` | `grok` | `pi`. Activar o binário nativo com o `HOME` do serviço seria um perfil inseguro.
4. **Filhos.** `delegate_task` nativo não passa pela fila `message_bot` do OpenBot. A fila e os handoffs continuam a ser do OpenBot (`docs/architecture.md`, `docs/beelink-operations.md`). Um `HERMES_HOME`/registry partilhado exige um filho ACP por tarefa/sessão OpenBot com âmbito, salvo scoping comprovado.
5. **Oneshot `-z`.** Bypass de aprovações na ajuda instalada; inadequado como runtime ownbot.
6. **Modelo.** `set_session_model` não confirma o id resolvido; `_make_agent` pode cair no default. Falha tem de ser fechada, sem fallback silencioso para outro provider ou para a API.
7. **`--check`.** Não prova turno, MCP, restrição de ferramentas nem isolamento.
8. **UID/sandbox.** Filtro ACP não é isolamento de SO. Filhos ACP no Beelink partilham o UID do serviço (`docs/operations/reliability-recovery.md`). Essa fronteira é **outra** fase.

## Desenho mínimo da fase seguinte

Reutilizar o runtime ACP nativo (`venv/bin/hermes-acp`, 0.21.3, commit `85d4415`) através de um **wrapper explícito e limitado**, sem baixar outro binário e sem alterar o default Qwen3.6 27B do Hermes do operador.

O wrapper, e só o wrapper, deve:

- apontar `HERMES_HOME` (e config) para um home **isolado**, não `~/.hermes` do operador;
- lançar **um processo filho ACP por tarefa/sessão OpenBot com âmbito**, para evitar o compartilhamento de registry entre âmbitos; não reutilizar um único filho ACP entre tarefas/sessões salvo scoping comprovado;
- fixar provider **local**, sem fallback (`session.py` 401–410 não pode escolher outro destino);
- passar allowlist de ambiente (não herdar credenciais/HOME do serviço);
- forçar superfície **só MCP** em `session/new`, `session/load`, mudança de modelo e refresh tardio — nativos `terminal` / `write_file` / `delegate_task` ausentes;
- restaurar com `session/load`, **não** resume: o resume nativo cria sessão nova se o id faltar (`acp_adapter/server.py` 603–611);
- reaplicar restrições (superfície só MCP, modos de edição, opções de config) na sessão restaurada — esses valores **não** são persistidos;
- recusar `delegate_task` nativo; filhos só pela fila OpenBot (`message_bot`);
- verificar o modelo **devolvido** pela sessão contra o pedido; divergência ou erro = falha fechada, sem fallback API/provider;
- mapear `stopReason` `cancelled` / timeout / `unknown` de forma explícita (`agent.ts` 222–223 já trata não-`end_turn` como falha de turno).

Fora de âmbito nesta fase: enfraquecer `agent.ts` 160; activar perfil nativo inseguro; isolamento UID/container (fase posterior distinta).

## Aceitação (fase seguinte)

1. Testes com provider e MCP falsos.
2. Depois, recibo isolado de ferramenta **read-only** real.
3. Ferramentas nativas ausentes; ferramenta proibida recusada.
4. Refresh MCP tardio **não** alarga a superfície.
5. `session/load` após restart reaplica restrições (modos de edição/config não persistidos) e mantém histórico. Resume nativo não é caminho de restauro (`server.py` 603–611).
6. Cancelamento, timeout e `unknown` visíveis; nunca sucesso silencioso.
7. Mismatch/erro de modelo nunca faz fallback silencioso.
8. Sem fuga de credenciais nem do `HOME` do operador. Um filho ACP por tarefa/sessão OpenBot com âmbito, salvo scoping comprovado.
9. Default Hermes Qwen3.6 27B inalterado.
10. `--check` continua a contar só como check de dependência, não como conclusão E2E.

## Estado desta fase

Documentação apenas. Sem alteração de código, produção, perfis ACP, default de modelo ou guard HTTP. Integração nativa permanece não implementada. Próximo trabalho: implementar o wrapper limitado e passar a aceitação acima; UID/sandbox noutro marco.
