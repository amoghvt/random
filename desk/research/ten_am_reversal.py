import json,datetime,zoneinfo,collections,statistics as st
ET=zoneinfo.ZoneInfo('America/New_York')
nq=json.load(open('nq.json'));lg=json.load(open('nq_long.json'));cal=json.load(open('cal.json'))
def bars(C):
    out=[]
    for x in C:
        d=datetime.datetime.fromtimestamp(x[0]/1000,ET);out.append(dict(t=x[0]/1000,o=x[1],h=x[2],l=x[3],c=x[4],m=d.hour*60+d.minute,day=d.date().isoformat(),wd=d.weekday()))
    return out
F=bars(nq['5m']);D=collections.OrderedDict()
for i,b in enumerate(F):
    if b['wd']<5 and 570<=b['m']<960: D.setdefault(b['day'],[]).append(i)
D={k:v for k,v in D.items() if len(v)>=70}
hm=lambda m:f'{m//60:02d}:{m%60:02d}'
print('5-MINUTE, %d sessions (%s to %s)'%(len(D),list(D)[0],list(D)[-1]))
# A1: where the session high / low is set
hi=collections.Counter();lo=collections.Counter()
for day,idx in D.items():
    h=max(idx,key=lambda i:F[i]['h']);l=min(idx,key=lambda i:F[i]['l']);hi[F[h]['m']//30*30]+=1;lo[F[l]['m']//30*30]+=1
print('share of sessions whose RTH high or low is set in each half hour (even spread would be 7.7% each):')
print('  '+'  '.join(f"{hm(m)} {(hi[m]+lo[m])/(2*len(D))*100:4.1f}%" for m in range(570,960,30)))
w=[(F[max(idx,key=lambda i:F[i]['h'])]['m'],F[min(idx,key=lambda i:F[i]['l'])]['m']) for idx in D.values()]
print('  high or low set between 09:55 and 10:10: %d of %d sessions (%.0f%%)'%(sum((595<=a<610) or (595<=b<610) for a,b in w),len(w),sum((595<=a<610) or (595<=b<610) for a,b in w)/len(w)*100))
# A2: pivot frequency by 5m slot (bar is the highest high or lowest low of the hour either side)
piv=collections.Counter();cnt=collections.Counter()
for day,idx in D.items():
    for i in idx:
        b=F[i]
        if not(585<=b['m']<=900): continue
        w=F[i-12:i+13];cnt[b['m']]+=1
        if b['h']>=max(x['h'] for x in w) or b['l']<=min(x['l'] for x in w): piv[b['m']]+=1
rate={m:piv[m]/cnt[m] for m in cnt};avg=st.mean(rate.values())
print('chance a 5m candle is the high or low of the hour either side of it: average slot %.1f%%'%(avg*100))
for m in (585,590,595,600,605,610,615,630,660,690,810,840,900): print(f'   {hm(m)} candle: {rate[m]*100:4.1f}%  ({piv[m]}/{cnt[m]})')
top=sorted(rate.items(),key=lambda kv:-kv[1])[:6];print('   highest slots:',[(hm(m),f'{r*100:.0f}%') for m,r in top])
# B: fade rule at time X: the last two 5m bars set the session extreme and the last bar closed against it -> fade; stop 5 pts beyond the extreme; exit 3R or 12:30 / +150 min
def fade(at,tgtR=3,need_ext=True,hold=30):
    res=[]
    for day,idx in D.items():
        j=[i for i in idx if F[i]['m']==at-5]
        if not j: continue
        i=j[0];sofar=[k for k in idx if k<=i];H=max(F[k]['h'] for k in sofar);L=min(F[k]['l'] for k in sofar);b=F[i]
        s=0
        if max(F[i]['h'],F[i-1]['h'])>=H and b['c']<b['o']: s=-1
        elif min(F[i]['l'],F[i-1]['l'])<=L and b['c']>b['o']: s=1
        if s==0: continue
        ent=F[i+1]['o'];stop=(H+5) if s==-1 else (L-5);risk=(stop-ent) if s==-1 else (ent-stop)
        if risk<=5: continue
        out=None
        for k in range(i+1,i+1+hold):
            if k>=len(F) or F[k]['day']!=day: break
            x=F[k];adv=(x['h']-ent) if s==-1 else (ent-x['l']);fav=(ent-x['l']) if s==-1 else (x['h']-ent)
            if adv>=risk: out=-1.0;break
            if fav>=tgtR*risk: out=float(tgtR);break
        if out is None:
            k=min(k,len(F)-1);out=((ent-F[k]['c']) if s==-1 else (F[k]['c']-ent))/risk
        res.append(dict(day=day,s=s,R=out,risk=risk))
    return res
def f(r):
    if len(r)<5: return f'n={len(r):2d}'
    w=[x for x in r if x['R']>0];return f"n={len(r):2d} win {len(w)/len(r)*100:3.0f}% avg {st.mean(x['R'] for x in r):+.2f}R total {sum(x['R'] for x in r):+5.1f}R median stop {st.median(x['risk'] for x in r):.0f}"
print('\nFADE RULE at a fixed time: session high/low just set in the last two 5m candles and the last candle closed against it; stop 5 pts beyond the extreme, target 3R, out after 2.5h')
for at in (585,590,595,600,605,610,615,630,645,660,690,720):
    print(f'   decide at {hm(at)}: {f(fade(at))}')
r10=fade(605);print('   10:05 (after the 10:00 candle) target 2R:',f(fade(605,2)),'| longs',f([x for x in r10 if x["s"]==1]),'| shorts',f([x for x in r10 if x["s"]==-1]))
rel=set(datetime.datetime.fromtimestamp(e['t'],ET).date().isoformat() for e in cal if datetime.datetime.fromtimestamp(e['t'],ET).strftime('%H:%M')=='10:00' and e['imp']>=0)
for lbl,at in (('10:00',600),('10:05',605)):
    r=fade(at);print(f'   {lbl} on days WITH a 10:00 data release: {f([x for x in r if x["day"] in rel])} | without: {f([x for x in r if x["day"] not in rel])}')
# C: hourly, 2.4 years
Hb=bars(lg['1h']);HD=collections.OrderedDict()
for i,b in enumerate(Hb):
    if b['wd']<5 and 540<=b['m']<960: HD.setdefault(b['day'],[]).append(i)
HD={k:v for k,v in HD.items() if len(v)>=7}
print('\nHOURLY, %d sessions (%s to %s)'%(len(HD),list(HD)[0],list(HD)[-1]))
hh=collections.Counter();ll=collections.Counter()
for idx in HD.values():
    hh[Hb[max(idx,key=lambda i:Hb[i]['h'])]['m']]+=1;ll[Hb[min(idx,key=lambda i:Hb[i]['l'])]['m']]+=1
print('share of sessions whose 09:00-16:00 high or low falls in each hour bar:')
print('  '+'  '.join(f"{hm(m)} {(hh[m]+ll[m])/(2*len(HD))*100:4.1f}%" for m in range(540,960,60)))
# reversal: does the 10:00-11:00 bar go against the 09:00-10:00 bar more than other hour pairs do?
rev=collections.Counter();tot=collections.Counter();big=collections.Counter();bigt=collections.Counter()
for idx in HD.values():
    bm={Hb[i]['m']:Hb[i] for i in idx}
    for m in range(600,960,60):
        a=bm.get(m-60);b=bm.get(m)
        if not a or not b: continue
        da=a['c']-a['o'];db=b['c']-b['o']
        if abs(da)<1 or abs(db)<1: continue
        tot[m]+=1;rev[m]+=(da*db<0)
        if abs(da)/a['o']>=0.004: bigt[m]+=1;big[m]+=(da*db<0)
print('chance an hour bar closes against the previous hour bar:  '+'  '.join(f"{hm(m)} {rev[m]/tot[m]*100:.0f}%" for m in range(600,960,60)))
print('same, when the previous hour moved 0.4% or more:           '+'  '.join(f"{hm(m)} {big[m]/max(1,bigt[m])*100:.0f}% (n={bigt[m]})" for m in range(600,960,60)))
# hourly fade: at 10:00, fade the 09:00-10:00 bar if it set the session extreme; stop beyond that bar; 2R; exit at 13:00
res=[]
for idx in HD.values():
    bm={Hb[i]['m']:i for i in idx}
    if 540 not in bm or 600 not in bm: continue
    a=Hb[bm[540]];s=-1 if a['c']>a['o'] else 1
    if abs(a['c']-a['o'])/a['o']<0.004: continue
    ent=Hb[bm[600]]['o'];stop=(a['h']+5) if s==-1 else (a['l']-5);risk=(stop-ent) if s==-1 else (ent-stop)
    if risk<=5: continue
    out=None
    for m in (600,660,720):
        if m not in bm: break
        x=Hb[bm[m]];adv=(x['h']-ent) if s==-1 else (ent-x['l']);fav=(ent-x['l']) if s==-1 else (x['h']-ent)
        if adv>=risk: out=-1.0;break
        if fav>=2*risk: out=2.0;break
    if out is None: x=Hb[bm.get(720,bm[600])];out=((ent-x['c']) if s==-1 else (x['c']-ent))/risk
    res.append(dict(day=a['day'],s=s,R=out,risk=risk))
print('hourly fade at 10:00 of a 0.4%+ first hour (stop beyond that hour, target 2R, out by 13:00):',f(res))
by=collections.defaultdict(list)
for x in res: by[x['day'][:4]+('H1' if x['day'][5:7]<='06' else 'H2')].append(x)
print('   by half-year:',{k:f"{st.mean(y['R'] for y in v):+.2f}R n={len(v)}" for k,v in sorted(by.items())})
