import json,datetime,zoneinfo,statistics as st
ET=zoneinfo.ZoneInfo('America/New_York')
def prep(C,ms=True):
    B=[];k20,k50,k200=2/21,2/51,2/201;e20=e50=e200=None;prev=None;trs=[]
    for x in C:
        t=x[0]/1000 if ms else x[0];c=x[4]
        e20=c if e20 is None else c*k20+e20*(1-k20);e50=c if e50 is None else c*k50+e50*(1-k50);e200=c if e200 is None else c*k200+e200*(1-k200)
        tr=x[2]-x[3] if prev is None else max(x[2]-x[3],abs(x[2]-prev),abs(x[3]-prev));trs.append(tr);prev=c
        d=datetime.datetime.fromtimestamp(t,ET)
        B.append(dict(t=t,o=x[1],h=x[2],l=x[3],c=c,e20=e20,e50=e50,e200=e200,atr=sum(trs[-14:])/len(trs[-14:]),m=d.hour*60+d.minute,day=d.date().isoformat(),wd=d.weekday()))
    return B
def run(B,kind,stopf,tgtf,volf,maxbars,slip=1.0,frm=570,to=960):
    res=[];busy=-1
    for i in range(260,len(B)-1):
        b=B[i]
        if i<busy or b['wd']>4 or not(frm<=b['m']<to) or not volf(B,i): continue
        up=b['c']>b['e200'] and b['e50']>b['e200'] and b['e20']>b['e50'];dn=b['c']<b['e200'] and b['e50']<b['e200'] and b['e20']<b['e50']
        if not(up or dn): continue
        if kind=='zone' and abs(b['c']-b['e20'])>0.5*b['atr']: continue
        s=1 if up else -1;stop=stopf(b);tgt=tgtf(b);e=B[i+1]['o']+slip*s;out=None
        for j in range(i+1,min(len(B),i+1+maxbars)):
            x=B[j];adv=(e-x['l']) if s==1 else (x['h']-e);fav=(x['h']-e) if s==1 else (e-x['l'])
            if adv>=stop: out=(-stop-slip,j);break
            if fav>=tgt: out=(tgt-slip,j);break
        if out is None: j=min(len(B)-1,i+maxbars);out=((B[j]['c']-e)*s-slip,j)
        busy=out[1]+1;res.append((b['day'],s,out[0],out[0]/stop))
    return res
def f(res,key=2):
    if not res: return 'n=  0'
    w=[x for x in res if x[2]>0];gw=sum(x[2] for x in w);gl=-sum(x[2] for x in res if x[2]<=0)
    return f"n={len(res):4d} win={len(w)/len(res)*100:4.1f}% avg={sum(x[3] for x in res)/len(res):5.2f}R PF={(gw/gl if gl else 9.99):4.2f} total={sum(x[2] for x in res):8.0f} pts ({sum(x[3] for x in res):6.1f}R)"
nq=json.load(open('nq.json'));ig=json.load(open('ig.json'));lg=json.load(open('nq_long.json'))
A=prep(nq['5m']);G=prep(ig['m5'],ms=False)
print('=== 5-MINUTE, every session on file ===')
for name,B in (('Yahoo NQ future, Sep 14 - Nov 20 (50 sessions)',A),('IG US Tech 100 cash, Nov 3 - Nov 25 (17 sessions; overlaps the above to Nov 20)',G)):
    print(name)
    for kind in ('zone','any'):
        r=run(B,kind,lambda b:40,lambda b:200,lambda B,i:B[i]['atr']>=45,48)
        print(f'  {"EMA20 pullback" if kind=="zone" else "any with-trend bar":18} stop 40 / target 200 / ATR>=45: {f(r)}')
        print('      longs ',f([x for x in r if x[1]==1]));print('      shorts',f([x for x in r if x[1]==-1]))
        bym={}
        for x in r: bym.setdefault(x[0][:7],[]).append(x)
        print('      by month:',' | '.join(f"{m} {sum(x[2] for x in v):6.0f} pts n={len(v)}" for m,v in sorted(bym.items())))
        byd={}
        for x in r: byd[x[0]]=byd.get(x[0],0)+x[2]
        v=sorted(byd.values());run_=0;worst=0;cum=0;peak=0;dd=0
        for x in r:
            run_=run_+1 if x[2]<=0 else 0;worst=max(worst,run_);cum+=x[2];peak=max(peak,cum);dd=max(dd,peak-cum)
        print(f'      days {len(v)} green {sum(z>0 for z in v)} | longest losing streak {worst} trades | max drawdown {dd:.0f} pts (${dd*18.5:,.0f} at 18.5 ct)')
print('\n=== HOURLY ANALOGUE, 2.4 years (Jul 2024 - Nov 2026) ===')
print('Same idea on 1h bars, nothing tuned: with the 1h EMA 20/50/200 trend, ATR above its 250-bar median, stop 1 ATR, target 5 ATR, max 48 bars, cash-hours entries.')
H=prep(lg['1h'])
med={}
def volf(B,i):
    w=sorted(b['atr'] for b in B[max(0,i-250):i]);return len(w)>100 and B[i]['atr']>=w[len(w)//2]
for kind in ('zone','any'):
    r=run(H,kind,lambda b:b['atr'],lambda b:5*b['atr'],volf,48,slip=1.0)
    print(f' {"EMA20 pullback" if kind=="zone" else "any with-trend bar"}: {f(r)}')
    print('    longs ',f([x for x in r if x[1]==1]));print('    shorts',f([x for x in r if x[1]==-1]))
    byh={}
    for x in r: byh.setdefault(x[0][:4]+('H1' if x[0][5:7]<='06' else 'H2'),[]).append(x)
    for h,v in sorted(byh.items()): print(f'    {h}: {f(v)}')
print(' no volatility filter, any with-trend bar:',f(run(H,'any',lambda b:b['atr'],lambda b:5*b['atr'],lambda B,i:True,48)))
print(' target 2 ATR instead of 5:',f(run(H,'any',lambda b:b['atr'],lambda b:2*b['atr'],volf,48)))
print('\n=== 15-MINUTE, Sep 14 - Nov 20 (same rule, stop 1 ATR, target 5 ATR, ATR above its 250-bar median) ===')
M=prep(lg['15m'])
for kind in ('zone','any'): print(f' {kind:5}',f(run(M,kind,lambda b:b['atr'],lambda b:5*b['atr'],volf,48)))
