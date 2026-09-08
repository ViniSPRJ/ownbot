import { expect, test } from "bun:test";
import { createNewsEvidence, NewsEditorialError } from "../src/routines/news-evidence";
const now = Date.parse("2026-09-08T00:00:00Z");
const excerpt = "A análise do autor examina o custo de capital e a evolução do crédito, distinguindo fatos observados de projeções condicionais para o próximo trimestre.";
const valor = {url:"https://valor.globo.com/opiniao/coluna/analise.ghtml",title:"Uma análise dos juros",author:"Maria Silva",kind:"opinion",excerpt,useAs:"current"};
const ft = {...valor,url:"https://www.ft.com/content/abc",title:"Bonds and inflation",author:"John Smith"};
function capture(e: ReturnType<typeof createNewsEvidence>, item = valor, date = "2026-09-07T10:00:00-03:00", tool = "computer_read") {
  e.capture(tool,JSON.stringify({ok:true,url:item.url,title:item.title,text:`${item.title}\nOpinion\n${item.author}\nPublished: ${date}\n${excerpt}`,truncated:false}));
}
test("only a real article body and exact author/excerpt establish opinion coverage", async () => {
 const e=createNewsEvidence(now);
 expect(await e.tool.execute(valor)).toStartWith("Refused.");
 capture(e,valor,undefined,"computer_snapshot"); expect(await e.tool.execute(valor)).toStartWith("Refused.");
 capture(e); expect(await e.tool.execute({...valor,excerpt:"Invented article text that was never returned by the browser. ".repeat(4)})).toStartWith("Refused.");
 expect(JSON.parse(await e.tool.execute(valor)).registered).toBe(true);
 expect(()=>e.finalise(`[Valor](${valor.url})`)).toThrow("coluna de opinião do FT");
 capture(e,ft); await e.tool.execute(ft);
 expect(e.finalise(`[Valor](${valor.url}) [FT](${ft.url})`)).toContain("publicação na janela de 24h");
});
test("Valor general reporting cannot impersonate an opinion column even after being read", async () => {
 const e=createNewsEvidence(now); const reporting={...valor,url:"https://valor.globo.com/brasil/noticia/2026/09/07/report.ghtml"};
 capture(e,reporting); expect(await e.tool.execute(reporting)).toContain("not an opinion column");
 expect(()=>e.finalise(`[Valor](${reporting.url})`)).toThrow("editorial_coverage_incomplete");
});
test("old source cannot be registered as current and becomes explicit dated context", async () => {
 const e=createNewsEvidence(now); capture(e,valor,"2026-09-06T11:06:00-03:00"); capture(e,ft);
 expect(JSON.parse(await e.tool.execute(valor)).freshness).toBe("old"); await e.tool.execute(ft);
 let failure: NewsEditorialError|undefined; try {e.finalise(`[Valor](${valor.url}) [FT](${ft.url})`,"draft");}catch(error){failure=error as NewsEditorialError;}
 expect(failure).toBeInstanceOf(NewsEditorialError); expect(failure!.message).toContain("mais de 24h usada como atual");
 expect(failure!.draft).toContain("CONTEXTO ANTIGO"); expect(failure!.draft).toContain("2026-09-06T14:06:00.000Z"); expect(failure!.resultMessageId).toBe("draft");
 await e.tool.execute({...valor,useAs:"context"}); expect(e.finalise(`[Valor](${valor.url}) [FT](${ft.url})`)).toContain("não são notícias confirmadas nas últimas 24 horas");
});
test.each(["ontem", "06/09/2026 11h06", "2026-09-08T05:00:00Z", "2026-09-07T10:00:00"])("ambiguous/future/unzoned date stays unverified: %s", async date => {
 const e=createNewsEvidence(now); capture(e,valor,date);
 const result=JSON.parse(await e.tool.execute(valor)); expect(result.freshness).toBe("unverified");
 expect(()=>e.finalise(`[Valor](${valor.url})`)).toThrow("data de publicação não verificada");
});
test("dates embedded in article prose or multiple publication labels cannot certify freshness", async () => {
 const e=createNewsEvidence(now); const text=`${valor.title}\n${valor.author}\n${excerpt}\nThe report cites 2026-09-07T10:00:00Z as a future event.`;
 e.capture("computer_read",JSON.stringify({ok:true,url:valor.url,title:valor.title,text}));
 expect(JSON.parse(await e.tool.execute(valor)).freshness).toBe("unverified");
 e.capture("computer_read",JSON.stringify({ok:true,url:valor.url,title:valor.title,text:text+"\nPublished: 2026-09-07T10:00:00Z\nPublished: 2026-09-06T10:00:00Z\n"}));
 expect(JSON.parse(await e.tool.execute(valor)).freshness).toBe("unverified");
});
test("unknown citation or previous-run evidence cannot become certified by report prose", async () => {
 const first=createNewsEvidence(now);capture(first);await first.tool.execute(valor);
 const next=createNewsEvidence(now);
 expect(()=>next.finalise(`Li a coluna completa e tenho certeza da data. [Valor](${valor.url})`)).toThrow("citação sem registro de evidência");
});


test.each(["https://example.com/source", '<a href="https://example.com/source">source</a>'])("unregistered bare/HTML source cannot evade coverage: %s", value => {
 const e=createNewsEvidence(now);
 expect(()=>e.finalise(value)).toThrow("https://example.com/source: citação sem registro");
});
