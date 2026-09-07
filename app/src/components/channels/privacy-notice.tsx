import { useQuery } from "@tanstack/react-query";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
export function PrivacyNotice({agentId}: {agentId?: string}) {
  const active = useDeclaredBotId();
  const selected = agentId ?? active;
  const query = useQuery(deploymentCapabilitiesQueryOptions());
  if (!selected) return <p className="border-b px-4 py-2 text-xs text-muted-foreground">Pesquisa pública: não inclua documentos ou informações privadas. Para esse conteúdo, escolha um bot identificado como privado.</p>;
  const privateMode = query.data?.privateAgentIds.includes(selected) === true;
  return <p className="border-b px-4 py-2 text-xs text-muted-foreground" role="note">{privateMode
    ? "Conversa privada · processamento em modelo local · sem pesquisa web ou repasse a bots públicos."
    : "Pesquisa pública · pode usar serviços externos. Não inclua documentos ou informações privadas nesta conversa."}</p>;
}
