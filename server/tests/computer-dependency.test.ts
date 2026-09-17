import { expect, test } from "bun:test";
import { createSharedComputerProvider } from "../src/computer/provider";
import { ComputerUnavailableError, createComputerTransport } from "../src/computer/client";
import { computerReady, routineComputerPreflight, ComputerDependencyError } from "../src/routines/computer-dependency";
import { createHeadlessComputer } from "../src/routines/headless-computer";
import { createNewsEvidence } from "../src/routines/news-evidence";
import { createOperationsStore } from "../src/operations/store";

test("public health does not hide a rejected computer credential",async()=>{
 const paths:string[]=[];
 const provider=createSharedComputerProvider({baseUrl:"http://local",token:"test",
 fetchImpl:async(url,init)=>{paths.push(String(url));
 expect(new Headers(init?.headers).get("x-openbot-computer-token")).toBe("test");
 return String(url).endsWith("/health") ? Response.json({status:"ok"}) : Response.json({error:"unauthorized"},{status:401});}});
 expect(await computerReady(provider)).toBe(false);expect(paths).toHaveLength(2);
 await expect(routineComputerPreflight(provider)({agentId:"news"})).rejects.toBeInstanceOf(ComputerDependencyError);
 await routineComputerPreflight(provider)({agentId:"unrelated"});
});

test("computer readiness degrades independently of healthy SQL checks",async()=>{
 const db={execute:async()=>[{scheduler:true,notifications:true,runs:true,handoffs:true}]} as never;
 const health=await createOperationsStore(db,undefined,"internal",async()=>false).readiness();
 expect(health.status).toBe("degraded");expect(health.checks.computer).toBe(false);
});

test("an unavailable computer opens a bounded circuit across URLs and writes",async()=>{
 let calls=0;
 const computer=createHeadlessComputer({actorFor:id=>({id}),gateway:{navigate:async()=>{calls++;throw new ComputerUnavailableError("unreachable","computer_unreachable");},writeFile:async()=>{throw new Error("must not reach writes");}} as never});
 const invoke=(name:string,args:unknown,botId="news")=>computer.call({name,args,botId,ownerUserId:"u",toolCallId:"test"});
 expect((await invoke("computer_navigate",{url:"https://example.com"})).unavailable).toBe(true);
 const second=await invoke("computer_navigate",{url:"https://example.org"});
 expect(second.circuitOpen).toBe(true);expect(second.retryable).toBe(false);
 expect((await invoke("computer_write_file",{path:"x",contents:"y"})).circuitOpen).toBe(true);
 expect(calls).toBe(1);
 await invoke("computer_navigate",{url:"https://example.org"},"other");expect(calls).toBe(2);
});

test("transport cancellation is not a claim that the computer is stopped",async()=>{
 const ctrl=new AbortController();
 const transport=createComputerTransport({fetchImpl:async()=>{ctrl.abort();throw new Error("private network details");}});
 try {await transport.call("http://local","news","/navigate",undefined,ctrl.signal);throw new Error("expected rejection");}
 catch(e){expect(e).toBeInstanceOf(ComputerUnavailableError);expect((e as ComputerUnavailableError).code).toBe("computer_cancelled");expect(String(e)).not.toContain("private network");}
});

test("an observed computer outage is an infrastructure failure, with editorial draft retained",()=>{
 const evidence=createNewsEvidence();
 evidence.capture("computer_navigate",JSON.stringify({ok:false,unavailable:true,code:"computer_unreachable"}));
 try{evidence.finalise("Briefing parcial sem cobertura web.","receipt");throw new Error("expected rejection");}
 catch(e){expect(e).toBeInstanceOf(ComputerDependencyError);expect((e as ComputerDependencyError).draft).toContain("Briefing parcial");expect((e as ComputerDependencyError).resultMessageId).toBe("receipt");}
});

test("an individual page failure does not trip the computer circuit or blame infrastructure",async()=>{
 let calls=0;
 const computer=createHeadlessComputer({actorFor:id=>({id}),gateway:{navigate:async()=>{calls++;throw new ComputerUnavailableError("page DNS failure","computer_action_failed");}} as never});
 const input={botId:"news",ownerUserId:"u",name:"computer_navigate",args:{url:"https://example.com"},toolCallId:"x"};
 expect((await computer.call(input)).unavailable).toBeUndefined();
 await computer.call(input);expect(calls).toBe(2);
});
