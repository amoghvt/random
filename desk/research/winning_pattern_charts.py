import json,datetime,zoneinfo,bisect,html
ET=zoneinfo.ZoneInfo('America/New_York')
N=json.load(open('n_feat2.json'));nq=json.load(open('nq.json'));C=nq['5m'];T=[x[0]/1000 for x in C]
k20,k50,k200=2/21,2/51,2/201;e20=e50=e200=None;E=[]
for x in C:
    c=x[4];e20=c if e20 is None else c*k20+e20*(1-k20);e50=c if e50 is None else c*k50+e50*(1-k50);e200=c if e200 is None else c*k200+e200*(1-k200);E.append((e20,e50,e200))
et=lambda t:datetime.datetime.fromtimestamp(t,ET)
def levels(t0):
    d=et(t0).date();idx=[i for i in range(len(C)) if abs(T[i]-t0)<4*86400]
    prev=None
    for back in range(1,5):
        pd=d-datetime.timedelta(days=back);r=[i for i in idx if et(T[i]).date()==pd and 570<=et(T[i]).hour*60+et(T[i]).minute<960]
        if r: prev=r;break
    on=[i for i in idx if (et(T[i]).date()==d and et(T[i]).hour*60+et(T[i]).minute<570) or (prev and T[i]>T[prev[-1]] and et(T[i]).date()<d and et(T[i]).hour>=18)]
    orr=[i for i in idx if et(T[i]).date()==d and 570<=et(T[i]).hour*60+et(T[i]).minute<585]
    L={}
    if prev: L['Prior day high']=max(C[i][2] for i in prev);L['Prior day low']=min(C[i][3] for i in prev)
    if on: L['Overnight high']=max(C[i][2] for i in on);L['Overnight low']=min(C[i][3] for i in on)
    if orr: L['Opening range high']=max(C[i][2] for i in orr);L['Opening range low']=min(C[i][3] for i in orr)
    return L
SURF='#191919';INK='#efefef';INK2='#9c9c9c';GRID='#303030';AXIS='#474747';UP='#0aac23';DN='#dc3c3d';BLUE='#338ced';ORANGE='#e76624';AQUA='#00a888';WARN='#fbb315'
def chart(d,title,why,fname):
    s=d['s'];i0=bisect.bisect_right(T,d['t0'])-1;i1=bisect.bisect_right(T,d['t1'])-1
    a=max(0,i0-30);b=min(len(C)-1,max(i1+18,i0+36));b=min(b,i0+150)
    W,H=1200,700;ml,mr,mt,mb=24,250,118,64;pw=W-ml-mr;ph=H-mt-mb
    lo=min(x[3] for x in C[a:b+1]);hi=max(x[2] for x in C[a:b+1]);pad=(hi-lo)*0.06;lo-=pad;hi+=pad
    X=lambda i:ml+(i-a+0.5)*pw/(b-a+1);Y=lambda p:mt+(hi-p)/(hi-lo)*ph;cw=max(2,pw/(b-a+1)*0.62)
    o=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Inter,system-ui,Segoe UI,Arial,sans-serif"><rect width="{W}" height="{H}" fill="{SURF}"/>']
    o.append(f'<text x="{ml}" y="40" fill="{INK}" font-size="24" font-weight="600">{html.escape(title)}</text>')
    for n,line in enumerate(why): o.append(f'<text x="{ml}" y="{66+n*21}" fill="{INK2}" font-size="15">{html.escape(line)}</text>')
    # grid + y ticks
    step=next(sv for sv in (25,50,100,200,250,500) if (hi-lo)/sv<=7);p=(int(lo/step)+1)*step
    while p<hi:
        o.append(f'<line x1="{ml}" x2="{ml+pw}" y1="{Y(p):.1f}" y2="{Y(p):.1f}" stroke="{GRID}" stroke-width="1"/><text x="{ml+pw+8}" y="{Y(p)+4:.1f}" fill="{INK2}" font-size="12">{p:,.0f}</text>');p+=step
    # x ticks every 30 min
    for i in range(a,b+1):
        t=et(T[i])
        if t.minute in (0,30): o.append(f'<line x1="{X(i):.1f}" x2="{X(i):.1f}" y1="{mt+ph}" y2="{mt+ph+5}" stroke="{AXIS}"/>'+(f'<text x="{X(i):.1f}" y="{mt+ph+20}" fill="{INK2}" font-size="12" text-anchor="middle">{t:%H:%M}</text>' if t.minute==0 or (b-a)<60 else ''))
    o.append(f'<line x1="{ml}" x2="{ml+pw}" y1="{mt+ph}" y2="{mt+ph}" stroke="{AXIS}"/>')
    # trade window band
    o.append(f'<rect x="{X(i0)-cw/2:.1f}" y="{mt}" width="{max(cw,X(i1)-X(i0)+cw):.1f}" height="{ph}" fill="{INK}" opacity="0.06"/>')
    # levels (only those inside the price range), labelled at the right, de-collided
    labs=[]
    for name,p in levels(d['t0']).items():
        if lo<p<hi:
            o.append(f'<line x1="{ml}" x2="{ml+pw}" y1="{Y(p):.1f}" y2="{Y(p):.1f}" stroke="{INK2}" stroke-width="1" stroke-dasharray="5 5"/>');labs.append([Y(p),f'{name} {p:,.0f}',INK2])
    # candles
    for i in range(a,b+1):
        x=C[i];col=UP if x[4]>=x[1] else DN;yo,yc=Y(x[1]),Y(x[4])
        o.append(f'<line x1="{X(i):.1f}" x2="{X(i):.1f}" y1="{Y(x[2]):.1f}" y2="{Y(x[3]):.1f}" stroke="{col}" stroke-width="1.2"/><rect x="{X(i)-cw/2:.1f}" y="{min(yo,yc):.1f}" width="{cw:.1f}" height="{max(1.5,abs(yc-yo)):.1f}" fill="{col}"/>')
    # EMAs
    for k,(col,name) in enumerate(((BLUE,'EMA 20'),(ORANGE,'EMA 50'),(AQUA,'EMA 200'))):
        pts=' '.join(f'{X(i):.1f},{Y(min(hi,max(lo,E[i][k]))):.1f}' for i in range(a,b+1) if lo<=E[i][k]<=hi)
        if pts: o.append(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="2" stroke-linejoin="round"/>')
        if lo<E[b][k]<hi: labs.append([Y(E[b][k]),name,INK])
        o.append(f'<line x1="{W-mr-330+k*110}" x2="{W-mr-306+k*110}" y1="{mt-14}" y2="{mt-14}" stroke="{col}" stroke-width="2"/><text x="{W-mr-300+k*110}" y="{mt-10}" fill="{INK2}" font-size="12">{name}</text>')
    labs.sort()
    for n in range(1,len(labs)):
        if labs[n][0]-labs[n-1][0]<15: labs[n][0]=labs[n-1][0]+15
    for y,txt,col in labs: o.append(f'<text x="{ml+pw+52}" y="{y+4:.1f}" fill="{col}" font-size="12">{html.escape(txt)}</text>')
    # entry / exit on the futures tape (levels are the future's, your perp differs by the basis)
    C1=nq['1m'];T1=[x[0]/1000 for x in C1]
    fine=d['t0']>=T1[0] and d['t1']<=T1[-1]+60
    if fine:
        j0=bisect.bisect_right(T1,d['t0'])-1;j1=bisect.bisect_right(T1,d['t1']);w=C1[j0:j1];pe=w[0][1];px=w[-1][4]
    else:
        w=C[i0:i1+1];pe=C[i0][1];px=C[i1][4]
    heat=max(((pe-x[3]) if s==1 else (x[2]-pe)) for x in w);heat_lbl=f"worst heat {heat:.0f} pts" if fine else f"worst heat about {heat:.0f} pts (5-minute bars)"
    def mark(i,p,up,label,sub):
        y=Y(p);dy=14 if up else -14
        o.append(f'<path d="M{X(i):.1f},{y+dy*0.35:.1f} l-8,{dy:.1f} l16,0 z" fill="{INK}" stroke="{SURF}" stroke-width="2"/>')
        ty=y+dy*2.3+(4 if up else 0);anchor='end' if X(i)>ml+pw*0.72 else 'start';tx=X(i)+(-12 if anchor=='end' else 12)
        o.append(f'<text x="{tx:.1f}" y="{ty:.1f}" fill="{INK}" font-size="14" font-weight="600" text-anchor="{anchor}">{html.escape(label)}</text><text x="{tx:.1f}" y="{ty+17:.1f}" fill="{INK2}" font-size="12" text-anchor="{anchor}">{html.escape(sub)}</text>')
    mark(i0,pe,s==1,f"Entry {'long' if s==1 else 'short'} {et(d['t0']):%H:%M} ET","")
    mark(i1,px,s!=1,f"Exit {et(d['t1']):%H:%M}  +{d['move_pts']:.0f} pts",f"+${d['pnl']:,.0f} at {d['qty']:.1f} contracts")
    o.append(f'<text x="{ml}" y="{H-14}" fill="{INK2}" font-size="12">NQ future, 5-minute candles (Yahoo, recorded). Your Vest perp trades at a different level by the basis; entry and exit are marked at the future\'s price at those times.</text></svg>')
    open(fname,'w').write('\n'.join(o));return heat
pick=lambda ts:next(d for d in N if d['open_et'].startswith(ts))
OUT='/home/user/random/desk/research/winning-patterns/'
jobs=[('2026-11-17 10:01','1  With-trend short on a pullback to the EMA 20 · Tue Nov 17',['Trend down: price and EMA 50 below the EMA 200. Price bounced into the EMA 20 and a 5m bar closed back down.','After 10:00 ET, high volatility, first attempt. This is the setup your record supports best.'],'1-trend-pullback-short-nov17'),
      ('2026-11-19 11:49','2  With-trend short: rally into the EMA 20, sweep of the last hour\'s high, then back under · Thu Nov 19',['Downtrend day. Price popped above the prior hour\'s high, failed, and closed back below it at the EMA 20.','Entered after the close back under, in the direction of the trend. First attempt.'],'2-trend-sweep-reclaim-short-nov19'),
      ('2026-11-11 10:34','3  With-trend long with the day · Wed Nov 11',['Uptrend: price and EMA 50 above the EMA 200, price above the 09:30 open.','A 5m bar had already closed back up through the pullback low before entry. First attempt.'],'3-trend-continuation-long-nov11'),
      ('2026-11-20 10:17','4  With-trend short after a failed bounce · Fri Nov 20',['Downtrend. A bounce swept the last hour\'s high and closed back below it; entry on the turn, with the day.','Two small losses came just before this entry; the winner came once the bar had closed back down.'],'4-trend-failed-bounce-short-nov20'),
      ('2026-11-20 09:40','5  Opening flush reversal (counter-trend) · Fri Nov 20 · pays big, costs the most accounts',['Against the trend, in the first 15 minutes. This one worked on the first attempt.','The same pattern on Nov 12 and Nov 16 took 13 and 21 attempts and lost money overall. Only with a 5m reclaim.'],'5-open-reversal-long-nov20')]
for ts,title,why,fn in jobs:
    d=pick(ts);h=chart(d,title,why,OUT+fn+'.svg');print(fn,d['open_et'],d['side'],round(d['pnl']),'heat',round(h),'pts captured',round(d['move_pts']))
