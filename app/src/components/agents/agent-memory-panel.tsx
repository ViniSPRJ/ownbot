import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";

type Memory = { standingInstructions: string; notes: string; revision: number; updatedAt: string };
export function AgentMemoryPanel({ agentId }: { agentId: string }) {
  const key = ["agent-memory", agentId];
  const query = useQuery({ queryKey: key, queryFn: () => client<Memory | null>(`/api/agent-memory/${encodeURIComponent(agentId)}`, "memory") });
  const [editing, setEditing] = useState(false);
  const [standingInstructions, setStanding] = useState("");
  const [notes, setNotes] = useState("");
  const [revision, setRevision] = useState(0);
  const cache = useQueryClient();
  const save = useMutation({ mutationFn: () => client<Memory>(`/api/agent-memory/${encodeURIComponent(agentId)}`, "memory", { method: "PUT", body: { standingInstructions, notes, expectedRevision: revision } }), onSuccess: memory => { cache.setQueryData(key, memory); setEditing(false); } });
  if (query.isPending) return <p>Carregando memória…</p>;
  if (query.error) return <p role="alert">Não foi possível ler a memória. <Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></p>;
  return <section className="space-y-4">
    <p className="text-sm text-muted-foreground">Sua memória para este bot continua disponível após limpar uma conversa ou reiniciar o servidor. Você decide o que salvar. Ela não concede acesso a ferramentas.</p>
    {editing ? <>
      <label className="block text-sm" htmlFor="agent-standing">Instruções permanentes</label>
      <Textarea id="agent-standing" maxLength={6000} rows={6} value={standingInstructions} onChange={e => setStanding(e.target.value)} />
      <label className="block text-sm" htmlFor="agent-notes">Notas e contexto</label>
      <Textarea id="agent-notes" maxLength={6000} rows={6} value={notes} onChange={e => setNotes(e.target.value)} />
      <p className="text-xs text-muted-foreground">Até 6.000 caracteres por campo. Para limpar, salve os campos vazios.</p>
      {save.error ? <p role="alert">{save.error.message} Seu texto permanece aqui para você copiar antes de recarregar.</p> : null}
      <div className="flex gap-2"><Button disabled={save.isPending} onClick={() => save.mutate()}>Salvar memória</Button><Button variant="outline" disabled={save.isPending} onClick={() => { setEditing(false); save.reset(); void query.refetch(); }}>Cancelar e recarregar</Button></div>
    </> : <>
      <h3 className="font-medium">Instruções permanentes</h3><p className="text-sm whitespace-pre-wrap">{query.data?.standingInstructions || "Nenhuma instrução salva."}</p>
      <h3 className="font-medium">Notas e contexto</h3><p className="text-sm whitespace-pre-wrap">{query.data?.notes || "Nenhuma nota salva."}</p>
      <p className="text-xs text-muted-foreground">{query.data ? `Revisão ${query.data.revision} · ${new Date(query.data.updatedAt).toLocaleString("pt-BR")}` : "Memória ainda não criada."}</p>
      <Button onClick={() => { setStanding(query.data?.standingInstructions ?? ""); setNotes(query.data?.notes ?? ""); setRevision(query.data?.revision ?? 0); save.reset(); setEditing(true); }}>Editar minha memória</Button>
    </>}
  </section>;
}
