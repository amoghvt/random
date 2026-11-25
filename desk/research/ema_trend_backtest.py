"""Backtest of the 5-minute EMA20 pullback / with-trend rule on NQ.

Inputs (JSON, not committed): nq.json = recorded Yahoo NQ candles {"1m": [[t_ms,o,h,l,c,v]], "5m": [...]},
ig.json = IG US Tech 100 bars from the TradingView stream {"m5": [[t_s,o,h,l,c,v]], "m1": [...]}.
Run from the folder holding them: python3 -I ema_trend_backtest.py

Method: parameters are ranked on the first 60% of sessions only; every figure quoted as a result comes from the
later 40%. Fills are next-bar open with 1 point of slippage a side; inside a bar the stop is assumed hit first.
"""
import json,datetime,zoneinfo,itertools,statistics as st,sys
ET=zoneinfo.ZoneInfo('America/New_York')
nq=json.load(open('nq.json')); ig=json.load(open('ig.json'))
def prep(C,ms=True):
    B=[]
    for x in C:
        t=x[0]/1000 if ms else x[0]
        B.append(dict(t=t,o=x[1],h=x[2],l=x[3],c=x[4]))
    k20,k50,k200=2/21,2/51,2/201; e20=e50=e200=None; prev=None; trs=[]
    for i,b in enumerate(B):
        c=b['c']; e20=c if e20 is None else c*k20+e20*(1-k20); e50=c if e50 is None else c*k50+e50*(1-k50); e200=c if e200 is None else c*k200+e200*(1-k200)
        tr=b['h']-b['l'] if prev is None else max(b['h']-b['l'],abs(b['h']-prev),abs(b['l']-prev)); trs.append(tr); prev=c
        b.update(e20=e20,e50=e50,e200=e200,atr=sum(trs[-14:])/len(trs[-14:]),i=i)
        d=datetime.datetime.fromtimestamp(b['t'],ET); b['m']=d.hour*60+d.minute; b['day']=d.date().isoformat(); b['wd']=d.weekday()
    return B
def signals(B,p):
    out=[]
    for i in range(260,len(B)-1):
        b=B[i]
        if b['wd']>4 or not(p['from']<=b['m']<p['to']): continue
        if b['atr']<p['minatr']: continue
        up=b['c']>b['e200'] and b['e50']>b['e200'] and b['e20']>b['e50']
        dn=b['c']<b['e200'] and b['e50']<b['e200'] and b['e20']<b['e50']
        if not(up or dn): continue
        s=1 if up else -1
        if p['kind']=='trend_any': ok=True
        else:
            near=abs(b['c']-b['e20'])<=0.5*b['atr']
            touched=(b['l']<=b['e20']+0.25*b['atr']) if s==1 else (b['h']>=b['e20']-0.25*b['atr'])
            if p['kind']=='zone': ok=near
            else: ok=touched and ((b['c']>B[i-1]['h']) if s==1 else (b['c']<B[i-1]['l'])) and (b['c']-b['e20'])*s>0   # touch then close beyond prior bar
        if ok: out.append((i,s))
    return out
SLIP=1.0
def trade(B,i,s,stop,tgt,maxbars):
    e=B[i+1]['o']+SLIP*s
    for j in range(i+1,min(len(B),i+1+maxbars)):
        b=B[j]
        adv=(e-b['l']) if s==1 else (b['h']-e); fav=(b['h']-e) if s==1 else (e-b['l'])
        if adv>=stop: return -stop-SLIP,j
        if fav>=tgt: return tgt-SLIP,j
        if b['m']>=958 and b['wd']<=4 and B[j]['day']==B[i]['day'] and False: pass
    j=min(len(B)-1,i+maxbars); return (B[j]['c']-e)*s-SLIP,j
def run(B,p,lo=None,hi=None,maxbars=48):
    res=[];busy=-1;losses={}
    for i,s in signals(B,p):
        b=B[i]
        if lo and b['day']<lo: continue
        if hi and b['day']>hi: continue
        if i<busy: continue
        if losses.get(b['day'],0)>=p.get('maxloss',99): continue
        pts,j=trade(B,i,s,p['stop'],p['tgt'],maxbars); busy=j+1
        if pts<0: losses[b['day']]=losses.get(b['day'],0)+1
        res.append((b['day'],s,pts))
    return res
def summ(res,stop):
    if not res: return dict(n=0,win=0,exp=0,R=0,tot=0,pf=0)
    w=[x for x in res if x[2]>0]; gl=-sum(x[2] for x in res if x[2]<=0); gw=sum(x[2] for x in w)
    return dict(n=len(res),win=len(w)/len(res)*100,exp=sum(x[2] for x in res)/len(res),R=sum(x[2] for x in res)/len(res)/stop,tot=sum(x[2] for x in res),pf=gw/gl if gl else 9.99)
A=prep(nq['5m'])
days=sorted(set(b['day'] for b in A if b['wd']<=4 and 570<=b['m']<960)); split=days[int(len(days)*0.6)]
print('Yahoo NQ 5m:',days[0],'to',days[-1],len(days),'sessions | train to',split,'| test after')
grid=[dict(kind=k,stop=s,tgt=t,minatr=a,**{'from':f,'to':u}) for k in ('zone','confirm') for s in (22,40,60) for t in (100,150,200) for a in (0,25,45) for f,u in ((570,960),(600,930))]
rows=[]
for p in grid:
    tr=summ(run(A,p,hi=split),p['stop']); te=summ(run(A,p,lo=split),p['stop']); rows.append((p,tr,te))
ok=[r for r in rows if r[1]['n']>=25]
print('param sets',len(rows),'with >=25 train trades',len(ok),'| profitable in TRAIN',sum(r[1]['exp']>0 for r in ok),'| of all sets profitable in TEST',sum(r[2]['exp']>0 for r in rows),'/',len(rows))
best=sorted(ok,key=lambda r:-r[1]['R'])[:6]
f=lambda s:f"n={s['n']:3d} win={s['win']:4.1f}% exp={s['exp']:6.1f}pts R={s['R']:5.2f} PF={s['pf']:4.2f} total={s['tot']:7.0f}"
print('\nTop 6 by TRAIN, and what each did in TEST (the only honest column):')
for p,tr,te in best: print(f" {p['kind']:7} stop {p['stop']:2d} tgt {p['tgt']:3d} minATR {p['minatr']:2d} {p['from']//60:02d}:{p['from']%60:02d}-{p['to']//60}:{p['to']%60:02d} | TRAIN {f(tr)} | TEST {f(te)}")
print('\nAll sets, TEST period, grouped (avg expectancy pts/trade across sets):')
for key in ('kind','stop','tgt','minatr'):
    g={}
    for p,tr,te in rows:
        if te['n']>=10: g.setdefault(p[key],[]).append(te['exp'])
    print(' ',key,{k:(round(st.mean(v),1),f'{sum(x>0 for x in v)}/{len(v)} positive') for k,v in g.items()})
print('\nBaseline: ANY with-trend bar (no pullback), same exits, cash hours, TEST period:')
for s,t in ((22,100),(40,100),(40,150),(60,150)):
    b=summ(run(A,dict(kind='trend_any',stop=s,tgt=t,minatr=0,**{'from':570,'to':960}),lo=split),s); z=summ(run(A,dict(kind='zone',stop=s,tgt=t,minatr=0,**{'from':570,'to':960}),lo=split),s); c=summ(run(A,dict(kind='confirm',stop=s,tgt=t,minatr=0,**{'from':570,'to':960}),lo=split),s)
    print(f'  stop {s} tgt {t}: any-trend {f(b)}\n                   zone      {f(z)}\n                   confirm   {f(c)}')
# full-period and by direction for one plain, pre-declared setting
P=dict(kind='zone',stop=40,tgt=100,minatr=0,**{'from':570,'to':960})
r=run(A,P); print('\nPlain pre-declared rule (zone, stop 40, target 100, cash hours), whole 10 weeks:',f(summ(r,40)))
print('  longs',f(summ([x for x in r if x[1]==1],40)),'\n  shorts',f(summ([x for x in r if x[1]==-1],40)))
byd={}
for d,s,p in r: byd[d]=byd.get(d,0)+p
v=sorted(byd.values()); print('  days traded',len(v),'green',sum(x>0 for x in v),'best',round(v[-1]),'worst',round(v[0]),'| $ at 18.5 ct: total',round(sum(v)*18.5))
# IG 1m: precise fills, most recent 8 sessions (5m signals built from IG 5m, fills on 1m)
G5=prep(ig['m5'],ms=False); G1=prep(ig['m1'],ms=False)
import bisect; T1=[b['t'] for b in G1]
def run1m(p,maxmin=240):
    res=[];busy=-1
    for i,s in signals(G5,p):
        b=G5[i]; t=b['t']+300
        if t<T1[0] or t<busy: continue
        k=bisect.bisect_left(T1,t)
        if k>=len(G1)-1: continue
        e=G1[k]['o']+SLIP*s; out=None
        for x in G1[k:k+maxmin]:
            adv=(e-x['l']) if s==1 else (x['h']-e); fav=(x['h']-e) if s==1 else (e-x['l'])
            if adv>=p['stop']: out=(-p['stop']-SLIP,x['t']);break
            if fav>=p['tgt']: out=(p['tgt']-SLIP,x['t']);break
        if out is None: x=G1[min(len(G1)-1,k+maxmin)]; out=((x['c']-e)*s-SLIP,x['t'])
        busy=out[1]+60; res.append((b['day'],s,out[0]))
    return res
print('\nIG cash, 1-minute fills, Nov 16-25 (8 sessions; Nov 23-25 are after everything above):')
for kind in ('zone','confirm'):
    for s,t in ((22,100),(40,100),(40,150),(60,150)):
        r=run1m(dict(kind=kind,stop=s,tgt=t,minatr=0,**{'from':570,'to':960})); new=[x for x in r if x[0]>='2026-11-23']
        print(f'  {kind:7} stop {s} tgt {t}: all {f(summ(r,s))} | Nov 23-25 only {f(summ(new,s))}')

print('\n=== DOLLARS, TEST period only (Oct 27 - Nov 20), 18.5 contracts ===')
def acct(res,room,fee,ct=18.5):
    bal=0;claimed=0;lost=0
    for d,s,p in res:
        bal+=p*ct
        if bal<=-room: lost+=1; bal=0
        elif bal>0: claimed+=bal; bal=0
    return claimed,lost,claimed-lost*fee+min(bal,0)
for lbl,p in [('train-chosen: zone, stop 40, tgt 200, ATR>=45, cash hours',dict(kind='zone',stop=40,tgt=200,minatr=45,**{'from':570,'to':960})),
              ('same without the pullback (any with-trend bar)',dict(kind='trend_any',stop=40,tgt=200,minatr=45,**{'from':570,'to':960})),
              ('10k style: zone, stop 22, tgt 200, ATR>=45',dict(kind='zone',stop=22,tgt=200,minatr=45,**{'from':570,'to':960})),
              ('max 2 losses a day: zone, stop 40, tgt 200, ATR>=45',dict(kind='zone',stop=40,tgt=200,minatr=45,maxloss=2,**{'from':570,'to':960}))]:
    r=run(A,p,lo=split); s=summ(r,p['stop'])
    byd={}
    for d,_,pt in r: byd[d]=byd.get(d,0)+pt
    v=list(byd.values())
    if p['stop']==22: c,l,n=acct(r,400,400); a='10k/$400'
    else: c,l,n=acct(r,2000,1900); a='50k/$1,900'
    print(f"{lbl}\n   {f(s)} | days {len(v)} green {sum(x>0 for x in v)} | {a}: claimed ${c:,.0f}, accounts lost {l}, NET ${n:,.0f}")
    print('   longs',f(summ([x for x in r if x[1]==1],p['stop'])),'| shorts',f(summ([x for x in r if x[1]==-1],p['stop'])))
