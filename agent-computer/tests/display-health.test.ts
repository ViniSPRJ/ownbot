import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayAvailable, probeDisplaySocket } from "../src/display-health";
test("headless does not require X; invalid headed display fails closed",async()=>{
 expect(await displayAvailable({})).toBe(true);
 expect(await displayAvailable({COMPUTER_HEADED:"on",DISPLAY:"remote:99"})).toBe(false);
});
test("a stale display artifact cannot satisfy health; a listening X socket can",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ownbot-display-test-"));const path=join(dir,"X99");
 try {
  writeFileSync(path,"stale"); expect(await probeDisplaySocket(path)).toBe(false);rmSync(path);
  const server=createServer(socket=>socket.destroy());
  await new Promise<void>(resolve=>server.listen(path,resolve));
  try{expect(await probeDisplaySocket(path)).toBe(true);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  expect(await probeDisplaySocket(path)).toBe(false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
