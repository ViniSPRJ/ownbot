import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRuntimeInfo } from "../src/acp/runtime-info";

test("runtime DTO reports configured CLI without paths, credentials or a health claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "ownbot-runtime-info-"));
  const before = process.env.OPENBOT_ACP_CONFIG, privateBefore = process.env.OPENBOT_PRIVATE_AGENT_IDS;
  const file = join(dir,"profiles.json");
  try {
    process.env.OPENBOT_ACP_CONFIG = file;
    process.env.OPENBOT_PRIVATE_AGENT_IDS = "credito";
    writeFileSync(file,JSON.stringify({ profiles: { cli: { command:"/private/cli",workspaceRoot:"/private/work",provider:"claude",env:{TOKEN:"secret-value"} } },agents:{research:"cli",credito:"cli"} }));
    expect(agentRuntimeInfo("research",true)).toEqual({kind:"acp",provider:"claude",label:"Claude Code · ACP",model:null});
    expect(agentRuntimeInfo("credito",true)).toEqual({kind:"private_local",label:"Modelo local privado"});
    expect(agentRuntimeInfo("unmapped",true).kind).toBe("api");
    expect(agentRuntimeInfo("research",false).kind).toBe("acp");
    expect(agentRuntimeInfo("unmapped",false).kind).toBe("remote");
    writeFileSync(file,"invalid config including secret-value");
    expect(agentRuntimeInfo("research",true)).toEqual({kind:"unavailable",label:"Configuração ACP indisponível"});
    expect(JSON.stringify(agentRuntimeInfo("research",true))).not.toContain("secret-value");
  } finally {
    if (before === undefined) delete process.env.OPENBOT_ACP_CONFIG; else process.env.OPENBOT_ACP_CONFIG = before;
    if (privateBefore === undefined) delete process.env.OPENBOT_PRIVATE_AGENT_IDS; else process.env.OPENBOT_PRIVATE_AGENT_IDS = privateBefore;
    rmSync(dir,{recursive:true,force:true});
  }
});
