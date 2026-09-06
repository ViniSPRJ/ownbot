#!/usr/bin/env python3
"""Watch OpenBot routine runs and report each finished one to the owner's Telegram via the notify MCP (VPS)."""
import json, os, subprocess, time, urllib.request
STATE = os.path.expanduser("~/.openbot-routine-notify.json")
TOKEN = open(os.path.expanduser("~/openbot/.secrets/notify.token")).read().strip()
MCP = "https://arcus-nexus-hostinger.tail3c3777.ts.net:18861/mcp"
def psql(sql):
    p = subprocess.run(["docker", "exec", "-i", "openbot-postgres-1", "psql", "-U", "openbot", "-d", "openbot", "-tA", "-F", "\x1f"], input=sql, capture_output=True, text=True, timeout=30)
    return [l.split("\x1f") for l in p.stdout.splitlines() if l]
def report(**args):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "routine_report", "arguments": args}}
    req = urllib.request.Request(MCP, data=json.dumps(body).encode(), headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json", "accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=120) as r: return json.loads(r.read())
def load():
    try: return json.load(open(STATE))
    except Exception: return {"since": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "seen": []}
def save(st): json.dump(st, open(STATE, "w"))
st = load(); print(json.dumps({"type": "routine-notify", "since": st["since"]}), flush=True)
while True:
    try:
        rows = psql(f"""select rr.id, rr.routine_id, rr.status, coalesce(rr.error,''), coalesce(r.agent_id,'?'), coalesce(r.channel_id,''), coalesce(left(r.instruction,60),''),
            coalesce(c.name,''), coalesce(c.last_message,''), coalesce(c.last_message_agent_id,''), coalesce(extract(epoch from c.last_message_at)::text,'0'), extract(epoch from rr.finished_at)::text
            from routine_runs rr left join routines r on r.id=rr.routine_id left join channels c on c.id=r.channel_id
            where rr.finished_at is not null and rr.finished_at > '{st["since"]}' and rr.status in ('succeeded','failed') order by rr.finished_at""")
        for run_id, routine_id, status, error, agent, channel_id, instr, cname, last_msg, last_agent, last_at, fin_at in rows:
            if run_id in st["seen"]: continue
            if status == "succeeded" and last_agent == agent and abs(float(last_at or 0) - float(fin_at or 0)) < 60:
                text = last_msg
            elif status == "succeeded":
                text = "Rotina executada; resposta não localizada no canal (abra o canal para ler)."
            else:
                text = error or "erro não informado"
            name = instr.split("\n")[0].strip(" .:") or routine_id
            try:
                out = report(routine=name, agent=agent, channel=cname or channel_id, text=text, status=status)
                print(json.dumps({"type": "routine-notify", "run": run_id, "status": status, "sent": str(out.get("result", {}))[:120]}), flush=True)
            except Exception as e:
                print(json.dumps({"type": "routine-notify", "run": run_id, "error": type(e).__name__}), flush=True)
            st["seen"] = (st["seen"] + [run_id])[-200:]; save(st)
    except Exception as e:
        print(json.dumps({"type": "routine-notify", "loop_error": type(e).__name__}), flush=True)
    time.sleep(30)
