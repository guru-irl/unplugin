import os,subprocess,threading,json,time,platform,statistics,re,shutil
from pathlib import Path
kind=os.environ['FILTER_KIND'];out=Path('round2-results')/kind;out.mkdir(parents=True,exist_ok=True)
def rss(pid):
 try:return int(subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True).strip())/1024
 except (ValueError,subprocess.CalledProcessError):return 0

def footprint(pid,label):
 start=time.monotonic();p=subprocess.run(['/usr/bin/vmmap','-summary',str(pid)],capture_output=True,text=True)
 (out/f'{label}-vmmap.txt').write_text(p.stdout+p.stderr)
 if p.returncode:raise RuntimeError(f'vmmap failed {p.returncode}: {p.stderr}')
 match=re.search(r'^Physical footprint:\s*([0-9.]+)\s*([KMGT]?)',p.stdout,re.M)
 if not match:raise RuntimeError(f'Physical footprint missing: {p.stdout[:2000]}')
 factor={'':1/1048576,'K':1/1024,'M':1,'G':1024,'T':1048576}[match[2]]
 return float(match[1])*factor,(time.monotonic()-start)*1000

print('Physical footprint is END/GC/idle only; vmmap is intrusive full-map inspection, not a cheap 250 ms sampler.',flush=True)
for pair in range(1,11):
 samples={}
 for arm in (['base','native'] if pair%2 else ['native','base']):
  label=f'{pair}-{arm}'
  with (out/f'{label}.log').open('w') as stderr:
   p=subprocess.Popen(['node','--expose-gc','--max-old-space-size=8192','diagnostic-run.mjs',arm,'cold',str(pair)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True,bufsize=1)
   peak=[0.0];active=[False];done=threading.Event();snapshots={}
   def sample():
    while not done.wait(.05):
     if active[0]:peak[0]=max(peak[0],rss(p.pid))
   thread=threading.Thread(target=sample);thread.start();result=None
   try:
    for line in p.stdout:
     if not line.startswith('{'):continue
     event=json.loads(line)
     if event['event']=='start':active[0]=True;peak[0]=rss(p.pid)
     elif event['event']=='snapshot':
      active[0]=False;stage=event['stage'];event['ps_rss_mib']=rss(p.pid)
      if stage=='end':peak[0]=max(peak[0],event['ps_rss_mib'])
      event['footprint_mib'],event['vmmap_ms']=footprint(p.pid,f'{label}-{stage}')
      snapshots[stage]=event;p.stdin.write(stage+'\n');p.stdin.flush()
     elif event['event']=='result':result=event
    rc=p.wait()
   finally:
    done.set();thread.join()
    if p.poll() is None:p.kill();p.wait()
   if rc or result is None:raise RuntimeError(f'{label} failed {rc}: {(out/f"{label}.log").read_text()}')
   result['peak_rss_mib']=peak[0];result['snapshots']=snapshots;result['os']=platform.system();samples[arm]=result
   with (out/'samples.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
   print(json.dumps(result),flush=True)
  shutil.rmtree(Path('cache')/f'{kind}-{arm}-{pair}')
 assert samples['base']['output_sha256']==samples['native']['output_sha256'],samples

print('Diagnostic only, no gate evaluation.',flush=True)
