import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/setup")({ component: Setup });
function Setup() {
  const [token, setToken] = useState(() => {
    try { return decodeURIComponent(window.location.hash.slice(1)).trim(); }
    catch { return ""; }
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    let enrollmentToken = token.trim();
    if (enrollmentToken.includes("#")) enrollmentToken = enrollmentToken.slice(enrollmentToken.indexOf("#") + 1);
    try { enrollmentToken = decodeURIComponent(enrollmentToken).trim(); } catch { /* Report invalid below. */ }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(enrollmentToken)) { setError("Cole o código completo do arquivo de primeiro acesso, ou o link completo de configuração."); return; }
    if (password !== confirm) { setError("As senhas precisam ser iguais."); return; }
    setPending(true); setError("");
    try {
      const response = await fetch("/api/local-auth/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: enrollmentToken, password }) });
      if (!response.ok) {
        const body = await response.json();
        if (body.error === "Invalid enrollment") throw new Error("Código de primeiro acesso inválido. Copie o código completo do arquivo privado e cole no campo acima. Sua senha ainda não foi criada.");
        throw new Error(typeof body.error === "string" ? body.error : "Não foi possível concluir.");
      }
      window.history.replaceState(null, "", "/setup");
      window.location.assign("/");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Não foi possível concluir."); setPending(false); }
  }
  return <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
    <h1 className="text-2xl font-medium">Proteja seu OpenBot</h1>
    <p className="my-4 text-sm text-muted-foreground">Escolha a senha do administrador. Seu histórico, bots e documentos continuam na mesma conta. Nos próximos acessos, entre com dev@openbot.local e esta senha.</p>
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm">Código de primeiro acesso <Input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required value={token} onChange={e => setToken(e.target.value)} /></label>
      <p className="text-sm text-muted-foreground">Se o link não funcionar, copie o código do arquivo privado e cole acima. Também pode colar o link completo.</p>
      <label className="block text-sm">Senha <Input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <label className="block text-sm">Confirmar senha <Input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
      <Button type="submit" disabled={pending || !token}>{pending ? "Salvando…" : "Salvar senha e entrar"}</Button>
      {!token && <p role="alert">Abra o link privado de configuração fornecido pelo administrador.</p>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
    </form>
  </main>;
}
