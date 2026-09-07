# Infra e Onyx — implantação restrita

Verificação em 2026-09-06 no Beelink via Tailscale: catálogo OpenBot contém pi-m4,
pi-m5, quantbrasil, vps-ops, notify e routines. O vps-ops anuncia status, health,
logs, disk, restart e hermes_cron. Os três primeiros concedidos ao Infra são
**status, health e disk**; logs foi excluído porque pode expor conteúdo sensível.
Restart e hermes_cron nunca são concedidos ao novo coworker. Coord mantém suas
concessões anteriores. Não foi confirmado que o alvo vps-ops é Hostinger;
o coworker precisa citar o host efetivamente retornado.

O container Onyx existe, mas não há conector de busca Onyx configurado no OpenBot.
O onyx-a0-bridge encontrado é Onyx → Agent Zero, com execução arbitrária; não é
RAG e não deve ser usado para esta integração. A API Onyx instalada possui
POST /admin/search com filtros de ACL do usuário e exigência curator/admin;
reutilizar um PAT administrativo compartilhado não equivale a preservar as
permissões de cada pessoa. A próxima integração exige credencial apropriada e
busca comprovada com teste de isolamento por usuário. O coworker e canal deixam
**conexão pendente** visível e só analisam documentos fornecidos na conversa.

Nenhum endpoint de recibos Nexus FX foi configurado/verificado no catálogo. A
skill `nexus-fx-status-read-only` interpreta apenas recibos fornecidos, marca a
fonte e o instante observados; não é um monitor ativo. Não importa instruções
históricas de FX pause, Hostinger home base ou exclusão de máquina como política.

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
   conceder exatamente os três MCP via API auditada. Sem --apply só planeja.
5. Validar recusas no gateway para infra/restart, infra/hermes_cron, infra/computer
   e onyx/computer, e resposta real para infra/status. Não executar ferramentas
   mutantes para testar: usar decisões da política e testes de gateway.
6. Autorizar handoffs explícitos coord↔infra e coord↔onyx pela API de Bots se não
   estiverem presentes. Canais não concedem automaticamente peer handoffs.

A regra CEL também bloqueia qualquer outro MCP futuro e qualquer computador para
os dois novos IDs, mesmo se alguém der grants amplos depois. Onyx não recebe nem
mesmo a exceção vps-ops. Outros bots continuam com as regras anteriores. Skills e
prompts sozinhos não estabelecem esse limite. Relatos de Infra ao Coord são
achados e propostas: não autorizam remediação autônoma por outro agente.

Não há transação HTTP entre policy e grants. A ordem mantém falha fechada: uma
falha posterior deixa a política restrita; verificar o erro, sem afrouxar a regra.
A API não oferece compare-and-swap; a releitura prévia detecta mudanças já visíveis,
mas requer janela com escritor único para excluir corrida de configuração.
