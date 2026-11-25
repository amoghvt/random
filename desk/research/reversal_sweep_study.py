import json,datetime,zoneinfo,collections,statistics as st
ET=zoneinfo.ZoneInfo('America/New_York')
nq=json.load(open('nq.json'));oth=json.load(open('other.json'))
def prep(C):
    B=[];k20,k50,k200=2/21,2/51,2/201;e20=e50=e200=None;prev=None;trs=[]
    for x in C:
        t=x[0]/1000;c=x[4]
        e20=c if e20 is None else c*k20+e20*(1-k20);e50=c if e50 is None else c*k50+e50*(1-k50);e200=c if e200 is None else c*k200+e200*(1-k200)
        tr=x[2]-x[3] if prev is None else max(x[2]-x[3],abs(x[2]-prev),abs(x[3]-prev));trs.append(tr);prev=c
        d=datetime.datetime.fromtimestamp(t,ET)
        B.append(dict(t=t,o=x[1],h=x[2],l=x[3],c=c,v=x[5],e20=e20,e50=e50,e200=e200,atr=sum(trs[-14:])/len(trs[-14:]),m=d.hour*60+d.minute,day=d.date().isoformat(),wd=d.weekday()))
    return B
B=prep(nq['5m']);E={int(x[0]/1000):x for x in oth['ES5m']}
days=collections.OrderedDict()
for i,b in enumerate(B): days.setdefault(b['day'],[]).append(i)
dk=list(days)
# levels per day: prior day RTH high/low, overnight high/low (18:00 prev -> 09:30)
lv={}
for n,day in enumerate(dk):
    if n==0: continue
    prev=[i for i in days[dk[n-1]] if 570<=B[i]['m']<960]
    on=[i for i in days[dk[n-1]] if B[i]['m']>=1080]+[i for i in days[day] if B[i]['m']<570]
    if prev and on: lv[day]=dict(PDH=max(B[i]['h'] for i in prev),PDL=min(B[i]['l'] for i in prev),ONH=max(B[i]['h'] for i in on),ONL=min(B[i]['l'] for i in on))
def trend(b): return 1 if (b['c']>b['e200'] and b['e50']>b['e200']) else -1 if (b['c']<b['e200'] and b['e50']<b['e200']) else 0
SL=1.0
def outcome(i,s,stop_px,R_t=(2,3),fixed=(100,)):
    e=B[i+1]['o']+SL*s; risk=(e-stop_px)*s
    if risk<=3: return None
    res=dict(risk=risk,entry=e); hitR={r:None for r in R_t}; hitF={f:None for f in fixed}
    for j in range(i+1,min(len(B),i+1+60)):
        x=B[j];adv=(e-x['l'])*1 if s==1 else (x['h']-e);fav=(x['h']-e) if s==1 else (e-x['l'])
        stopped=adv>=risk
        for r in R_t:
            if hitR[r] is None:
                if stopped: hitR[r]=0
                elif fav>=r*risk: hitR[r]=1
        for f in fixed:
            if hitF[f] is None:
                if stopped: hitF[f]=0
                elif fav>=f: hitF[f]=1
        if stopped: break
    res.update({f'R{r}':hitR[r] or 0 for r in R_t});res.update({f'F{f}':hitF[f] or 0 for f in fixed})
    # fixed 22 / 40 stop from entry, target 100
    for stp in (22,40):
        o=0
        for j in range(i+1,min(len(B),i+1+60)):
            x=B[j];adv=(e-x['l']) if s==1 else (x['h']-e);fav=(x['h']-e) if s==1 else (e-x['l'])
            if adv>=stp: o=0;break
            if fav>=100: o=1;break
        res[f'S{stp}']=o
    return res
ev=[]
for day,L in lv.items():
    idx=[i for i in days[day] if 570<=B[i]['m']<955]
    seen=collections.Counter()
    for i in idx:
        b=B[i]
        # hourly swing level: extreme of the prior 24 bars excluding the last 3
        w=B[i-27:i-3]
        if len(w)<24: continue
        cands=[('PDL',L['PDL'],1),('ONL',L['ONL'],1),('2h low',min(x['l'] for x in w),1),('PDH',L['PDH'],-1),('ONH',L['ONH'],-1),('2h high',max(x['h'] for x in w),-1)]
        for name,level,s in cands:
            swept=(b['l']<level-2 and B[i-1]['l']>=level-2) if s==1 else (b['h']>level+2 and B[i-1]['h']<=level+2)   # first bar through
            if not swept: continue
            seen[(name,s)]+=1
            tr=trend(B[i-1]); al='with trend' if tr==s else 'counter-trend' if tr==-s else 'no trend'
            # walk forward up to 6 bars for: extreme, reclaim, MSS
            ext=b['l'] if s==1 else b['h']; rec=None;mss=None;extbar=i
            for j in range(i,min(len(B),i+7)):
                x=B[j]
                if (x['l']<ext) if s==1 else (x['h']>ext): ext=x['l'] if s==1 else x['h'];extbar=j;rec=None;mss=None
                if rec is None and ((x['c']>level) if s==1 else (x['c']<level)) and j>=extbar: rec=j
                ref=max(y['h'] for y in B[extbar-2:extbar+1]) if s==1 else min(y['l'] for y in B[extbar-2:extbar+1])
                if mss is None and j>extbar and ((x['c']>ref) if s==1 else (x['c']<ref)): mss=j
            es=E.get(int(b['t']));esw=None
            if es:
                ew=[E.get(int(B[k]['t'])) for k in range(i-27,i-3)];ew=[y for y in ew if y]
                if len(ew)>=20:
                    esl=min(y[3] for y in ew) if s==1 else max(y[2] for y in ew)
                    ecur=[E.get(int(B[k]['t'])) for k in range(i,min(len(B),i+3))];ecur=[y for y in ecur if y]
                    esw=any((y[3]<esl) if s==1 else (y[2]>esl) for y in ecur)
            base=dict(day=day,name=name,s=s,al=al,m=b['m'],atr=b['atr'],first=seen[(name,s)]==1,depth=abs(ext-level),smt=(esw is False),vol_spike=b['v']>1.5*st.mean(x['v'] for x in B[i-12:i]) if b['v'] else False,
                      speed=abs(B[i-1]['c']-B[i-4]['c']))
            A=outcome(i-1,s,(b['o']-22*s) if False else 0) if False else None
            # variant A: knife (enter at the level as it breaks, fixed stops)
            e0=dict(base);e0['var']='A knife: enter as the level breaks'
            fake=dict(B[i]);  # entry at level price
            o=None
            # emulate: entry = level (limit), evaluate from bar i itself
            e=level;res={}
            for stp in (22,40):
                ok=0
                for j in range(i,min(len(B),i+60)):
                    x=B[j];adv=(e-x['l']) if s==1 else (x['h']-e);fav=(x['h']-e) if s==1 else (e-x['l'])
                    if adv>=stp: ok=0;break
                    if fav>=100: ok=1;break
                res[f'S{stp}']=ok
            e0.update(res);ev.append(e0)
            for var,j in (('B reclaim: first 5m close back through the level',rec),('C turn: 5m close beyond the bar(s) that made the extreme',mss)):
                if j is None or j>=len(B)-2: continue
                stop_px=ext-5*s
                o=outcome(j,s,stop_px)
                if o is None: continue
                e1=dict(base);e1['var']=var;e1.update(o);ev.append(e1)
def show(title,v,keys=('S22','S40','R2','R3')):
    if len(v)<8: print(f'{title:>58} n={len(v):3d} (too few)');return
    parts=[]
    for k in keys:
        a=[x[k] for x in v if k in x]
        if a: parts.append(f"{k}:{sum(a)/len(a)*100:3.0f}%")
    rk=[x['risk'] for x in v if 'risk' in x]
    exp3=None
    a=[x['R3'] for x in v if 'R3' in x]
    if a: exp3=sum(a)/len(a)*3-(1-sum(a)/len(a))
    print(f"{title:>58} n={len(v):3d} per day {len(v)/len(lv):.1f} | {'  '.join(parts)}" + (f" | median stop {st.median(rk):.0f} pts | 3R expectancy {exp3:+.2f}R" if rk else ''))
print('sessions',len(lv),'| S22 / S40 = reached +100 before a 22 / 40-pt stop from entry | R2 / R3 = reached 2x / 3x the risk before the structural stop (5 pts beyond the sweep extreme)')
for var in sorted(set(e['var'] for e in ev)):
    V=[e for e in ev if e['var']==var];print('\n'+var);show('all',V)
    for al in ('with trend','counter-trend','no trend'): show(al,[e for e in V if e['al']==al])
    for nm in ('PDL','PDH','ONL','ONH','2h low','2h high'): show(nm,[e for e in V if e['name']==nm])
    show('prior-day or overnight level',[e for e in V if e['name'] in('PDL','PDH','ONL','ONH')])
    show('first sweep of that level today',[e for e in V if e['first']]);show('repeat sweep',[e for e in V if not e['first']])
    show('09:30-10:00',[e for e in V if e['m']<600]);show('10:00-11:30',[e for e in V if 600<=e['m']<690]);show('11:30-14:00',[e for e in V if 690<=e['m']<840]);show('14:00-16:00',[e for e in V if e['m']>=840])
    show('ES did NOT sweep its level (divergence)',[e for e in V if e['smt']]);show('ES swept too',[e for e in V if not e['smt']])
    show('ATR >= 45',[e for e in V if e['atr']>=45]);show('ATR < 45',[e for e in V if e['atr']<45])
    show('shallow sweep (< 15 pts beyond)',[e for e in V if e['depth']<15]);show('deep sweep (>= 15 pts)',[e for e in V if e['depth']>=15])
    show('volume spike on the sweep bar',[e for e in V if e['vol_spike']])
    show('WITH TREND + turn + 10:00-16:00',[e for e in V if e['al']=='with trend' and e['m']>=600])
    show('WITH TREND + shallow',[e for e in V if e['al']=='with trend' and e['depth']<15])
    show('COUNTER-TREND + prior-day/overnight level',[e for e in V if e['al']=='counter-trend' and e['name'] in('PDL','PDH','ONL','ONH')])
    show('COUNTER-TREND + ES divergence',[e for e in V if e['al']=='counter-trend' and e['smt']])
json.dump(ev,open('rev_events.json','w'))
