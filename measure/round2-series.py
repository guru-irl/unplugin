import subprocess,threading,json,time,os,platform,statistics,itertools
from pathlib import Path
kind=os.environ['FILTER_KIND'];out=Path('round2-results')/kind;out.mkdir(parents=True,exist_ok=True)
def rss(pid):
 try:
  if platform.system()=='Linux':
   return int(next(l for l in Path(f'/proc/{pid}/status').read_text().splitlines() if l.startswith('VmRSS:')).split()[1])/1024
  return int(subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True).strip())/1024
 except (OSError,ValueError,StopIteration,subprocess.CalledProcessError): return 0
for pair in range(1,11):
 arms=['base','native'] if pair%2 else ['native','base']
 for phase in ['cold','warm']:
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
   if phase=='warm':
    import shutil
    shutil.rmtree(Path('cache')/f'{kind}-{arm}-{pair}')

print('Diagnostic only, no gate evaluation.',flush=True)
