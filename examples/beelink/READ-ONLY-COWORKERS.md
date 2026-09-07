# Infra e Onyx — implantação restrita

Verificação em 2026-09-06 no Beelink via Tailscale: catálogo OpenBot contém pi-m4,
pi-m5, quantbrasil, vps-ops, notify e routines. O vps-ops anuncia status, health,
logs, disk, restart e hermes_cron. Os três primeiros concedidos ao Infra são
**status, health e disk**; logs foi excluído porque pode expor conteúdo sensível.
Restart e hermes_cron nunca são concedidos ao novo coworker. Coord mantém suas
concessões anteriores. Não foi confirmado que o alvo vps-ops é Hostinger;
o coworker precisa citar o host efetivamente retornado.

O conector `onyx/search` usa a API instalada do Onyx com a identidade explicitamente
vinculada à pessoa autenticada no ownbot. Confere `/me` em cada busca e mantém as
ACLs da conta Onyx. Uma concessão sem esse vínculo é recusada; o token do administrador
não é disponibilizado a outras pessoas. Busca por palavras-chave, sem expansão ou
resposta por LLM; o modelo escolhido para o coworker continua independente.
Configuração e testes: [Onyx](../../docs/onyx-integration.md).

O conector `nexus-fx/status` lê somente um snapshot projetado no Nexus, por SSH com
comando obrigatório e identidade dedicada. Retorna recibos e validade de cotações
separadamente. Fonte atual `codex-fx`; não chamar esses recibos de Grok. HOLD não
prova saúde, cotação atual nem ausência de posições. Sem submissão de decisões,
ordens ou alteração de flags. Instalação: [Nexus FX](../../docs/nexus-fx-integration.md).

## Aplicação pelo operador

1. Fazer backup e garantir um único escritor de configuração durante aplicação.
2. Antes de expor os novos coworkers, aplicar a fronteira CEL em modo enforce:
   `OPENBOT_ADMIN_COOKIE_FILE=/caminho/privado/cookie python3 examples/beelink/apply-read-only-boundary.py --apply --policy-only`.
   O arquivo contém somente o cabeçalho Cookie da sessão administradora, chmod 600.
   Nunca imprimir/copiar o cookie para logs ou argumentos. URL padrão loopback no
   Beelink; para acesso remoto usar URL HTTPS da Tailnet via `--url`.
3. Reiniciar a API com `TENANT_PACKAGE_DIR` apontando ao pacote existente. O
   `server/src/index.ts` chama `loadTenantPackage` e `synchronizeTenantPackage` no
   boot. Isso cria/atualiza os coworkers, canais e skills, **não** concede MCP.
   Verificar os avisos de preservação de customizações antes de afirmar sucesso.
4. Executar o mesmo script com `--apply` (sem policy-only). Ele preserva regras
   anteriores, recusa modo dry-run global, salva/verifica fronteira antes de
   conceder exatamente os três MCP do Infra via API auditada. Os conectores Onyx e FX
   exigem configuração de identidade e seus grants exatos separados. Sem --apply só planeja.
5. Validar recusas no gateway para infra/restart, infra/hermes_cron, infra/computer
   e onyx/computer, e resposta real para infra/status. Não executar ferramentas
   mutantes para testar: usar decisões da política e testes de gateway.
6. Autorizar handoffs explícitos coord↔infra e coord↔onyx pela API de Bots se não
   estiverem presentes. Canais não concedem automaticamente peer handoffs.

A regra CEL também bloqueia qualquer outro MCP futuro e qualquer computador para
os dois novos IDs, mesmo se alguém der grants amplos depois. Onyx recebe somente a exceção `onyx/search` de leitura, sem vps-ops. Outros bots continuam com as regras anteriores. Skills e
prompts sozinhos não estabelecem esse limite. Relatos de Infra ao Coord são
achados e propostas: não autorizam remediação autônoma por outro agente.

Não há transação HTTP entre policy e grants. A ordem mantém falha fechada: uma
falha posterior deixa a política restrita; verificar o erro, sem afrouxar a regra.
A API não oferece compare-and-swap; a releitura prévia detecta mudanças já visíveis,
mas requer janela com escritor único para excluir corrida de configuração.
