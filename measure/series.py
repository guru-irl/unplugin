import subprocess,threading,json,time,os,platform,statistics,itertools
from pathlib import Path
out=Path('results');out.mkdir(exist_ok=True)
def rss(pid):
 try:
  if platform.system()=='Linux':
   return int(next(l for l in Path(f'/proc/{pid}/status').read_text().splitlines() if l.startswith('VmRSS:')).split()[1])/1024
  return int(subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True).strip())/1024
 except (OSError,ValueError,StopIteration,subprocess.CalledProcessError): return 0
for pair in range(1,11):
 arms=['base','native'] if pair%2 else ['native','base']
 for phase in (['cold','warm','edit'] if platform.system()=='Linux' else ['cold','edit']):
  samples={}
  for arm in arms:
   log=out/f'{pair}-{phase}-{arm}.log'
   p=subprocess.Popen(['node','--max-old-space-size=8192','run.mjs',arm,phase,str(pair)],stdout=subprocess.PIPE,stderr=open(log,'w'),text=True)
   peak=[0.0];active=[False];done=threading.Event()
   def sample():
    while not done.wait(.01 if platform.system()=='Linux' else .05):
     if active[0]:peak[0]=max(peak[0],rss(p.pid))
   thread=threading.Thread(target=sample);thread.start();result=None
   for line in p.stdout:
    if not line.startswith('{'):continue
    event=json.loads(line)
    if event['event']=='start':active[0]=True;peak[0]=rss(p.pid)
    elif event['event']=='endpoint':active[0]=False;peak[0]=max(peak[0],event['end_rss_mib'])
    elif event['event']=='result':result=event
   rc=p.wait();done.set();thread.join()
   if rc or result is None:raise RuntimeError(f'{arm} {phase} {pair}: {rc}, {log.read_text()}')
   result['peak_rss_mib']=peak[0];result['os']=platform.system();samples[arm]=result
   with (out/'samples.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
   print(json.dumps(result),flush=True)
  assert samples['base']['output_sha256']==samples['native']['output_sha256'],samples
  for arm in arms:
   if phase=='edit':
    import shutil
    shutil.rmtree(Path('cache')/f'{arm}-{pair}')
# Exact signed-rank interval: Walsh averages indexed by the exact subset-sum
# distribution of ranks 1..n. At n=10, critical W=8 gives >=95% coverage.
rows=[json.loads(l) for l in (out/'samples.jsonl').read_text().splitlines()]
summary=[]
for phase in sorted(set(r['phase'] for r in rows)):
 base=[r for r in rows if r['phase']==phase and r['arm']=='base'];native=[r for r in rows if r['phase']==phase and r['arm']=='native'];base.sort(key=lambda r:r['pair']);native.sort(key=lambda r:r['pair'])
 for metric in ['wall_ms','cpu_ms','peak_rss_mib','end_rss_mib']:
  deltas=[b[metric]-a[metric] for a,b in zip(base,native)];n=len(deltas);dist=[sum(c) for mask in range(1<<n) for c in [[i+1 for i in range(n) if mask>>i&1]]];critical=max(k for k in range(sum(range(1,n+1))+1) if sum(w<=k for w in dist)/len(dist)<=.025)
  walsh=sorted((a+b)/2 for i,a in enumerate(deltas) for b in deltas[i:]);lo,hi=walsh[critical],walsh[-critical-1]
  row=dict(os=platform.system(),phase=phase,metric=metric,base=statistics.median(r[metric] for r in base),native=statistics.median(r[metric] for r in native),paired_median=statistics.median(deltas),lower=lo,upper=hi,critical=critical,coverage=1-2*sum(w<=critical for w in dist)/len(dist));summary.append(row)
(out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
if any(r['lower']>0 for r in summary if r['metric'] in ['peak_rss_mib','end_rss_mib']):raise RuntimeError('Memory increase: stop')
