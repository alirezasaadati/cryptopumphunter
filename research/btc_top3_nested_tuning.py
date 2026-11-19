#!/usr/bin/env python3
"""Nested walk-forward tuning of BTC trend classifiers. Validation selects parameters; test folds stay untouched. v3 with purged validation boundary."""
import json, math
from pathlib import Path
import numpy as np
import btc_trend_methods as base

ART=Path("artifacts"); ART.mkdir(exist_ok=True)
HORIZON=6
TRAIN_MIN=180*6
TEST=30*6
PURGE=12

def labels(close, vol):
    y=np.full(len(close),99,dtype=int)
    for i in range(len(close)-HORIZON):
        if not np.isfinite(vol[i]): continue
        r=close[i+HORIZON]/close[i]-1
        th=max(.004,.75*vol[i])
        y[i]=1 if r>th else (-1 if r < -th else 0)
    return y

def metric(y,p):
    labs=(-1,0,1); rec=[]
    for k in labs:
        m=y==k
        rec.append(float(np.mean(p[m]==k)) if np.any(m) else 0.)
    return float(np.mean(rec))

def struct_pred(ind,left,right,max_age):
    h,l=ind["h"],ind["l"]; out=np.zeros(len(h),dtype=int); hs=[];ls=[]
    for i in range(left+right+1,len(h)):
        p=i-right
        if h[p]>np.max(h[p-left:p]) and h[p]>=np.max(h[p+1:p+right+1]): hs.append((p,h[p]))
        if l[p]<np.min(l[p-left:p]) and l[p]<=np.min(l[p+1:p+right+1]): ls.append((p,l[p]))
        hs=[x for x in hs if i-x[0]<=max_age][-2:];ls=[x for x in ls if i-x[0]<=max_age][-2:]
        if len(hs)==2 and len(ls)==2:
            out[i]=1 if hs[-1][1]>hs[-2][1] and ls[-1][1]>ls[-2][1] else (-1 if hs[-1][1]<hs[-2][1] and ls[-1][1]<ls[-2][1] else 0)
    return out

def regression_pred(ind,lookback,threshold):
    c=ind["c"];atr=ind["atr"];out=np.zeros(len(c),dtype=int);x=np.arange(lookback,dtype=float);x-=x.mean();den=np.dot(x,x)
    for i in range(lookback-1,len(c)):
        yy=c[i-lookback+1:i+1]
        slope=np.dot(x,yy-yy.mean())/den/max(atr[i],1e-12)
        out[i]=1 if slope>threshold else (-1 if slope < -threshold else 0)
    return out

def hmm_fit(X,k,iterations):
    n,d=X.shape; order=np.argsort(X[:,0]); means=np.vstack([np.mean(X[order[j*n//k:(j+1)*n//k]],axis=0) for j in range(k)])
    var=np.tile(np.maximum(np.var(X,axis=0),.05),(k,1)); A=np.full((k,k),.08/(k-1));np.fill_diagonal(A,.92);pi=np.full(k,1/k)
    lse=base.logsumexp
    for _ in range(iterations):
        diff=X[:,None,:]-means[None,:,:]; B=-.5*np.sum(np.log(2*np.pi*var)[None,:,:]+diff*diff/var[None,:,:],axis=2)
        alpha=np.zeros((n,k));scale=np.zeros(n);alpha[0]=np.log(pi+1e-300)+B[0];scale[0]=lse(alpha[0]);alpha[0]-=scale[0]
        for t in range(1,n):
            alpha[t]=B[t]+lse(alpha[t-1][:,None]+np.log(A+1e-300),axis=0);scale[t]=lse(alpha[t]);alpha[t]-=scale[t]
        beta=np.zeros((n,k))
        for t in range(n-2,-1,-1): beta[t]=lse(np.log(A+1e-300)+B[t+1][None,:]+beta[t+1][None,:],axis=1)-scale[t+1]
        gamma=np.exp(alpha+beta-lse(alpha+beta,axis=1)[:,None]); xi=np.zeros((k,k))
        for t in range(n-1):
            z=alpha[t][:,None]+np.log(A+1e-300)+B[t+1][None,:]+beta[t+1][None,:];xi+=np.exp(z-lse(z))
        pi=gamma[0]+1e-5;pi/=pi.sum();A=xi+1e-3;A/=A.sum(axis=1,keepdims=True)
        for j in range(k):
            w=gamma[:,j]; sw=w.sum()+1e-12; means[j]=(w[:,None]*X).sum(axis=0)/sw
            var[j]=(w[:,None]*(X-means[j])**2).sum(axis=0)/sw
        var=np.maximum(var,.025)
    return pi,A,means,var

def hmm_filter(X,params):
    pi,A,means,var=params; p=np.log(pi+1e-300); out=np.zeros(len(X),dtype=int); lse=base.logsumexp
    for i,z in enumerate(X):
        d=z[None,:]-means;b=-.5*np.sum(np.log(2*np.pi*var)+d*d/var,axis=1)
        p=lse(p[:,None]+np.log(A+1e-300),axis=0)+b;p-=lse(p);out[i]=int(np.argmax(p))
    return out

def state_map(states,y):
    ret=[]
    for s in range(int(states.max())+1):
        ix=np.where((states==s)&(y!=99))[0]
        # Future direction labels are used only within the training segment to assign state meaning.
        ret.append(float(np.mean(y[ix])) if len(ix) else 0.)
    order=np.argsort(ret); mapping={int(order[0]):-1,int(order[-1]):1}
    for s in order[1:-1]: mapping[int(s)]=0
    return mapping

def hmm_predictions(X, y_train, k, iters, train_end, eval_end):
    # X is already standardized using train-only statistics.
    params=hmm_fit(X[:train_end],k,iters)
    states=hmm_filter(X[:train_end],params)
    mapping=state_map(states,y_train[:train_end])
    all_states=hmm_filter(X[:eval_end],params)
    return np.array([mapping[int(s)] for s in all_states])

def main():
    a=base.load_data();ind=base.indicators(a);n=len(a);c=ind["c"];vol=ind["vol6"];y=labels(c,vol)
    # Chronological expanding test folds; 20% of each available history is validation.
    starts=list(range(max(TRAIN_MIN,int(n*.52)),n-TEST//2,TEST))
    if not starts: raise RuntimeError("Not enough bars for nested walk-forward evaluation")
    rows=[];selected=[]
    for fold,start in enumerate(starts,1):
        tr_end=start-PURGE
        val_start=max(250,int(tr_end*.80))
        val_idx=np.arange(val_start,tr_end-HORIZON)
        val_idx=val_idx[y[val_idx]!=99]
        if len(val_idx)<80: continue
        # Select structure and regression parameters on the chronological validation tail only.
        candidates=[]
        for left in (2,3,4):
          for right in (2,3,4):
            for age in (60,120,180):
              p=struct_pred(ind,left,right,age)
              candidates.append((metric(y[val_idx],p[val_idx]),{"left":left,"right":right,"max_age":age}))
        best_s=max(candidates,key=lambda z:z[0])
        candidates=[]
        for lb in (12,18,30,48):
          for th in (.025,.05,.075,.10,.15):
            p=regression_pred(ind,lb,th)
            candidates.append((metric(y[val_idx],p[val_idx]),{"lookback":lb,"threshold":th}))
        best_r=max(candidates,key=lambda z:z[0])
        # HMM: fit only on the pre-validation training segment, score on validation.
        X=base.features(ind,0,tr_end)
        hmm_candidates=[]
        for k in (2,3,4):
          for iters in (20,35):
            pred=hmm_predictions(X,y,k,iters,val_train_end,val_idx[-1]+1)
            hmm_candidates.append((metric(y[val_idx],pred[val_idx]),{"states":k,"iterations":iters}))
        best_h=max(hmm_candidates,key=lambda z:z[0])
        # Refit selected HMM on all history up to the purged test boundary.
        Xfull=base.features(ind,0,tr_end)
        params=hmm_fit(Xfull[100:tr_end],best_h[1]["states"],best_h[1]["iterations"])
        st=hmm_filter(Xfull[100:start+TEST],params)
        train_states=hmm_filter(Xfull[100:tr_end],params)
        # Map states from training-only forward returns.
        train_y=y[100:tr_end];mapping=state_map(train_states,train_y)
        hp=np.array([mapping[int(s)] for s in st[start-100: min(start+TEST-100,len(st))]])
        test_end=min(start+TEST,n-HORIZON);ix=np.arange(start,test_end);ix=ix[y[ix]!=99]
        sp=struct_pred(ind,**best_s[1]);rp=regression_pred(ind,**best_r[1])
        fold_preds={"Market Structure":sp,"Linear Regression":rp,"HMM":np.pad(hp,(0,max(0,TEST-len(hp))),constant_values=0)[:TEST]}
        selected.append({"fold":fold,"validation_scores":{"structure":best_s[0],"regression":best_r[0],"hmm":best_h[0]},
                         "parameters":{"structure":best_s[1],"regression":best_r[1],"hmm":best_h[1]}})
        for name,p in fold_preds.items():
            pp=p[ix-start]; yy=y[ix]
            rows.append({"fold":fold,"method":name,"n":len(ix),"balanced_accuracy":metric(yy,pp),
                         "accuracy":float(np.mean(yy==pp)),"predicted_coverage":float(np.mean(pp!=0)),
                         "predicted_switches":int(np.sum(pp[1:]!=pp[:-1]))})
    summary=[]
    for name in ("HMM","Market Structure","Linear Regression"):
        rr=[r for r in rows if r["method"]==name]
        w=np.array([r["n"] for r in rr],float)
        summary.append({"method":name,"folds":len(rr),"n":int(w.sum()),
          "balanced_accuracy":float(np.average([r["balanced_accuracy"] for r in rr],weights=w)),
          "accuracy":float(np.average([r["accuracy"] for r in rr],weights=w)),
          "predicted_coverage":float(np.average([r["predicted_coverage"] for r in rr],weights=w)),
          "predicted_switches":sum(r["predicted_switches"] for r in rr)})
    summary.sort(key=lambda z:-z["balanced_accuracy"])
    out={"symbol":"BTCUSDT","interval":"4h","primary_horizon":"24h","label":"forward 24h return; bull/bear threshold=max(0.4%, 0.75x trailing 24h realized volatility)",
         "method":"Nested chronological walk-forward; per-fold 80/20 train-validation split; 12-bar purge; validation-only parameter selection; final test windows never used for tuning",
         "test_fold_rows":rows,"selected_parameters":selected,"ranking":summary,
         "limitations":"Single BTCUSDT USD-M perpetual series; fixed label definition; short one-year sample; tuning choices are constrained grids, not exhaustive optimization."}
    path=ART/"btc-top3-nested-tuning.json";path.write_text(json.dumps(out,indent=2))
    print("FINAL TEST RANKING (24h)")
    for r in summary: print(f'{r["method"]}: balanced_accuracy={r["balanced_accuracy"]:.4f}, accuracy={r["accuracy"]:.4f}, coverage={r["predicted_coverage"]:.3f}, n={r["n"]}')
    print("FOLD PARAMETER SELECTION")
    for x in selected: print(json.dumps(x,sort_keys=True))
    print(f"ARTIFACT {path}")

if __name__=="__main__": main()
