import {test,expect} from "bun:test";
import {handoffStatus,type Handoff} from "./executions";
const hop: Handoff = {id:"h",event:"agent.handoff_delivered",at:"",from:"a",to:"b",run:null,workKey:"job"};
test("legacy acceptance cannot imply returned answer",()=>expect(handoffStatus(hop)).toContain("não confirmado"));
test("saved answer and processed relay are separate states",()=>{
 expect(handoffStatus({...hop,resultAvailable:true,returnQueued:true})).toBe("Resposta salva; retorno enfileirado");
 expect(handoffStatus({...hop,isReturn:true})).toBe("Retorno processado pelo solicitante");
});
test("reconciled hops do not claim the original delivery",()=>expect(handoffStatus({...hop,event:"agent.handoff_reconciled"})).toBe("Reconciliada; entrega original não confirmada"));
