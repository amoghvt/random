import json,collections,bisect,statistics as st
N=sorted(json.load(open('n_feat.json')),key=lambda d:d['t0']); nq=json.load(open('nq.json'))
C5=nq['5m'];T5=[x[0]/1000 for x in C5]
net=lambda v:sum(d['pnl'] for d in v)
for d in N:
    i=bisect.bisect_right(T5,d['t0'])-2; s=d['s']; b=C5[i]; p=C5[i-1]
    lo12=min(x[3] for x in C5[i-12:i]); hi12=max(x[2] for x in C5[i-12:i])
    newext=(b[3]<lo12) if s==1 else (b[2]>hi12)          # last closed bar made a new 1h extreme against the trade
    closed_against=(b[4]<b[1]) if s==1 else (b[4]>b[1])
    confirm=((b[4]>p[2]) if s==1 else (b[4]<p[3]))        # last closed bar closed beyond the prior bar, in the trade direction
    # had price already turned: a 5m close back above the bar-high that made the low
    win=C5[i-6:i+1]; k=min(range(len(win)),key=lambda j:win[j][3]) if s==1 else max(range(len(win)),key=lambda j:win[j][2])
    turned=any(((x[4]>win[k][2]) if s==1 else (x[4]<win[k][3])) for x in win[k+1:])
    d['knife']=newext and closed_against; d['confirm']=confirm; d['turned']=turned
    d['rev']=(d['mom15'].startswith('against') or d['ext'].startswith('extended >1.5 ATR against') or d['range60'].startswith('buying low'))
def row(lbl,v):
    if not v: print(f'{lbl:>62} n=0');return
    a=[d['d100'] for d in v if d['d100'] is not None];t=[d['tight'] for d in v if d['tight'] is not None]
    print(f"{lbl:>62} n={len(v):4d} yourWin={sum(d['pnl']>0 for d in v)/len(v)*100:4.1f}% net={net(v):8.0f} big={sum(d['pnl']>=1000 for d in v):2d} | +100 before -100: {sum(a)/max(1,len(a))*100:3.0f}% | +100 before -22: {(str(round(sum(t)/len(t)*100))+'% n='+str(len(t))) if len(t)>=8 else '-'}")
R=[d for d in N if d['rev']]; O=[d for d in N if not d['rev']]
print('YOUR NQ TRADES');row('reversal attempts (fading the last 15-60 min)',R);row('everything else',O)
print('\nReversal attempts, by what the last closed 5m bar had done when you entered')
row('KNIFE: bar just made a new 1h extreme and closed against you',[d for d in R if d['knife']])
row('no new extreme, but no turn yet',[d for d in R if not d['knife'] and not d['turned']])
row('TURNED: a 5m bar had closed back through the extreme bar',[d for d in R if d['turned']])
row('TURNED and with 17h trend',[d for d in R if d['turned'] and d['trend']=='with 17h trend'])
row('TURNED but against 17h trend',[d for d in R if d['turned'] and d['trend']=='against 17h trend'])
row('not turned, with 17h trend',[d for d in R if not d['turned'] and d['trend']=='with 17h trend'])
row('not turned, against 17h trend',[d for d in R if not d['turned'] and d['trend']=='against 17h trend'])
print('\nReversal attempts by time'); 
for k in sorted(set(d['tod'] for d in R)): row(k,[d for d in R if d['tod']==k])
# CHASE clusters: consecutive same-direction entries, each within 10 min of the previous exit
cl=[];cur=[N[0]]
for d in N[1:]:
    p=cur[-1]
    if d['s']==p['s'] and d['t0']-p['t1']<600: cur.append(d)
    else: cl.append(cur);cur=[d]
cl.append(cur)
print('\nTHE CHASE: runs of same-direction re-entries within 10 minutes of the last exit')
for lo,hi in ((1,1),(2,2),(3,4),(5,8),(9,99)):
    g=[c for c in cl if lo<=len(c)<=hi]
    if not g: continue
    tot=sum(net(c) for c in g); won=[c for c in g if net(c)>0]
    print(f"  {lo}-{hi} attempts: {len(g):3d} runs, {sum(len(c) for c in g):4d} trades, accounts {sum(len(set(d['acct'] for d in c)) for c in g):3d}, net ${tot:8.0f}, runs that ended net positive {len(won)}/{len(g)} ({len(won)/len(g)*100:.0f}%)")
big=[c for c in cl if len(c)>=3]
print('  in runs of 3+: P(next attempt wins) by attempt number:')
for k in range(1,9):
    a=[c[k-1] for c in cl if len(c)>=k]
    if len(a)>=15: print(f"     attempt {k}: n={len(a):3d} win={sum(d['pnl']>0 for d in a)/len(a)*100:4.1f}% avg ${net(a)/len(a):6.0f} big wins {sum(d['pnl']>=1000 for d in a)}")
json.dump(N,open('n_feat2.json','w'))
