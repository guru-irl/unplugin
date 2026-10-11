import json,statistics,platform
from pathlib import Path
out=Path('round2-results'); summary=[]
for kind in ['glob','regexp','hook-shapes']:
 rows=[json.loads(l) for l in (out/kind/'samples.jsonl').read_text().splitlines()]
 for phase in sorted(set(r['phase'] for r in rows)):
  base=sorted([r for r in rows if r['arm']=='base' and r['phase']==phase],key=lambda r:r['pair'])
  native=sorted([r for r in rows if r['arm']=='native' and r['phase']==phase],key=lambda r:r['pair'])
  assert len(base)==len(native)==10
  assert all(a['pair']==b['pair'] and a['output_sha256']==b['output_sha256'] and a['modules']==b['modules']==60001 for a,b in zip(base,native))
  if kind != 'hook-shapes': assert all(a['counts']=={'use':236401,'include':236401} and b['counts']=={'use':0,'include':0} for a,b in zip(base,native))
  else: assert all(a['counts']['use'] > b['counts']['use'] > 0 and a['counts']['include']==b['counts']['include']==0 for a,b in zip(base,native))
  def summarize(stage,metric,valuesA,valuesB):
   deltas=[b-a for a,b in zip(valuesA,valuesB)]; walsh=sorted((a+b)/2 for i,a in enumerate(deltas) for b in deltas[i:])
   summary.append(dict(os=platform.system(),kind=kind,phase=phase,stage=stage,metric=metric,base=statistics.median(valuesA),native=statistics.median(valuesB),paired_median=statistics.median(deltas),lower=walsh[8],upper=walsh[-9],n=10,coverage=.951171875))
  for metric in ['wall_ms','cpu_ms','peak_rss_mib']+(['max_in_flight'] if platform.system()=='Darwin' else ['end_rss_mib']):
   summarize('build',metric,[r[metric] for r in base],[r[metric] for r in native])
  summarize('build','callbacks',[sum(r['counts'].values()) for r in base],[sum(r['counts'].values()) for r in native])
  if platform.system()=='Darwin':
   for stage in ['end','gc','idle10','idle60']:
    for metric in ['ps_rss_mib','footprint_mib','heap_used_mib','heap_total_mib','external_mib']:
     summarize(stage,metric,[r['snapshots'][stage][metric] for r in base],[r['snapshots'][stage][metric] for r in native])
(out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
