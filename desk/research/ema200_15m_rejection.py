import json,datetime,zoneinfo,bisect,collections,statistics as st
ET=zoneinfo.ZoneInfo('America/New_York')
lg=json.load(open('nq_long.json'));C=lg['15m']
B=[];k20,k50,k200=2/21,2/51,2/201;e20=e50=e200=None;prev=None;trs=[]
for x in C:
    t=x[0]/1000;c=x[4];e20=c if e20 is None else c*k20+e20*(1-k20);e50=c if e50 is None else c*k50+e50*(1-k50);e200=c if e200 is None else c*k200+e200*(1-k200)
    tr=x[2]-x[3] if prev is None else max(x[2]-x[3],abs(x[2]-prev),abs(x[3]-prev));trs.append(tr);prev=c
    d=datetime.datetime.fromtimestamp(t,ET)
    B.append(dict(t=t,o=x[1],h=x[2],l=x[3],c=c,e20=e20,e50=e50,e200=e200,atr=sum(trs[-14:])/len(trs[-14:]),m=d.hour*60+d.minute,wd=d.weekday(),day=d.date().isoformat()))
T=[b['t'] for b in B]
def sess(m): return 'NY cash 09:30-16:00' if 570<=m<960 else 'pre-open 04:00-09:30' if 240<=m<570 else 'evening 16:00-20:00' if 960<=m<1200 else 'overnight 20:00-04:00'
ev=[]
for i in range(260,len(B)-2):
    b=B[i];E=b['e200']
    for s in (-1,1):   # -1: rejection from below (short). +1: support from above (long)
        prior=B[i-8:i]
        away=all((x['c']<x['e200']) if s==-1 else (x['c']>x['e200']) for x in prior)
        if not away: continue
        tol=0.15*b['atr']
        touched=(b['h']>=E-tol) if s==-1 else (b['l']<=E+tol)
        if not touched: continue
        rejected=(b['c']<E) if s==-1 else (b['c']>E)
        # first touch: no touch in the prior 32 bars (8h)
        first=not any(((x['h']>=x['e200']-0.15*x['atr']) if s==-1 else (x['l']<=x['e200']+0.15*x['atr'])) for x in B[i-32:i])
        slope=(E-B[i-16]['e200'])/b['atr']   # change of the EMA200 over 4h in ATRs
        sl='against you (EMA sloping your way)' if slope*s>0.15 else 'flat' if abs(slope)<=0.15 else 'EMA sloping against the trade'
        wick=((b['h']-max(b['o'],b['c'])) if s==-1 else (min(b['o'],b['c'])-b['l']))/max(1e-9,b['h']-b['l'])
        pierce=((b['h']-E) if s==-1 else (E-b['l']))
        run=abs(b['c']-B[i-8]['c'])/b['atr']
        e=dict(i=i,s=s,rej=rejected,first=first,slope=slope,sess=sess(b['m']),wick=wick,pierce=pierce,atr=b['atr'],day=b['day'],
               trend50=(b['e50']<E) if s==-1 else (b['e50']>E),m=b['m'],run=run)
        if rejected:
            ent=B[i+1]['o'];stop=(b['h']+5) if s==-1 else (b['l']-5);risk=(stop-ent) if s==-1 else (ent-stop)
            if risk>3:
                r={2:0,3:0};f={100:None,200:None};done=set()
                for j in range(i+1,min(len(B),i+1+64)):
                    x=B[j];adv=(x['h']-ent) if s==-1 else (ent-x['l']);fav=(ent-x['l']) if s==-1 else (x['h']-ent)
                    if adv>=risk: break
                    for k in (2,3):
                        if fav>=k*risk: r[k]=1
                    if r[3]: break
                # fixed: +100 / +200 before -40
                for tg in (100,200):
                    o=0
                    for j in range(i+1,min(len(B),i+1+64)):
                        x=B[j];adv=(x['h']-ent) if s==-1 else (ent-x['l']);fav=(ent-x['l']) if s==-1 else (x['h']-ent)
                        if adv>=40: o=0;break
                        if fav>=tg: o=1;break
                    f[tg]=o
                # max favourable run in the next 16h before price closes back through the EMA by 0.5 ATR
                mf=0
                for j in range(i+1,min(len(B),i+1+64)):
                    x=B[j];mf=max(mf,(ent-x['l']) if s==-1 else (x['h']-ent))
                    if ((x['c']>x['e200']+0.5*x['atr']) if s==-1 else (x['c']<x['e200']-0.5*x['atr'])): break
                e.update(risk=risk,R2=r[2],R3=r[3],F100=f[100],F200=f[200],mf=mf)
        ev.append(e)
days=len(set(b['day'] for b in B[260:] if b['wd']<5))
print('NQ 15-minute bars',B[260]['day'],'to',B[-1]['day'],'| about',days,'sessions')
tch=ev;rj=[e for e in ev if e['rej'] and 'R2' in e]
print(f'touches of the 15m EMA 200 after 2h+ on one side: {len(tch)} ({len(tch)/days:.1f}/day) | closed back (rejected/held): {sum(e["rej"] for e in tch)} ({sum(e["rej"] for e in tch)/len(tch)*100:.0f}%) | closed through: {sum(not e["rej"] for e in tch)}')
def show(t,v):
    if len(v)<6: print(f'{t:>58} n={len(v):3d}');return
    r2=sum(e['R2'] for e in v)/len(v);r3=sum(e['R3'] for e in v)/len(v)
    print(f"{t:>58} n={len(v):3d} ({len(v)/days:.2f}/day) 2R {r2*100:3.0f}% ({r2*2-(1-r2):+.2f}R)  3R {r3*100:3.0f}% ({r3*3-(1-r3):+.2f}R)  +100 before -40: {sum(e['F100'] for e in v)/len(v)*100:3.0f}%  +200 before -40: {sum(e['F200'] for e in v)/len(v)*100:3.0f}%  median stop {st.median(e['risk'] for e in v):.0f}  median run after {st.median(e['mf'] for e in v):.0f} pts")
print('\nAFTER A REJECTION (bar touches the EMA 200 and closes back on its own side; enter next bar open; stop 5 pts beyond the bar)')
show('all',rj);show('resistance (short from below)',[e for e in rj if e['s']==-1]);show('support (long from above)',[e for e in rj if e['s']==1])
show('first touch in 8h',[e for e in rj if e['first']]);show('repeat touch',[e for e in rj if not e['first']])
for k in ('EMA sloping against the trade','flat','against you (EMA sloping your way)'): show({'EMA sloping against the trade':'EMA 200 sloping against price (declining for a short)','flat':'EMA 200 flat','against you (EMA sloping your way)':'EMA 200 sloping with price'}[k],[e for e in rj if (('with' if e['slope']*e['s']>0.15 else 'flat' if abs(e['slope'])<=0.15 else 'against')=={'EMA sloping against the trade':'with','flat':'flat','against you (EMA sloping your way)':'against'}[k])])
show('EMA 50 on the trend side of the 200',[e for e in rj if e['trend50']]);show('EMA 50 on the wrong side',[e for e in rj if not e['trend50']])
for s_ in ('NY cash 09:30-16:00','pre-open 04:00-09:30','evening 16:00-20:00','overnight 20:00-04:00'): show(s_,[e for e in rj if e['sess']==s_])
show('outside NY cash (all)',[e for e in rj if e['sess']!='NY cash 09:30-16:00'])
show('long rejection wick (>=40% of the bar)',[e for e in rj if e['wick']>=0.4]);show('small wick (<40%)',[e for e in rj if e['wick']<0.4])
show('pierced the EMA by 10+ pts then closed back',[e for e in rj if e['pierce']>=10]);show('touched without piercing 10 pts',[e for e in rj if e['pierce']<10])
show('fast run into it (>= 3 ATR in 2h)',[e for e in rj if e['run']>=3]);show('slow drift into it (< 3 ATR)',[e for e in rj if e['run']<3])
show('stop <= 40 pts',[e for e in rj if e['risk']<=40]);show('stop > 40 pts',[e for e in rj if e['risk']>40])
show('FIRST touch + EMA sloping against price + EMA50 trend side',[e for e in rj if e['first'] and e['slope']*e['s']>0.15 and e['trend50']])
show('same, outside NY cash',[e for e in rj if e['first'] and e['slope']*e['s']>0.15 and e['trend50'] and e['sess']!='NY cash 09:30-16:00'])
show('EMA sloping against price + EMA50 trend side (any touch)',[e for e in rj if e['slope']*e['s']>0.15 and e['trend50']])
h=sorted(set(e['day'] for e in rj));half=h[len(h)//2]
show('first half of period',[e for e in rj if e['day']<half]);show('second half of period',[e for e in rj if e['day']>=half])
# his own trades near the 15m EMA 200
P=sorted(json.load(open('p2.json')),key=lambda d:d['t0']);net=lambda v:sum(d['pnl'] for d in v)
nd=[d for d in P if d['sym'].startswith('NDX') and T[260]<d['t0']<T[-1]]
for d in nd:
    i=bisect.bisect_right(T,d['t0'])-1;b=B[i];s=1 if d['side']=='long' else -1
    px=b['c'];dist=(px-b['e200'])
    d['at200']=abs(dist)<=0.5*b['atr'];d['fade200']=d['at200'] and all(((x['c']<x['e200']) if s==-1 else (x['c']>x['e200'])) for x in B[i-8:i])
    d['rth']='09:30'<=d['open_et'][11:16]<'16:00'
def row(t,v):
    if not v: print(f'{t:>58} n=0');return
    w=[d for d in v if d['pnl']>0];print(f"{t:>58} n={len(v):3d} win {len(w)/len(v)*100:4.1f}% net ${net(v):8,.0f} big wins {sum(d['pnl']>=1000 for d in v)}")
print('\nYOUR NQ TRADES')
row('entered at the 15m EMA 200 as rejection/support',[d for d in nd if d['fade200']]);row('  of those, outside NY cash',[d for d in nd if d['fade200'] and not d['rth']]);row('  of those, in NY cash',[d for d in nd if d['fade200'] and d['rth']])
row('all other NQ trades outside NY cash',[d for d in nd if not d['fade200'] and not d['rth']])
print('\nYOUR WINNERS OF $500+ OUTSIDE 09:30-16:00 ET (all symbols)')
for d in sorted([d for d in P if d['pnl']>=500 and not('09:30'<=d['open_et'][11:16]<'16:00')],key=lambda d:-d['pnl']):
    tag=''
    m=[x for x in nd if x['id']==d['id']]
    if m and m[0]['fade200']: tag='at the 15m EMA 200'
    print(f"  {d['open_et'][5:16]} {d['sym'][:4]} {d['side']:5} +${d['pnl']:6,.0f} held {d['hold_s']/60:5.0f}m {tag}")
out=[d for d in P if not('09:30'<=d['open_et'][11:16]<'16:00')]
print('outside NY cash, all symbols:',len(out),'trades, net $%d'%net(out))
for lbl,a,b in (('18:00-20:00',1080,1200),('20:00-04:00',1200,240),('04:00-08:30',240,510),('08:30-09:30',510,570),('16:00-18:00',960,1080)):
    mm=lambda d:int(d['open_et'][11:13])*60+int(d['open_et'][14:16])
    v=[d for d in out if (a<=mm(d)<b if a<b else (mm(d)>=a or mm(d)<b))];row(lbl,v)
