import json,datetime,zoneinfo,statistics as st
ET=zoneinfo.ZoneInfo('America/New_York')
lg=json.load(open('nq_long.json'))
def prep(C,n):
    B=[];k=2/(n+1);e=None;prev=None;trs=[]
    for x in C:
        t=x[0]/1000;c=x[4];e=c if e is None else c*k+e*(1-k)
        tr=x[2]-x[3] if prev is None else max(x[2]-x[3],abs(x[2]-prev),abs(x[3]-prev));trs.append(tr);prev=c
        d=datetime.datetime.fromtimestamp(t,ET)
        B.append(dict(t=t,o=x[1],h=x[2],l=x[3],c=c,e=e,atr=sum(trs[-14:])/len(trs[-14:]),m=d.hour*60+d.minute,day=d.date().isoformat()))
    return B
def run(B,away,firstlook,slopebars,flat_thr,maxbars,variant,tgtR=3,lo=None,hi=None):
    res=[];busy=-1
    for i in range(260,len(B)-2):
        if i<busy: continue
        b=B[i]
        if lo and b['day']<lo: continue
        if hi and b['day']>=hi: continue
        for s in (-1,1):
            if not all((x['c']<x['e']) if s==-1 else (x['c']>x['e']) for x in B[i-away:i]): continue
            tol=0.15*b['atr']
            if not ((b['h']>=b['e']-tol) if s==-1 else (b['l']<=b['e']+tol)): continue
            if not ((b['c']<b['e']) if s==-1 else (b['c']>b['e'])): continue
            first=not any(((x['h']>=x['e']-0.15*x['atr']) if s==-1 else (x['l']<=x['e']+0.15*x['atr'])) for x in B[i-firstlook:i])
            flat=abs(b['e']-B[i-slopebars]['e'])/b['atr']<=flat_thr
            if variant=='repeat' and first: continue
            if variant=='flat' and not flat: continue
            if variant=='repeat+flat' and (first or not flat): continue
            ent=B[i+1]['o']+(-1 if s==-1 else 1)*1.0;stop=(b['h']+5) if s==-1 else (b['l']-5);risk=(stop-ent) if s==-1 else (ent-stop)
            if risk<=5: continue
            out=None
            for j in range(i+1,min(len(B),i+1+maxbars)):
                x=B[j];adv=(x['h']-ent) if s==-1 else (ent-x['l']);fav=(ent-x['l']) if s==-1 else (x['h']-ent)
                if adv>=risk: out=(-1.0,j);break
                if fav>=tgtR*risk: out=(float(tgtR),j);break
            if out is None:
                j=min(len(B)-1,i+maxbars);out=(((ent-B[j]['c']) if s==-1 else (B[j]['c']-ent))/risk,j)
            busy=out[1]+1;res.append(dict(day=b['day'],s=s,R=out[0],risk=risk,m=b['m']));break
    return res
def f(r):
    if not r: return 'n=   0'
    w=[x for x in r if x['R']>0];gw=sum(x['R'] for x in w);gl=-sum(x['R'] for x in r if x['R']<=0)
    cum=0;peak=0;dd=0;streak=0;worst=0
    for x in r:
        cum+=x['R'];peak=max(peak,cum);dd=max(dd,peak-cum);streak=streak+1 if x['R']<=0 else 0;worst=max(worst,streak)
    return f"n={len(r):4d} win {len(w)/len(r)*100:4.1f}% avg {sum(x['R'] for x in r)/len(r):+.2f}R total {sum(x['R'] for x in r):+6.1f}R PF {(gw/gl if gl else 9.99):4.2f} maxDD {dd:4.1f}R losing streak {worst:2d}"
def dollars(r,riskusd=320,room=400,fee=400,cap=18.5):
    bal=0;claimed=0;lost=0
    for x in r:
        ct=min(cap,riskusd/x['risk']);usd=x['R']*x['risk']*ct;bal+=usd
        if bal<=-room: lost+=1;bal=0
        elif bal>0: claimed+=bal;bal=0
    return claimed,lost,claimed-lost*fee+min(bal,0)
A=prep(lg['15m'],200);days=sorted(set(b['day'] for b in A[260:]));split=days[int(len(days)*0.5)]
print('=== EXACT RULE: 15-minute EMA 200, NQ, %s to %s (%d days) ==='%(days[0],days[-1],len(days)))
print('touch after 2h on one side, bar closes back, enter next open, stop 5 pts beyond the bar, target 3R, 16h time limit, one position at a time')
for v in ('all','repeat','flat','repeat+flat'):
    r=run(A,8,32,16,0.15,64,v);c,l,n=dollars(r)
    print(f' {v:12} whole period: {f(r)}')
    print(f' {"":12} first half:   {f(run(A,8,32,16,0.15,64,v,hi=split))}')
    print(f' {"":12} second half:  {f(run(A,8,32,16,0.15,64,v,lo=split))}')
    print(f' {"":12} 10k account risking $320 a trade: claimed ${c:,.0f}, accounts lost {l}, NET ${n:,.0f} | longs {f([x for x in r if x["s"]==1])[:34]} | shorts {f([x for x in r if x["s"]==-1])[:34]}')
for tg in (2,4,5): print(f' repeat touch, target {tg}R:',f(run(A,8,32,16,0.15,64,'repeat',tgtR=tg)))
H=prep(lg['1h'],50);hd=sorted(set(b['day'] for b in H[260:]))
print('\n=== 2.4-YEAR PROXY: 1-hour EMA 50 (the same 50 hours of price as the 15m EMA 200), NQ, %s to %s ==='%(hd[0],hd[-1]))
print('touch after 3h on one side, 1h bar closes back, stop 5 pts beyond the bar, target 3R, 16h limit')
for v in ('all','repeat','flat','repeat+flat'):
    r=run(H,3,8,4,0.08,16,v);c,l,n=dollars(r)
    print(f' {v:12} {f(r)} | 10k account, $320 risk: NET ${n:,.0f} ({l} accounts lost)')
r=run(H,3,8,4,0.08,16,'repeat')
by={}
for x in r: by.setdefault(x['day'][:4]+('H1' if x['day'][5:7]<='06' else 'H2'),[]).append(x)
print(' repeat touch by half-year:')
for k,v in sorted(by.items()): print(f'   {k}: {f(v)}')
print('   longs ',f([x for x in r if x['s']==1]));print('   shorts',f([x for x in r if x['s']==-1]))
print('   NY cash entries',f([x for x in r if 570<=x['m']<960]));print('   outside NY cash',f([x for x in r if not(570<=x['m']<960)]))
for tg in (2,5): print(f'   target {tg}R:',f(run(H,3,8,4,0.08,16,'repeat',tgtR=tg)))
