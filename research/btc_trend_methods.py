#!/usr/bin/env python3
"""BTCUSDT-only, causal, walk-forward comparison of seven 4h trend classifiers."""
import csv, io, json, math, time, urllib.request, zipfile
from datetime import datetime, timezone
from pathlib import Path
import numpy as np

SYMBOL = "BTCUSDT"
INTERVAL = "4h"
HORIZONS = {"12h": 3, "24h": 6, "48h": 12}
TRAIN_BARS = 180 * 6
TEST_BARS = 30 * 6
PURGE_BARS = 12
ART = Path("artifacts")
ART.mkdir(exist_ok=True)

def fetch_month(year, month):
    name = f"{SYMBOL}-{INTERVAL}-{year}-{month:02d}.zip"
    url = f"https://data.binance.vision/data/futures/um/monthly/klines/{SYMBOL}/{INTERVAL}/{name}"
    req = urllib.request.Request(url, headers={"User-Agent": "BTC-trend-research/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r: raw = r.read()
    except Exception as e:
        print(f"DATA_WARNING {name}: {e}")
        return []
    with zipfile.ZipFile(io.BytesIO(raw)) as z: text = z.read(z.namelist()[0]).decode("utf-8")
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7 or not row[0].isdigit(): continue
        try:
            t=int(row[0]); vals=[float(row[i]) for i in range(1,6)]; close_t=int(row[6])
            if vals[0]>0 and vals[1]>=vals[2]>0 and vals[3]>0:
                rows.append([t,vals[0],vals[1],vals[2],vals[3],vals[4],close_t])
        except Exception: pass
    return rows

def load_data():
    now=int(time.time()*1000); start=now-370*86400000
    d=datetime.fromtimestamp(start/1000,timezone.utc); end=datetime.fromtimestamp(now/1000,timezone.utc)
    rows=[]; y,m=d.year,d.month
    while (y,m)<=(end.year,end.month):
        rows.extend(fetch_month(y,m)); m+=1
        if m==13: y,m=y+1,1
    by_time={r[0]:r for r in rows if start<=r[0]<now and r[6]<now}
    data=sorted(by_time.values(),key=lambda r:r[0])
    if len(data)<1200: raise RuntimeError(f"Insufficient BTC 4h history: {len(data)} rows")
    arr=np.asarray(data,dtype=float); gaps=int(np.sum(np.diff(arr[:,0])>4*3600000*1.5))
    print(f"DATA symbol={SYMBOL} interval={INTERVAL} bars={len(arr)} gaps={gaps} first={datetime.fromtimestamp(arr[0,0]/1000,timezone.utc).isoformat()} last={datetime.fromtimestamp(arr[-1,0]/1000,timezone.utc).isoformat()}")
    if gaps: raise RuntimeError(f"Data contains {gaps} gaps; refusing to publish misleading metrics")
    return arr

def ema(x,n):
    out=np.full(len(x),np.nan)
    if len(x)<n:return out
    out[n-1]=np.mean(x[:n]); alpha=2/(n+1)
    for i in range(n,len(x)):out[i]=alpha*x[i]+(1-alpha)*out[i-1]
    return out

def rolling_mean(x,n):
    out=np.full(len(x),np.nan)
    if len(x)>=n:
        cs=np.r_[0.,np.cumsum(x)];out[n-1:]=(cs[n:]-cs[:-n])/n
    return out

def indicators(a):
    o,h,l,c,v=[a[:,i] for i in range(1,6)]; prev=np.r_[c[0],c[:-1]]
    tr=np.maximum(h-l,np.maximum(np.abs(h-prev),np.abs(l-prev))); atr=ema(tr,14)
    up=np.r_[0.,np.diff(h)]; down=np.r_[0.,-np.diff(l)]
    plus_dm=np.where((up>down)&(up>0),up,0.)
    minus_dm=np.where((down>up)&(down>0),down,0.)
    def wilder(x,n):
        z=np.full(len(x),np.nan)
        if len(x)>n:
            z[n]=np.mean(x[1:n+1])
            for k in range(n+1,len(x)):z[k]=(z[k-1]*(n-1)+x[k])/n
        return z
    trw=wilder(tr,14);pdm=wilder(plus_dm,14);mdm=wilder(minus_dm,14)
    pdi=100*pdm/np.maximum(trw,1e-12);mdi=100*mdm/np.maximum(trw,1e-12)
    dx=100*np.abs(pdi-mdi)/np.maximum(pdi+mdi,1e-12);adx=wilder(np.nan_to_num(dx,nan=0),14)
    mid=(h+l)/2;upper=mid+3*atr;lower=mid-3*atr
    st=np.full(len(c),np.nan);st_dir=np.zeros(len(c),dtype=int)
    for i in range(1,len(c)):
        if not np.isfinite(atr[i]):continue
        if np.isfinite(st[i-1]):
            upper[i]=min(upper[i],upper[i-1]) if c[i-1]<=upper[i-1] else upper[i]
            lower[i]=max(lower[i],lower[i-1]) if c[i-1]>=lower[i-1] else lower[i]
            st_dir[i]=(1 if c[i]>=lower[i] else -1) if st_dir[i-1]>=0 else (-1 if c[i]<=upper[i] else 1)
        else:st_dir[i]=1 if c[i]>=mid[i] else -1
        st[i]=lower[i] if st_dir[i]>=0 else upper[i]
    reg=np.full(len(c),np.nan);xx=np.arange(30,dtype=float);xx-=xx.mean();denom=np.sum(xx*xx)
    for i in range(29,len(c)):
        yy=c[i-29:i+1];reg[i]=(np.dot(xx,yy-yy.mean())/denom)/max(atr[i],1e-12)
    lr=np.r_[0.,np.diff(np.log(c))];vol6=np.full(len(c),np.nan)
    for i in range(6,len(c)):vol6[i]=np.std(lr[i-5:i+1],ddof=1)*math.sqrt(6)
    return dict(o=o,h=h,l=l,c=c,v=v,atr=atr,pdi=pdi,mdi=mdi,adx=adx,st_dir=st_dir,reg=reg,lr=lr,vol6=vol6)

def market_structure(ind):
    h,l=ind["h"],ind["l"];n=len(h);out=np.zeros(n,dtype=int);highs=[];lows=[]
    for i in range(7,n):
        p=i-3
        if h[p]>np.max(h[p-3:p]) and h[p]>=np.max(h[p+1:p+4]):highs.append((p,h[p]))
        if l[p]<np.min(l[p-3:p]) and l[p]<=np.min(l[p+1:p+4]):lows.append((p,l[p]))
        highs=[x for x in highs if i-x[0]<=120][-2:];lows=[x for x in lows if i-x[0]<=120][-2:]
        if len(highs)==2 and len(lows)==2:
            hh=highs[-1][1]>highs[-2][1];hl=lows[-1][1]>lows[-2][1]
            lh=highs[-1][1]<highs[-2][1];ll=lows[-1][1]<lows[-2][1]
            out[i]=1 if hh and hl else (-1 if lh and ll else 0)
    return out

def ema_sma(ind):
    c=ind["c"];e20=ema(c,20);e50=ema(c,50);s20=rolling_mean(c,20);s50=rolling_mean(c,50)
    prev50=np.r_[np.full(5,np.nan),e50[:-5]];out=np.zeros(len(c),dtype=int)
    out[(e20>e50)&(s20>s50)&(e50>prev50)]=1;out[(e20<e50)&(s20<s50)&(e50<prev50)]=-1
    return out

def adx_dmi(ind):
    out=np.zeros(len(ind["c"]),dtype=int);strong=ind["adx"]>=20
    out[strong&(ind["pdi"]>ind["mdi"])]=1;out[strong&(ind["mdi"]>ind["pdi"])]=-1
    return out

def regression(ind):
    s=ind["reg"];out=np.zeros(len(s),dtype=int);out[s>.08]=1;out[s<-.08]=-1
    return out

def kalman_trend(ind):
    c=ind["c"];atr=ind["atr"];n=len(c);out=np.zeros(n,dtype=int)
    x=np.array([c[0],0.]);P=np.diag([max(c[0]*.01,1.)**2,max(c[0]*.001,1.)**2])
    F=np.array([[1.,1.],[0.,1.]]);Q=np.diag([1e-5,2e-7]);H=np.array([[1.,0.]])
    for i in range(1,n):
        scale=max(atr[i-1] if np.isfinite(atr[i-1]) else c[i]*.005,c[i]*.0005);R=(scale*.35)**2
        xp=F@x;Pp=F@P@F.T+Q*scale*scale
        innovation=c[i]-(H@xp).item();S=(H@Pp@H.T).item()+R
        K=(Pp@H.T)/S;x=xp+K[:,0]*innovation;P=(np.eye(2)-K@H)@Pp
        threshold=max(scale*.012,c[i]*.00008)
        out[i]=1 if x[1]>threshold else (-1 if x[1]<-threshold else 0)
    return out

def features(ind,start,end):
    lr=ind["lr"];c=ind["c"];atr=ind["atr"];v=ind["v"];volz=np.zeros(len(c))
    for i in range(30,len(c)):
        volz[i]=(v[i]-np.mean(v[i-20:i]))/(np.std(v[i-20:i])+1e-12)
    conv=np.convolve(lr,np.ones(3),mode="valid")
    f=np.column_stack([lr,np.r_[0.,lr[:-1]],np.r_[np.zeros(3),conv[:len(lr)-3]],np.log(np.maximum(atr/c,1e-8)),volz])
    f=np.nan_to_num(f,nan=0,posinf=0,neginf=0)
    mu=np.mean(f[start:end],axis=0);sd=np.std(f[start:end],axis=0);sd=np.where(sd<1e-8,1,sd)
    return np.clip((f-mu)/sd,-8,8)

def logsumexp(x,axis=None):
    m=np.max(x,axis=axis,keepdims=True);z=m+np.log(np.sum(np.exp(x-m),axis=axis,keepdims=True)+1e-300)
    return np.squeeze(z,axis=axis) if axis is not None else float(z.ravel()[0])

def fit_hmm(X,iterations=35):
    n,d=X.shape;k=3;order=np.argsort(X[:,0])
    means=np.vstack([np.mean(X[order[j*n//k:(j+1)*n//k]],axis=0) for j in range(k)])
    vars_=np.tile(np.maximum(np.var(X,axis=0),.08),(k,1));A=np.full((k,k),.08);np.fill_diagonal(A,.84);pi=np.full(k,1/k)
    def emission(z):
        diff=z[:,None,:]-means[None,:,:]
        return -.5*np.sum(np.log(2*np.pi*vars_)[None,:,:]+diff*diff/vars_[None,:,:],axis=2)
    for _ in range(iterations):
        B=emission(X);alpha=np.zeros((n,k));scales=np.zeros(n)
        alpha[0]=np.log(pi+1e-300)+B[0];scales[0]=logsumexp(alpha[0]);alpha[0]-=scales[0]
        for t in range(1,n):
            alpha[t]=B[t]+logsumexp(alpha[t-1][:,None]+np.log(A+1e-300),axis=0)
            scales[t]=logsumexp(alpha[t]);alpha[t]-=scales[t]
        beta=np.zeros((n,k))
        for t in range(n-2,-1,-1):beta[t]=logsumexp(np.log(A+1e-300)+B[t+1][None,:]+beta[t+1][None,:],axis=1)-scales[t+1]
        gamma=np.exp(alpha+beta-logsumexp(alpha+beta,axis=1)[:,None]);xi=np.zeros((k,k))
        for t in range(n-1):
            z=alpha[t][:,None]+np.log(A+1e-300)+B[t+1][None,:]+beta[t+1][None,:];xi+=np.exp(z-logsumexp(z))
        pi=gamma[0]+1e-5;pi/=pi.sum();A=xi+1e-3;A/=A.sum(axis=1,keepdims=True)
        for j in range(k):
            w=gamma[:,j];sw=w.sum()+1e-12;means[j]=(w[:,None]*X).sum(axis=0)/sw
            vars_[j]=(w[:,None]*(X-means[j])**2).sum(axis=0)/sw
        vars_=np.maximum(vars_,.03)
    return pi,A,means,vars_

def hmm_filter(X,params):
    pi,A,means,vars_=params;out=np.zeros(len(X),dtype=int);p=np.log(pi+1e-300)
    for t,z in enumerate(X):
        diff=z[None,:]-means;b=-.5*np.sum(np.log(2*np.pi*vars_)+diff*diff/vars_,axis=1)
        p=logsumexp(p[:,None]+np.log(A+1e-300),axis=0)+b;p-=logsumexp(p);out[t]=int(np.argmax(p))
    return out

def make_labels(ind,bars):
    c=ind["c"];vol=ind["vol6"];y=np.full(len(c),99,dtype=int)
    for i in range(len(c)-bars):
        if not np.isfinite(vol[i]):continue
        r=c[i+bars]/c[i]-1;threshold=max(.004,.75*vol[i])
        y[i]=1 if r>threshold else (-1 if r < -threshold else 0)
    return y

def scores(y,p):
    cm=np.zeros((3,3),dtype=int);labels=[-1,0,1]
    for a,b in zip(y,p):cm[labels.index(int(a)),labels.index(int(b))]+=1
    precision=[];recall=[];f1=[]
    for j in range(3):
        tp=cm[j,j];fp=cm[:,j].sum()-tp;fn=cm[j,:].sum()-tp
        pr=tp/(tp+fp) if tp+fp else 0;re=tp/(tp+fn) if tp+fn else 0
        precision.append(pr);recall.append(re);f1.append(2*pr*re/(pr+re) if pr+re else 0)
    return dict(n=int(len(y)),accuracy=float(np.mean(y==p)),balanced_accuracy=float(np.mean(recall)),macro_f1=float(np.mean(f1)),
      precision_bear=float(precision[0]),precision_sideways=float(precision[1]),precision_bull=float(precision[2]),
      recall_bear=float(recall[0]),recall_sideways=float(recall[1]),recall_bull=float(recall[2]),
      confusion_matrix=cm.tolist(),predicted_coverage=float(np.mean(p!=0)),
      predicted_switches=int(np.sum(p[1:]!=p[:-1])),actual_switches=int(np.sum(y[1:]!=y[:-1])))

def main():
    a=load_data();ind=indicators(a);n=len(a);c=ind["c"]
    methods={"Market Structure":market_structure(ind),"EMA/SMA":ema_sma(ind),"ADX/DMI":adx_dmi(ind),
      "Supertrend/ATR":ind["st_dir"].copy(),"Linear Regression":regression(ind),"Kalman Filter":kalman_trend(ind)}
    all_results=[];prediction_rows=[];first_test=max(TRAIN_BARS,int(n*.52))
    starts=list(range(first_test,n-TEST_BARS//2,TEST_BARS))
    if not starts:starts=[first_test]
    labels_by_h={h:make_labels(ind,b) for h,b in HORIZONS.items()}
    for fold,start in enumerate(starts,1):
        end=min(start+TEST_BARS,n);train_end=start-PURGE_BARS
        if train_end<300:continue
        X=features(ind,0,train_end);params=fit_hmm(X[100:train_end])
        train_states=hmm_filter(X[100:train_end],params);fwd=np.full(train_end-100,np.nan)
        for j in range(len(fwd)-6):fwd[j]=c[100+j+6]/c[100+j]-1
        state_mean=[]
        for s in range(3):
            mask=(train_states==s)&np.isfinite(fwd);state_mean.append(float(np.mean(fwd[mask])) if np.any(mask) else 0.)
        order=np.argsort(state_mean);mapping={int(order[0]):-1,int(order[1]):0,int(order[2]):1}
        # Carry the forward-filter state from the training history into the test fold.
        test_states=hmm_filter(X[100:end],params)[start-100:]
        methods_fold={k:v[start:end].copy() for k,v in methods.items()}
        methods_fold["HMM"]=np.array([mapping[int(s)] for s in test_states],dtype=int)
        for horizon_name,bars in HORIZONS.items():
            yall=labels_by_h[horizon_name];valid_end=max(start,end-bars);idx=np.arange(start,valid_end);idx=idx[yall[idx]!=99]
            for name,pred in methods_fold.items():
                p=pred[idx-start];result=scores(yall[idx],p)
                all_results.append(dict(fold=fold,method=name,horizon=horizon_name,train_bars=int(train_end),test_start=int(start),test_end=int(valid_end),**result))
                if horizon_name=="24h":
                    for q,yy,pp in zip(idx,yall[idx],p):
                        prediction_rows.append(dict(time_utc=datetime.fromtimestamp(a[q,0]/1000,timezone.utc).isoformat(),fold=fold,method=name,actual=int(yy),predicted=int(pp)))
    summary=[]
    for horizon in HORIZONS:
        for name in list(methods.keys())+["HMM"]:
            rows=[r for r in all_results if r["horizon"]==horizon and r["method"]==name]
            if not rows:continue
            weights=np.array([r["n"] for r in rows],dtype=float)
            summary.append(dict(method=name,horizon=horizon,folds=len(rows),n=int(weights.sum()),
              accuracy=float(np.average([r["accuracy"] for r in rows],weights=weights)),
              balanced_accuracy=float(np.average([r["balanced_accuracy"] for r in rows],weights=weights)),
              macro_f1=float(np.average([r["macro_f1"] for r in rows],weights=weights)),
              predicted_coverage=float(np.average([r["predicted_coverage"] for r in rows],weights=weights)),
              predicted_switches=int(sum(r["predicted_switches"] for r in rows)),actual_switches=int(sum(r["actual_switches"] for r in rows))))
    summary.sort(key=lambda r:(r["horizon"],-r["balanced_accuracy"],-r["macro_f1"]))
    stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    payload={"symbol":SYMBOL,"interval":INTERVAL,"label":"forward return over horizon vs 0.75x trailing realized volatility, min 0.4%",
      "walk_forward":"expanding chronological training, 30d test folds, 12-bar purge; 4h Binance USD-M futures klines",
      "limitations":"BTCUSDT perpetual futures only; 370d source window; fixed rule thresholds; HMM states mapped using train-only forward returns",
      "summary":summary,"folds":all_results}
    with open(ART/f"btc-trend-summary-{stamp}.json","w") as f:json.dump(payload,f,indent=2)
    with open(ART/f"btc-trend-predictions-{stamp}.csv","w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=list(prediction_rows[0].keys()));w.writeheader();w.writerows(prediction_rows)
    print("RANKING")
    for h in HORIZONS:
        print(h)
        for r in [x for x in summary if x["horizon"]==h]:
            print(f'{r["method"]:22s} balanced_acc={r["balanced_accuracy"]:.4f} macro_f1={r["macro_f1"]:.4f} accuracy={r["accuracy"]:.4f} coverage={r["predicted_coverage"]:.3f} n={r["n"]}')
    print(f"ARTIFACTS {ART.resolve()}")

if __name__=="__main__":main()
