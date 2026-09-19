#!/usr/bin/env python3
"""Consistent PostgreSQL + SQLite backup; never reads or prints credentials."""
import argparse,datetime,json,os,pathlib,sqlite3,subprocess

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--output',required=True)
    p.add_argument('--container',default='openbot-postgres-1');p.add_argument('--database',default='openbot');p.add_argument('--user',default='openbot')
    a=p.parse_args();root=pathlib.Path(a.root).resolve();out=pathlib.Path(a.output).resolve()
    os.umask(0o077);out.mkdir(parents=True,exist_ok=False)
    try:
        with (out/'postgres.dump').open('wb') as f:
            subprocess.run(['docker','exec',a.container,'pg_dump','-U',a.user,'-d',a.database,'-Fc'],stdout=f,stderr=subprocess.PIPE,check=True)
        with (out/'postgres.dump').open('rb') as f:
            subprocess.run(['docker','exec','-i',a.container,'pg_restore','--list'],stdin=f,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
        source=root/'.data/threads.db'
        with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as src,sqlite3.connect(out/'threads.db') as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('SQLite backup integrity check failed')
        revision=subprocess.run(['git','-C',str(root),'rev-parse','HEAD'],text=True,capture_output=True,check=True).stdout.strip()
        (out/'manifest.json').write_text(json.dumps({'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'revision':revision,'postgres_archive_checked':True,'sqlite_integrity':'ok'},indent=2))
        print(json.dumps({'backup':str(out),'verified':True}))
    except Exception as e:
        (out/'INCOMPLETE').write_text(type(e).__name__+'\n')
        raise SystemExit('Backup failed; incomplete directory retained for inspection') from None
if __name__=='__main__':main()
