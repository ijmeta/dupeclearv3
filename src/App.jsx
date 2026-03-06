import { useState, useCallback, useRef, useEffect, useMemo } from "react";

const IS_ELECTRON = typeof window !== "undefined" && !!window.electronAPI;

async function sha256(buffer) {
  const h = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,"0")).join("");
}
function fmtBytes(b) {
  if (!b) return "0 B";
  const u=["B","KB","MB","GB","TB"],i=Math.min(Math.floor(Math.log(b)/Math.log(1024)),4);
  return (b/Math.pow(1024,i)).toFixed(i>1?1:0)+" "+u[i];
}
function fmtDate(ts){ return new Date(ts).toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"}); }
function fmtTime(s){ return s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`; }

const S={HOME:"home",SCANNING:"scanning",SUMMARY:"summary",REVIEW:"review",CONFIRM:"confirm",RESULTS:"results"};

export default function App() {
  const [screen,setScreen]             = useState(S.HOME);
  const [rawFiles,setRawFiles]         = useState([]);
  const [folderName,setFolderName]     = useState("");
  const [recursive,setRecursive]       = useState(true);
  const [extFilter,setExtFilter]       = useState([".jpg",".jpeg",".png",".gif",".bmp",".tiff",".tif",".webp",".heic",".raw"]);
  const [scanProgress,setScanProgress] = useState(0);
  const [scanStatus,setScanStatus]     = useState("");
  const [scanElapsed,setScanElapsed]   = useState(0);
  const [liveGroups,setLiveGroups]     = useState(0);
  const [liveBytes,setLiveBytes]       = useState(0);
  const [isPaused,setIsPaused]         = useState(false);
  const [groups,setGroups]             = useState([]);
  const [decisions,setDecisions]       = useState({});
  const [statuses,setStatuses]         = useState({});
  const [gIdx,setGIdx]                 = useState(0);
  const [zoom,setZoom]                 = useState(null);
  const [deleted,setDeleted]           = useState([]);
  const [errors,setErrors]             = useState([]);
  const fileRef  = useRef(null);
  const cancelRef= useRef(false);
  const pauseRef = useRef(false);
  const timerRef = useRef(null);

  const onFiles = useCallback(e => {
    const all = Array.from(e.target.files);
    if (!all.length) return;
    const imgs = all.filter(f => extFilter.includes("."+f.name.split(".").pop().toLowerCase()));
    setRawFiles(imgs);
    setFolderName(all[0].webkitRelativePath?.split("/")[0] || "Selected Folder");
  }, [extFilter]);

  const pickFolder = useCallback(async () => {
    if (IS_ELECTRON) {
      const p = await window.electronAPI.openFolder();
      if (!p) return;
      setFolderName(p.split(/[\/\\]/).pop() || p);
      const files = await window.electronAPI.readFolder(p, recursive);
      setRawFiles(files.filter(f => extFilter.includes(f.ext)));
    } else { fileRef.current?.click(); }
  }, [recursive, extFilter]);

  const startScan = useCallback(async () => {
    if (!rawFiles.length) return;
    setScreen(S.SCANNING);
    setScanProgress(0); setScanStatus(""); setScanElapsed(0); setLiveGroups(0); setLiveBytes(0);
    cancelRef.current=false; pauseRef.current=false; setIsPaused(false);
    const t0=Date.now();
    timerRef.current=setInterval(()=>setScanElapsed(Math.floor((Date.now()-t0)/1000)),500);
    const map={}, total=rawFiles.length;
    for (let i=0;i<total;i++) {
      while (pauseRef.current) await new Promise(r=>setTimeout(r,200));
      if (cancelRef.current) { clearInterval(timerRef.current); setScreen(S.HOME); return; }
      const f=rawFiles[i];
      setScanStatus(f.name); setScanProgress(Math.round((i/total)*100));
      try {
        let buf;
        if (IS_ELECTRON && f.path) { const res=await window.electronAPI.readFile(f.path); if (!res.ok) throw new Error(res.error); buf=res.data.buffer; }
        else { buf=await f.arrayBuffer(); }
        const h=await sha256(buf);
        if (!map[h]) map[h]=[];
        map[h].push(f);
      } catch {}
      if (i%8===0) {
        const cur=Object.values(map).filter(g=>g.length>1);
        setLiveGroups(cur.length);
        setLiveBytes(cur.reduce((s,g)=>s+g.slice(1).reduce((a,f)=>a+f.size,0),0));
        await new Promise(r=>setTimeout(r,0));
      }
    }
    clearInterval(timerRef.current);
    setScanProgress(100); setScanStatus("Almost done…");
    await new Promise(r=>setTimeout(r,150));
    const raw=Object.values(map).filter(g=>g.length>1);
    const built=[];
    for (const grp of raw) {
      const items=[];
      for (const f of grp) {
        let url=null;
        if (IS_ELECTRON && f.path) { try { const res=await window.electronAPI.readFile(f.path); if (res.ok) url=URL.createObjectURL(new Blob([res.data])); } catch {} }
        else { url=URL.createObjectURL(f); }
        items.push({ file:f, name:f.name, size:f.size, modified:IS_ELECTRON?f.modified:f.lastModified, path:IS_ELECTRON?(f.path||f.name):(f.webkitRelativePath||f.name), url, dim:null });
      }
      for (const it of items) {
        await new Promise(res=>{ const img=new Image(); img.onload=()=>{ it.dim=`${img.naturalWidth}×${img.naturalHeight}`; res(); }; img.onerror=res; img.src=it.url; });
      }
      built.push({ items });
    }
    setGroups(built); setDecisions({}); setStatuses({}); setGIdx(0);
    setScreen(S.SUMMARY);
  }, [rawFiles]);

  const togglePause = () => { pauseRef.current=!pauseRef.current; setIsPaused(p=>!p); };
  const cancelScan  = () => { cancelRef.current=true; clearInterval(timerRef.current); };

  const toggleDel = (gi,fi) => {
    setDecisions(prev => {
      const s=new Set(prev[gi]||[]);
      if (s.has(fi)) { s.delete(fi); } else { if (s.size>=groups[gi].items.length-1) return prev; s.add(fi); }
      return {...prev,[gi]:s};
    });
  };
  const autoOlder = gi => {
    const grp=groups[gi].items; let newest=0;
    grp.forEach((it,i)=>{ if (it.modified>grp[newest].modified) newest=i; });
    const s=new Set(); grp.forEach((_,i)=>{ if (i!==newest) s.add(i); });
    setDecisions(prev=>({...prev,[gi]:s}));
  };
  const confirmGrp = gi => { setStatuses(p=>({...p,[gi]:"reviewed"})); if (gi<groups.length-1) setGIdx(gi+1); };
  const skipGrp    = gi => { setStatuses(p=>({...p,[gi]:"skipped"}));  if (gi<groups.length-1) setGIdx(gi+1); };

  const executeDel = async (permanent=false) => {
    const del=[],err=[];
    for (const [gi,s] of Object.entries(decisions)) {
      for (const fi of s) {
        const it=groups[+gi].items[fi];
        try {
          if (IS_ELECTRON && it.path) {
            const res=permanent?await window.electronAPI.deleteFile(it.path):await window.electronAPI.trashFile(it.path);
            if (!res.ok) throw new Error(res.error);
          }
          if (it.url) URL.revokeObjectURL(it.url);
          del.push(it);
        } catch(e) { err.push({it,reason:e.message}); }
      }
    }
    setDeleted(del); setErrors(err); setScreen(S.RESULTS);
  };

  useEffect(() => {
    if (screen!==S.REVIEW) return;
    const h=e=>{
      if (e.key==="ArrowRight"||e.key==="ArrowDown") setGIdx(i=>Math.min(i+1,groups.length-1));
      if (e.key==="ArrowLeft" ||e.key==="ArrowUp")   setGIdx(i=>Math.max(i-1,0));
      if (e.key==="Enter")  confirmGrp(gIdx);
      if (e.key==="Escape") setZoom(null);
    };
    window.addEventListener("keydown",h);
    return ()=>window.removeEventListener("keydown",h);
  }, [screen,gIdx,groups.length]);

  const reset = () => {
    groups.forEach(g=>g.items.forEach(it=>{ try { if(it.url) URL.revokeObjectURL(it.url); } catch {} }));
    setRawFiles([]); setFolderName(""); setGroups([]); setDecisions({});
    setStatuses({}); setGIdx(0); setDeleted([]); setErrors([]); setScreen(S.HOME);
  };

  const totalSize    = rawFiles.reduce((s,f)=>s+f.size,0);
  const totalWasted  = groups.reduce((s,g)=>{ const sz=g.items.map(i=>i.size).sort((a,b)=>b-a); return s+sz.slice(1).reduce((a,v)=>a+v,0); },0);
  const markedCount  = Object.values(decisions).reduce((s,set)=>s+set.size,0);
  const markedBytes  = Object.entries(decisions).reduce((s,[gi,set])=>{ set.forEach(fi=>{s+=groups[+gi]?.items[fi]?.size||0;}); return s; },0);
  const reviewedCount= Object.values(statuses).filter(v=>v==="reviewed").length;

  return (
    <div className="app">
      <AppHeader screen={screen} reset={reset} />
      <main className="main">
        {screen===S.HOME     && <HomeScreen rawFiles={rawFiles} folderName={folderName} totalSize={totalSize} recursive={recursive} setRecursive={setRecursive} extFilter={extFilter} setExtFilter={setExtFilter} fileRef={fileRef} onFiles={onFiles} pickFolder={pickFolder} startScan={startScan} />}
        {screen===S.SCANNING && <ScanScreen progress={scanProgress} status={scanStatus} elapsed={scanElapsed} total={rawFiles.length} liveGroups={liveGroups} liveBytes={liveBytes} isPaused={isPaused} togglePause={togglePause} cancelScan={cancelScan} />}
        {screen===S.SUMMARY  && <SummaryScreen groups={groups} totalFiles={rawFiles.length} totalWasted={totalWasted} onReview={()=>setScreen(S.REVIEW)} onExport={()=>exportCSV(groups)} />}
        {screen===S.REVIEW   && <ReviewScreen groups={groups} gIdx={gIdx} setGIdx={setGIdx} decisions={decisions} statuses={statuses} reviewedCount={reviewedCount} markedCount={markedCount} markedBytes={markedBytes} toggleDel={toggleDel} autoOlder={autoOlder} confirmGrp={confirmGrp} skipGrp={skipGrp} setZoom={setZoom} onProceed={()=>setScreen(S.CONFIRM)} />}
        {screen===S.CONFIRM  && <ConfirmScreen groups={groups} decisions={decisions} markedCount={markedCount} markedBytes={markedBytes} onConfirm={executeDel} onBack={()=>setScreen(S.REVIEW)} />}
        {screen===S.RESULTS  && <ResultsScreen deleted={deleted} errors={errors} onReset={reset} />}
      </main>
      {zoom && <ZoomOverlay item={zoom} onClose={()=>setZoom(null)} />}
      <style>{STYLES}</style>
    </div>
  );
}

function exportCSV(groups) {
  const rows=["Group,File,Path,Size (bytes),Date Modified"];
  groups.forEach((g,gi)=>g.items.forEach(it=>rows.push(`${gi+1},"${it.name}","${it.path}",${it.size},"${fmtDate(it.modified)}"`)));
  const csv=rows.join("\n");
  if (IS_ELECTRON) { window.electronAPI.writeCsv(csv,"dupeclear_scan_report.csv"); return; }
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download="dupeclear_scan_report.csv"; a.click();
}
function exportLog(deleted) {
  const rows=["File,Path,Size (bytes),Deleted At"];
  deleted.forEach(it=>rows.push(`"${it.name}","${it.path}",${it.size},"${new Date().toISOString()}"`));
  const csv=rows.join("\n");
  if (IS_ELECTRON) { window.electronAPI.writeCsv(csv,"dupeclear_deletion_log.csv"); return; }
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download="dupeclear_deletion_log.csv"; a.click();
}

/* ─── HEADER ─────────────────────────────────────────────────────────────── */
function AppHeader({ screen, reset }) {
  return (
    <header className="sf-header">
      <div className="sf-header-inner">
        <div className="sf-logo">
          <div className="sf-logo-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 1.5L16.5 14.5H1.5L9 1.5Z" fill="white" fillOpacity="0.9"/>
            </svg>
          </div>
          <span className="sf-logo-name">Dedupix</span>
        </div>
        <div className="sf-header-center">
          {screen !== S.HOME && (
            <div className="sf-breadcrumb">
              {{[S.SCANNING]:"Scanning",  [S.SUMMARY]:"Results",
                [S.REVIEW]:"Review",      [S.CONFIRM]:"Confirm",
                [S.RESULTS]:"Done"}[screen]}
            </div>
          )}
        </div>
        <div className="sf-header-right">
          {screen !== S.HOME && (
            <button className="sf-btn-text" onClick={reset}>Start Over</button>
          )}
        </div>
      </div>
    </header>
  );
}

/* ─── HOME ───────────────────────────────────────────────────────────────── */
const ALL_EXTS=[".jpg",".jpeg",".png",".gif",".bmp",".tiff",".tif",".webp",".heic",".heif",".raw",".cr2",".nef",".arw",".dng"];

function HomeScreen({ rawFiles, folderName, totalSize, recursive, setRecursive, extFilter, setExtFilter, fileRef, onFiles, pickFolder, startScan }) {
  const toggle = ext => setExtFilter(p=>p.includes(ext)?p.filter(e=>e!==ext):[...p,ext]);
  const hasFiles = rawFiles.length > 0;
  return (
    <div className="sf-home">
      {/* Hero */}
      <div className="sf-hero">
        <div className="sf-hero-eyebrow">Photo Library Cleaner</div>
        <h1 className="sf-hero-h1">Your memories,<br/>without the clutter.</h1>
        <p className="sf-hero-sub">Free up space by finding photos you've stored twice — or ten times. Dedupix spots every duplicate so you can keep what matters and let go of the rest.</p>
      </div>

      {/* Main card */}
      <div className="sf-card sf-home-card">
        {/* Folder picker */}
        <div className="sf-row">
          <input ref={fileRef} type="file" webkitdirectory="true" multiple style={{display:"none"}} onChange={onFiles} />
          <div className="sf-folder-zone" onClick={IS_ELECTRON ? pickFolder : ()=>fileRef.current.click()}>
            <div className="sf-folder-icon">
              <svg width="28" height="24" viewBox="0 0 28 24" fill="none">
                <path d="M2 5C2 3.9 2.9 3 4 3H11L13 5H24C25.1 5 26 5.9 26 7V19C26 20.1 25.1 21 24 21H4C2.9 21 2 20.1 2 19V5Z" fill="#0071E3" fillOpacity="0.15" stroke="#0071E3" strokeWidth="1.5"/>
              </svg>
            </div>
            <div className="sf-folder-text">
              {hasFiles ? (
                <>
                  <div className="sf-folder-name">{folderName}</div>
                  <div className="sf-folder-meta">{rawFiles.length.toLocaleString()} photos · {fmtBytes(totalSize)}</div>
                </>
              ) : (
                <>
                  <div className="sf-folder-name sf-folder-placeholder">Choose a Folder</div>
                  <div className="sf-folder-meta">Select the folder you want to clean up</div>
                </>
              )}
            </div>
            <div className="sf-folder-chevron">›</div>
          </div>
        </div>

        <div className="sf-separator" />

        {/* Toggle row */}
        <div className="sf-setting-row">
          <div className="sf-setting-label">
            <div className="sf-setting-title">Include sub-folders</div>
            <div className="sf-setting-desc">Scan photos in all folders inside</div>
          </div>
          <div className={`sf-toggle ${recursive?"sf-toggle-on":""}`} onClick={()=>setRecursive(r=>!r)}>
            <div className="sf-toggle-knob"/>
          </div>
        </div>

        <div className="sf-separator" />

        {/* File types */}
        <div className="sf-setting-section">
          <div className="sf-section-header">
            <span className="sf-section-title">Photo Types</span>
            <span className="sf-section-badge">{extFilter.length} selected</span>
          </div>
          <div className="sf-chips">
            {ALL_EXTS.map(ext=>(
              <button key={ext} className={`sf-chip ${extFilter.includes(ext)?"sf-chip-on":""}`} onClick={()=>toggle(ext)}>{ext.replace(".","")}</button>
            ))}
          </div>
        </div>

        <div className="sf-separator" />

        {/* CTA */}
        <div className="sf-cta-row">
          <button className={`sf-btn-primary ${!hasFiles?"sf-btn-disabled":""}`} onClick={startScan} disabled={!hasFiles}>
            {hasFiles ? `Find Duplicates in ${rawFiles.length.toLocaleString()} Photos` : "Choose a Folder to Begin"}
          </button>
          {hasFiles && <p className="sf-cta-hint">Takes about {Math.max(1,Math.ceil(rawFiles.length/500))} second{rawFiles.length>500?"s":""} · nothing changes until you decide</p>}
        </div>
      </div>

      {/* Feature pills */}
      <div className="sf-features">
        {[
          {icon:"🔒", label:"Stays on your Mac", desc:"Your photos never leave your device"},
          {icon:"♻️", label:"Safe by default",   desc:"Deleted photos go to Trash first"},
          {icon:"✦",  label:"Free, always",      desc:"No subscription. No catch."},
        ].map(f=>(
          <div key={f.label} className="sf-feature-pill">
            <span className="sf-feature-icon">{f.icon}</span>
            <div>
              <div className="sf-feature-label">{f.label}</div>
              <div className="sf-feature-desc">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── SCANNING ───────────────────────────────────────────────────────────── */
function ScanScreen({ progress, status, elapsed, total, liveGroups, liveBytes, isPaused, togglePause, cancelScan }) {
  return (
    <div className="sf-screen-center">
      <div className="sf-card sf-scan-card">
        {/* Animated progress ring */}
        <div className="sf-scan-visual">
          <svg className="sf-ring-svg" viewBox="0 0 120 120" width="120" height="120">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#E5E5EA" strokeWidth="6"/>
            <circle cx="60" cy="60" r="52" fill="none" stroke="#0071E3" strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2*Math.PI*52}`}
              strokeDashoffset={`${2*Math.PI*52*(1-progress/100)}`}
              transform="rotate(-90 60 60)"
              style={{transition:"stroke-dashoffset 0.4s ease"}}
            />
          </svg>
          <div className="sf-ring-center">
            <div className="sf-ring-pct">{progress}%</div>
          </div>
        </div>

        <h2 className="sf-scan-title">{isPaused ? "Paused" : "Looking through your photos…"}</h2>
        <p className="sf-scan-sub">{status || "Getting started…"}</p>

        <div className="sf-scan-stats">
          <div className="sf-stat-pill"><span className="sf-stat-val">{total.toLocaleString()}</span><span className="sf-stat-lbl">photos</span></div>
          <div className="sf-stat-divider"/>
          <div className="sf-stat-pill"><span className="sf-stat-val">{fmtTime(elapsed)}</span><span className="sf-stat-lbl">elapsed</span></div>
          {liveGroups>0 && <>
            <div className="sf-stat-divider"/>
            <div className="sf-stat-pill sf-stat-found"><span className="sf-stat-val">{liveGroups}</span><span className="sf-stat-lbl">found</span></div>
          </>}
        </div>

        {liveGroups>0 && (
          <div className="sf-scan-found">
            <span className="sf-found-dot"/>
            Found {liveGroups} duplicate group{liveGroups!==1?"s":""} · <strong>{fmtBytes(liveBytes)}</strong> you could reclaim
          </div>
        )}

        <div className="sf-scan-actions">
          <button className="sf-btn-secondary" onClick={togglePause}>{isPaused?"Continue":"Pause"}</button>
          <button className="sf-btn-text sf-btn-cancel" onClick={cancelScan}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ─── SUMMARY ────────────────────────────────────────────────────────────── */
function SummaryScreen({ groups, totalFiles, totalWasted, onReview, onExport }) {
  const dupeFiles = groups.reduce((s,g)=>s+g.items.length,0);
  const topFolders = useMemo(()=>{
    const m={};
    groups.forEach(g=>g.items.forEach(it=>{ const parts=it.path.replace(/\\/g,"/").split("/"); const dir=parts.length>1?parts.slice(0,-1).join("/"):"(root)"; m[dir]=(m[dir]||0)+1; }));
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,4);
  },[groups]);

  if (!groups.length) return (
    <div className="sf-screen-center">
      <div className="sf-card sf-summary-card">
        <div className="sf-empty-state">
          <div className="sf-empty-icon">✓</div>
          <h2 className="sf-empty-title">You're all clear</h2>
          <p className="sf-empty-sub">No duplicate photos found in {totalFiles.toLocaleString()} photos scanned. Your library is spotless.</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="sf-screen-center">
      <div className="sf-card sf-summary-card">
        <div className="sf-summary-hero">
          <div className="sf-summary-num">{fmtBytes(totalWasted)}</div>
          <div className="sf-summary-num-label">ready to reclaim</div>
          <p className="sf-summary-desc">We found <strong>{groups.length} sets</strong> of duplicate photos across {totalFiles.toLocaleString()} files scanned. Review them and choose what to keep.</p>
        </div>

        <div className="sf-kpi-strip">
          {[
            {val:totalFiles.toLocaleString(), label:"Photos Scanned"},
            {val:groups.length,               label:"Duplicate Sets"},
            {val:dupeFiles,                   label:"Extra Copies"},
          ].map(k=>(
            <div key={k.label} className="sf-kpi">
              <div className="sf-kpi-val">{k.val}</div>
              <div className="sf-kpi-label">{k.label}</div>
            </div>
          ))}
        </div>

        {topFolders.length>0 && (
          <div className="sf-folder-breakdown">
            <div className="sf-breakdown-title">Where duplicates are hiding</div>
            {topFolders.map(([dir,n])=>(
              <div key={dir} className="sf-breakdown-row">
                <div className="sf-breakdown-bar-wrap">
                  <div className="sf-breakdown-label">{dir.split("/").pop() || dir}</div>
                  <div className="sf-breakdown-bar">
                    <div className="sf-breakdown-fill" style={{width:`${Math.min(100,(n/dupeFiles)*100*3)}%`}}/>
                  </div>
                </div>
                <div className="sf-breakdown-count">{n}</div>
              </div>
            ))}
          </div>
        )}

        <div className="sf-safe-banner">
          <span className="sf-safe-icon">🔒</span>
          Nothing has changed yet — you'll review each photo before anything is removed.
        </div>

        <div className="sf-summary-actions">
          <button className="sf-btn-ghost-sm" onClick={onExport}>Export Report</button>
          <button className="sf-btn-primary sf-btn-full" onClick={onReview}>Review Duplicates →</button>
        </div>
      </div>
    </div>
  );
}

/* ─── REVIEW ─────────────────────────────────────────────────────────────── */
function ReviewScreen({ groups, gIdx, setGIdx, decisions, statuses, reviewedCount, markedCount, markedBytes, toggleDel, autoOlder, confirmGrp, skipGrp, setZoom, onProceed }) {
  const grp=groups[gIdx];
  const marked=decisions[gIdx]||new Set();
  const total=groups.length;
  const pct=total?Math.round((reviewedCount/total)*100):0;
  if (!grp) return null;

  return (
    <div className="sf-review-layout">
      {/* Sidebar */}
      <aside className="sf-sidebar">
        <div className="sf-sidebar-top">
          <div className="sf-sidebar-title">Duplicate Sets</div>
          <div className="sf-sidebar-progress">
            <div className="sf-sidebar-prog-bar"><div className="sf-sidebar-prog-fill" style={{width:`${pct}%`}}/></div>
            <span className="sf-sidebar-prog-label">{reviewedCount}/{total}</span>
          </div>
        </div>
        <div className="sf-group-list">
          {groups.map((g,i)=>{
            const st=statuses[i], active=i===gIdx;
            return (
              <div key={i} className={`sf-group-row ${active?"sfgr-active":""} ${st==="reviewed"?"sfgr-done":""} ${st==="skipped"?"sfgr-skipped":""}`} onClick={()=>setGIdx(i)}>
                <div className="sfgr-thumb">{g.items[0].url&&<img src={g.items[0].url} alt=""/>}</div>
                <div className="sfgr-info">
                  <div className="sfgr-name">{g.items[0].name.length>20?g.items[0].name.slice(0,18)+"…":g.items[0].name}</div>
                  <div className="sfgr-meta">{g.items.length} copies · {fmtBytes(g.items.reduce((s,it)=>s+it.size,0))}</div>
                </div>
                <div className="sfgr-badge">
                  {st==="reviewed"&&<span className="sfgr-ok">✓</span>}
                  {st==="skipped" &&<span className="sfgr-skip">–</span>}
                  {!st&&active    &&<div className="sfgr-dot"/>}
                </div>
              </div>
            );
          })}
        </div>
        {markedCount>0&&(
          <div className="sf-sidebar-footer">
            <div className="sf-sidebar-footer-stat">{markedCount} photo{markedCount!==1?"s":""} · {fmtBytes(markedBytes)}</div>
            <button className="sf-btn-destructive sf-btn-full" onClick={onProceed}>Move to Trash →</button>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="sf-review-main">
        {/* Top nav */}
        <div className="sf-review-nav">
          <button className="sf-nav-btn" onClick={()=>setGIdx(i=>Math.max(i-1,0))} disabled={gIdx===0}>
            <svg width="8" height="14" viewBox="0 0 8 14"><path d="M7 1L1 7L7 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <div className="sf-nav-info">
            <span className="sf-nav-pos">Set {gIdx+1}</span>
            <span className="sf-nav-of">of {total}</span>
          </div>
          <button className="sf-nav-btn" onClick={()=>setGIdx(i=>Math.min(i+1,total-1))} disabled={gIdx===total-1}>
            <svg width="8" height="14" viewBox="0 0 8 14"><path d="M1 1L7 7L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <div className="sf-nav-progress">
            <div className="sf-nav-prog-track"><div className="sf-nav-prog-fill" style={{width:`${pct}%`}}/></div>
          </div>
          <span className="sf-nav-pct">{pct}% reviewed</span>
        </div>

        {/* Cards */}
        <div className="sf-thumb-area">
          <div className="sf-thumb-grid" style={{gridTemplateColumns:`repeat(${Math.min(grp.items.length,3)},1fr)`}}>
            {grp.items.map((it,fi)=>{
              const isDel=marked.has(fi);
              return (
                <div key={fi} className={`sf-photo-card ${isDel?"sfpc-marked":""}`}>
                  <div className="sfpc-img-wrap" onClick={()=>setZoom(it)}>
                    {it.url?<img src={it.url} alt={it.name} className="sfpc-img"/>:<div className="sfpc-no-img">No preview</div>}
                    {isDel&&(
                      <div className="sfpc-trash-overlay">
                        <div className="sfpc-trash-badge">
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4H14M5 4V2H11V4M6 7V12M10 7V12M3 4L4 14H12L13 4H3Z" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Remove
                        </div>
                      </div>
                    )}
                    <div className="sfpc-zoom-hint">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4" stroke="white" strokeWidth="1.5"/><path d="M9 9L12 12" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    </div>
                  </div>
                  <div className="sfpc-meta">
                    <div className="sfpc-name" title={it.name}>{it.name}</div>
                    <div className="sfpc-path" title={it.path}>{it.path}</div>
                    <div className="sfpc-details">
                      <span>{fmtBytes(it.size)}</span>
                      {it.dim&&<span>{it.dim}</span>}
                      <span>{fmtDate(it.modified)}</span>
                    </div>
                  </div>
                  <div className="sfpc-action">
                    <button className={`sfpc-btn ${isDel?"sfpc-btn-keep":"sfpc-btn-remove"}`} onClick={()=>toggleDel(gIdx,fi)}>
                      {isDel?"Keep This Photo":"Remove This Copy"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="sf-review-bar">
          <button className="sf-btn-ghost-sm" onClick={()=>autoOlder(gIdx)}>Keep Newest</button>
          <button className="sf-btn-ghost-sm" onClick={()=>skipGrp(gIdx)}>Decide Later</button>
          <div style={{flex:1}}/>
          <button className="sf-btn-primary" onClick={()=>confirmGrp(gIdx)}>Done with this set →</button>
        </div>
        <div className="sf-key-hints">← → to navigate &nbsp;·&nbsp; Enter to confirm &nbsp;·&nbsp; Esc to close preview</div>
      </div>
    </div>
  );
}

/* ─── CONFIRM ────────────────────────────────────────────────────────────── */
function ConfirmScreen({ groups, decisions, markedCount, markedBytes, onConfirm, onBack }) {
  const [permDel,setPermDel]=useState(false);
  const toDelete=useMemo(()=>{
    const r=[];
    Object.entries(decisions).forEach(([gi,s])=>s.forEach(fi=>r.push(groups[+gi]?.items[fi])));
    return r.filter(Boolean);
  },[decisions,groups]);

  return (
    <div className="sf-screen-center">
      <div className="sf-card sf-confirm-card">
        <div className="sf-confirm-header">
          <div className="sf-confirm-icon-wrap">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M4 7H24M9 7V5H19V7M10 12V20M14 12V20M18 12V20M5 7L6.5 23H21.5L23 7H5Z" stroke="#FF3B30" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <h2 className="sf-confirm-title">Move to Trash?</h2>
            <p className="sf-confirm-sub">{markedCount} photo{markedCount!==1?"s":""} · {fmtBytes(markedBytes)}</p>
          </div>
        </div>

        <div className="sf-confirm-list">
          {toDelete.map((it,i)=>(
            <div key={i} className="sf-confirm-row">
              {it.url&&<img src={it.url} alt="" className="sfcr-thumb"/>}
              <div className="sfcr-info">
                <div className="sfcr-name">{it.name}</div>
                <div className="sfcr-path">{it.path}</div>
              </div>
              <div className="sfcr-size">{fmtBytes(it.size)}</div>
            </div>
          ))}
        </div>

        <div className="sf-confirm-options">
          <div className="sf-trash-note">
            <span>♻️</span>
            <span>Photos go to <strong>Recycle Bin</strong> — you can restore them any time if you change your mind.</span>
          </div>
          <label className={`sf-perm-row ${permDel?"sf-perm-active":""}`}>
            <input type="checkbox" checked={permDel} onChange={e=>setPermDel(e.target.checked)} className="sf-cb"/>
            <div>
              <div className="sf-perm-title">Delete permanently</div>
              <div className="sf-perm-desc">Skips Recycle Bin — this can't be undone</div>
            </div>
          </label>
        </div>

        <div className="sf-confirm-actions">
          <button className="sf-btn-secondary" onClick={onBack}>Go Back</button>
          <button className={`sf-btn-destructive ${permDel?"sf-btn-perm":""}`} onClick={()=>onConfirm(permDel)}>
            {permDel?"Delete Forever":"Move to Trash"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── RESULTS ────────────────────────────────────────────────────────────── */
function ResultsScreen({ deleted, errors, onReset }) {
  const freed=deleted.reduce((s,it)=>s+it.size,0);
  return (
    <div className="sf-screen-center">
      <div className="sf-card sf-results-card">
        <div className="sf-results-hero">
          <div className="sf-results-checkmark">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="15" fill="#34C759"/>
              <path d="M9 16L14 21L23 11" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h2 className="sf-results-title">All cleaned up.</h2>
          <p className="sf-results-sub">You freed up {fmtBytes(freed)} and removed {deleted.length} duplicate photo{deleted.length!==1?"s":""} from your library.</p>
        </div>

        <div className="sf-results-kpis">
          {[
            {val:deleted.length,    label:"Photos Removed"},
            {val:fmtBytes(freed),   label:"Space Freed",    hi:true},
            {val:errors.length||"✓",label:errors.length?"Errors":"No Errors", ok:!errors.length},
          ].map(k=>(
            <div key={k.label} className={`sf-rkpi ${k.hi?"sf-rkpi-hi":""} ${k.ok?"sf-rkpi-ok":""}`}>
              <div className="sf-rkpi-val">{k.val}</div>
              <div className="sf-rkpi-label">{k.label}</div>
            </div>
          ))}
        </div>

        {errors.length>0&&(
          <div className="sf-errors">
            {errors.map((e,i)=><div key={i} className="sf-error-row">⚠ {e.it?.name}: {e.reason}</div>)}
          </div>
        )}

        <div className="sf-results-note">
          Photos are in your Recycle Bin — open it to restore anything you change your mind about.
        </div>

        <div className="sf-results-actions">
          <button className="sf-btn-ghost-sm" onClick={()=>exportLog(deleted)}>Save Log</button>
          <button className="sf-btn-primary" onClick={onReset}>Clean Another Folder</button>
        </div>
      </div>
    </div>
  );
}

/* ─── ZOOM ───────────────────────────────────────────────────────────────── */
function ZoomOverlay({ item, onClose }) {
  return (
    <div className="sf-zoom-bg" onClick={onClose}>
      <div className="sf-zoom-box" onClick={e=>e.stopPropagation()}>
        <button className="sf-zoom-close" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        </button>
        {item.url?<img src={item.url} alt={item.name} className="sf-zoom-img"/>:<div className="sf-zoom-no-img">No preview</div>}
        <div className="sf-zoom-meta">{item.name}{item.dim?" · "+item.dim:""} · {fmtBytes(item.size)}</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STYLES — Apple HIG Design System
═══════════════════════════════════════════════════════════════════════════ */
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,300;1,9..40,400&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  /* Apple system palette */
  --apple-bg:          #F5F5F7;
  --apple-surface:     #FFFFFF;
  --apple-surface2:    #F5F5F7;
  --apple-surface3:    #EBEBF0;
  --apple-blue:        #0071E3;
  --apple-blue-hover:  #0077ED;
  --apple-blue-light:  #E8F1FB;
  --apple-green:       #34C759;
  --apple-green-light: #EBF8EE;
  --apple-red:         #FF3B30;
  --apple-red-light:   #FFF0EF;
  --apple-orange:      #FF9500;
  --apple-label:       #1D1D1F;
  --apple-label2:      #6E6E73;
  --apple-label3:      #AEAEB2;
  --apple-separator:   rgba(60,60,67,0.12);
  --apple-fill:        rgba(120,120,128,0.12);
  --apple-fill2:       rgba(120,120,128,0.08);
  --r-sm: 10px;
  --r-md: 14px;
  --r-lg: 18px;
  --r-xl: 22px;
  --shadow-sm:   0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md:   0 4px 16px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04);
  --shadow-lg:   0 12px 40px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.06);
}

html, body { height: 100%; background: var(--apple-bg); }
.app { min-height: 100vh; background: var(--apple-bg); color: var(--apple-label); font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif; display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }
.main { flex: 1; display: flex; flex-direction: column; }

/* ── Header ─────────────────────────────────────────────────────────────── */
.sf-header { background: rgba(255,255,255,0.72); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); border-bottom: 1px solid var(--apple-separator); position: sticky; top: 0; z-index: 200; }
.sf-header-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; height: 52px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; }
.sf-logo { display: flex; align-items: center; gap: 10px; }
.sf-logo-icon { width: 28px; height: 28px; background: var(--apple-blue); border-radius: 7px; display: flex; align-items: center; justify-content: center; }
.sf-logo-name { font-size: 17px; font-weight: 600; color: var(--apple-label); letter-spacing: -0.3px; }
.sf-header-center { display: flex; justify-content: center; }
.sf-breadcrumb { font-size: 14px; font-weight: 500; color: var(--apple-label2); }
.sf-header-right { display: flex; justify-content: flex-end; }
.sf-btn-text { background: none; border: none; color: var(--apple-blue); font-size: 15px; font-weight: 500; cursor: pointer; padding: 6px 12px; border-radius: 8px; font-family: inherit; transition: background 0.15s; }
.sf-btn-text:hover { background: var(--apple-blue-light); }
.sf-btn-cancel { color: var(--apple-label2); }
.sf-btn-cancel:hover { background: var(--apple-fill); color: var(--apple-label); }

/* ── Cards ───────────────────────────────────────────────────────────────── */
.sf-card { background: var(--apple-surface); border-radius: var(--r-xl); box-shadow: var(--shadow-md); overflow: hidden; }
.sf-separator { height: 1px; background: var(--apple-separator); margin: 0 20px; }

/* ── Buttons ─────────────────────────────────────────────────────────────── */
.sf-btn-primary { display: inline-flex; align-items: center; justify-content: center; padding: 13px 24px; background: var(--apple-blue); color: #fff; border: none; border-radius: 980px; font-weight: 500; font-size: 15px; cursor: pointer; transition: background 0.15s, transform 0.1s; font-family: inherit; white-space: nowrap; }
.sf-btn-primary:hover:not(:disabled) { background: var(--apple-blue-hover); }
.sf-btn-primary:active { transform: scale(0.98); }
.sf-btn-disabled { opacity: 0.4; cursor: not-allowed !important; }
.sf-btn-full { width: 100%; }
.sf-btn-secondary { display: inline-flex; align-items: center; justify-content: center; padding: 11px 22px; background: var(--apple-fill); color: var(--apple-label); border: none; border-radius: 980px; font-weight: 500; font-size: 15px; cursor: pointer; transition: background 0.15s; font-family: inherit; }
.sf-btn-secondary:hover { background: var(--apple-fill2); filter: brightness(0.95); }
.sf-btn-ghost-sm { display: inline-flex; align-items: center; justify-content: center; padding: 8px 16px; background: transparent; color: var(--apple-blue); border: none; border-radius: 980px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background 0.15s; font-family: inherit; }
.sf-btn-ghost-sm:hover { background: var(--apple-blue-light); }
.sf-btn-destructive { display: inline-flex; align-items: center; justify-content: center; padding: 11px 22px; background: var(--apple-red); color: #fff; border: none; border-radius: 980px; font-weight: 500; font-size: 15px; cursor: pointer; transition: background 0.15s, opacity 0.15s; font-family: inherit; }
.sf-btn-destructive:hover { opacity: 0.88; }
.sf-btn-perm { background: #C00; }

/* ── Screen wrappers ─────────────────────────────────────────────────────── */
.sf-screen-center { flex: 1; display: flex; align-items: flex-start; justify-content: center; padding: 40px 20px 60px; }

/* ── HOME ────────────────────────────────────────────────────────────────── */
.sf-home { max-width: 600px; margin: 0 auto; padding: 52px 20px 60px; width: 100%; }

.sf-hero { text-align: center; margin-bottom: 36px; }
.sf-hero-eyebrow { font-size: 12px; font-weight: 500; color: var(--apple-blue); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 14px; }
.sf-hero-h1 { font-size: 48px; font-weight: 700; line-height: 1.08; letter-spacing: -1.5px; color: var(--apple-label); margin-bottom: 18px; }
.sf-hero-sub { font-size: 17px; font-weight: 400; color: var(--apple-label2); line-height: 1.6; max-width: 480px; margin: 0 auto; }

.sf-home-card { border-radius: var(--r-xl); }

.sf-row { padding: 6px 0; }

.sf-folder-zone { display: flex; align-items: center; gap: 16px; padding: 18px 20px; cursor: pointer; transition: background 0.12s; border-radius: var(--r-md); margin: 6px; }
.sf-folder-zone:hover { background: var(--apple-fill2); }
.sf-folder-icon { flex-shrink: 0; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; }
.sf-folder-text { flex: 1; min-width: 0; }
.sf-folder-name { font-size: 16px; font-weight: 500; color: var(--apple-label); }
.sf-folder-placeholder { color: var(--apple-label2); }
.sf-folder-meta { font-size: 13px; color: var(--apple-label3); margin-top: 2px; }
.sf-folder-chevron { font-size: 20px; color: var(--apple-label3); flex-shrink: 0; line-height: 1; }

.sf-setting-row { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; }
.sf-setting-label { flex: 1; }
.sf-setting-title { font-size: 15px; font-weight: 500; color: var(--apple-label); }
.sf-setting-desc { font-size: 12px; color: var(--apple-label3); margin-top: 2px; }

/* Toggle switch */
.sf-toggle { width: 51px; height: 31px; background: var(--apple-label3); border-radius: 99px; cursor: pointer; transition: background 0.25s; position: relative; flex-shrink: 0; }
.sf-toggle-on { background: var(--apple-green); }
.sf-toggle-knob { position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; background: #fff; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1); }
.sf-toggle-on .sf-toggle-knob { transform: translateX(20px); }

.sf-setting-section { padding: 16px 20px; }
.sf-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sf-section-title { font-size: 13px; font-weight: 500; color: var(--apple-label2); text-transform: uppercase; letter-spacing: 0.5px; }
.sf-section-badge { font-size: 12px; color: var(--apple-blue); font-weight: 500; background: var(--apple-blue-light); padding: 2px 8px; border-radius: 20px; }
.sf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sf-chip { font-size: 12px; font-weight: 500; padding: 5px 12px; border-radius: 20px; border: 1px solid var(--apple-separator); background: transparent; color: var(--apple-label2); cursor: pointer; transition: all 0.15s; font-family: inherit; }
.sf-chip:hover { background: var(--apple-fill); }
.sf-chip-on { background: var(--apple-blue-light) !important; color: var(--apple-blue) !important; border-color: transparent !important; }

.sf-cta-row { padding: 20px; }
.sf-cta-hint { font-size: 12px; color: var(--apple-label3); text-align: center; margin-top: 10px; }

.sf-features { display: flex; gap: 10px; margin-top: 20px; }
.sf-feature-pill { flex: 1; background: var(--apple-surface); border-radius: var(--r-md); padding: 14px 16px; display: flex; align-items: flex-start; gap: 10px; box-shadow: var(--shadow-sm); }
.sf-feature-icon { font-size: 18px; flex-shrink: 0; line-height: 1.2; }
.sf-feature-label { font-size: 13px; font-weight: 600; color: var(--apple-label); margin-bottom: 2px; }
.sf-feature-desc { font-size: 11px; color: var(--apple-label3); line-height: 1.4; }

/* ── SCAN ────────────────────────────────────────────────────────────────── */
.sf-scan-card { width: 100%; max-width: 480px; padding: 52px 40px; text-align: center; }
.sf-scan-visual { position: relative; width: 120px; height: 120px; margin: 0 auto 28px; }
.sf-ring-svg { display: block; }
.sf-ring-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.sf-ring-pct { font-size: 28px; font-weight: 700; letter-spacing: -1px; color: var(--apple-label); }
.sf-scan-title { font-size: 22px; font-weight: 600; letter-spacing: -0.4px; margin-bottom: 8px; }
.sf-scan-sub { font-size: 14px; color: var(--apple-label2); margin-bottom: 28px; min-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; margin-left: auto; margin-right: auto; }
.sf-scan-stats { display: flex; align-items: center; justify-content: center; gap: 0; background: var(--apple-fill2); border-radius: var(--r-sm); padding: 12px 20px; margin-bottom: 20px; }
.sf-stat-pill { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 0 16px; }
.sf-stat-val { font-size: 17px; font-weight: 600; color: var(--apple-label); letter-spacing: -0.3px; }
.sf-stat-lbl { font-size: 11px; color: var(--apple-label3); }
.sf-stat-found .sf-stat-val { color: var(--apple-green); }
.sf-stat-divider { width: 1px; height: 30px; background: var(--apple-separator); }
.sf-scan-found { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--apple-label2); background: var(--apple-green-light); border-radius: var(--r-sm); padding: 10px 16px; margin-bottom: 28px; }
.sf-found-dot { width: 7px; height: 7px; background: var(--apple-green); border-radius: 50%; flex-shrink: 0; animation: pulse 1.4s ease infinite; }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
.sf-scan-actions { display: flex; flex-direction: column; align-items: center; gap: 8px; }

/* ── SUMMARY ─────────────────────────────────────────────────────────────── */
.sf-summary-card { width: 100%; max-width: 560px; }
.sf-summary-hero { padding: 40px 36px 32px; text-align: center; border-bottom: 1px solid var(--apple-separator); }
.sf-summary-num { font-size: 56px; font-weight: 700; letter-spacing: -2px; color: var(--apple-blue); line-height: 1; margin-bottom: 6px; }
.sf-summary-num-label { font-size: 15px; font-weight: 500; color: var(--apple-label2); margin-bottom: 16px; }
.sf-summary-desc { font-size: 15px; color: var(--apple-label2); line-height: 1.55; }
.sf-summary-desc strong { color: var(--apple-label); }

.sf-kpi-strip { display: flex; border-bottom: 1px solid var(--apple-separator); }
.sf-kpi { flex: 1; padding: 20px 12px; text-align: center; border-right: 1px solid var(--apple-separator); }
.sf-kpi:last-child { border-right: none; }
.sf-kpi-val { font-size: 26px; font-weight: 700; letter-spacing: -0.8px; color: var(--apple-label); }
.sf-kpi-label { font-size: 11px; color: var(--apple-label3); margin-top: 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.3px; }

.sf-folder-breakdown { padding: 20px 24px; border-bottom: 1px solid var(--apple-separator); }
.sf-breakdown-title { font-size: 12px; font-weight: 600; color: var(--apple-label3); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }
.sf-breakdown-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.sf-breakdown-bar-wrap { flex: 1; min-width: 0; }
.sf-breakdown-label { font-size: 13px; color: var(--apple-label2); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf-breakdown-bar { height: 4px; background: var(--apple-fill); border-radius: 99px; overflow: hidden; }
.sf-breakdown-fill { height: 100%; background: var(--apple-blue); border-radius: 99px; transition: width 0.6s ease; }
.sf-breakdown-count { font-size: 13px; font-weight: 600; color: var(--apple-label2); min-width: 24px; text-align: right; }

.sf-safe-banner { display: flex; align-items: center; gap: 10px; margin: 16px 24px; padding: 12px 16px; background: var(--apple-fill2); border-radius: var(--r-sm); font-size: 13px; color: var(--apple-label2); line-height: 1.4; }
.sf-safe-icon { font-size: 16px; flex-shrink: 0; }

.sf-summary-actions { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; gap: 12px; }
.sf-summary-actions .sf-btn-primary { flex: 1; }

.sf-empty-state { padding: 60px 40px; text-align: center; }
.sf-empty-icon { font-size: 48px; color: var(--apple-green); margin-bottom: 16px; }
.sf-empty-title { font-size: 22px; font-weight: 600; letter-spacing: -0.4px; margin-bottom: 10px; }
.sf-empty-sub { font-size: 15px; color: var(--apple-label2); line-height: 1.55; }

/* ── REVIEW ──────────────────────────────────────────────────────────────── */
.sf-review-layout { display: flex; flex: 1; height: calc(100vh - 52px); overflow: hidden; }

.sf-sidebar { width: 220px; background: rgba(255,255,255,0.85); backdrop-filter: blur(10px); border-right: 1px solid var(--apple-separator); display: flex; flex-direction: column; flex-shrink: 0; }
.sf-sidebar-top { padding: 16px 14px 12px; border-bottom: 1px solid var(--apple-separator); }
.sf-sidebar-title { font-size: 12px; font-weight: 600; color: var(--apple-label3); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
.sf-sidebar-progress { display: flex; align-items: center; gap: 8px; }
.sf-sidebar-prog-bar { flex: 1; height: 3px; background: var(--apple-fill); border-radius: 99px; overflow: hidden; }
.sf-sidebar-prog-fill { height: 100%; background: var(--apple-blue); border-radius: 99px; transition: width 0.4s; }
.sf-sidebar-prog-label { font-size: 11px; color: var(--apple-label3); white-space: nowrap; font-weight: 500; }

.sf-group-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.sf-group-list::-webkit-scrollbar { width: 3px; }
.sf-group-list::-webkit-scrollbar-thumb { background: var(--apple-label3); border-radius: 99px; }

.sf-group-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: var(--r-sm); margin: 0 6px; transition: background 0.1s; }
.sf-group-row:hover { background: var(--apple-fill2); }
.sfgr-active { background: var(--apple-blue-light) !important; }
.sfgr-done { opacity: 0.5; }
.sfgr-skipped { opacity: 0.35; }
.sfgr-thumb { width: 36px; height: 36px; border-radius: 7px; overflow: hidden; flex-shrink: 0; background: var(--apple-fill); }
.sfgr-thumb img { width: 100%; height: 100%; object-fit: cover; }
.sfgr-info { flex: 1; min-width: 0; }
.sfgr-name { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--apple-label); }
.sfgr-meta { font-size: 11px; color: var(--apple-label3); margin-top: 1px; }
.sfgr-badge { width: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.sfgr-ok   { font-size: 12px; font-weight: 700; color: var(--apple-green); }
.sfgr-skip { font-size: 14px; color: var(--apple-label3); }
.sfgr-dot  { width: 7px; height: 7px; background: var(--apple-blue); border-radius: 50%; }

.sf-sidebar-footer { padding: 14px; border-top: 1px solid var(--apple-separator); background: var(--apple-surface2); }
.sf-sidebar-footer-stat { font-size: 12px; color: var(--apple-label2); text-align: center; margin-bottom: 10px; }
.sf-btn-destructive.sf-btn-full { width: 100%; font-size: 14px; padding: 10px 16px; border-radius: var(--r-sm); }

.sf-review-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--apple-bg); }

.sf-review-nav { display: flex; align-items: center; gap: 14px; padding: 12px 20px; background: rgba(255,255,255,0.8); backdrop-filter: blur(10px); border-bottom: 1px solid var(--apple-separator); }
.sf-nav-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; background: var(--apple-surface); border: 1px solid var(--apple-separator); border-radius: 50%; cursor: pointer; color: var(--apple-label); transition: background 0.1s; }
.sf-nav-btn:hover:not(:disabled) { background: var(--apple-fill); }
.sf-nav-btn:disabled { opacity: 0.3; cursor: default; }
.sf-nav-info { display: flex; align-items: baseline; gap: 4px; min-width: 80px; }
.sf-nav-pos { font-size: 15px; font-weight: 600; color: var(--apple-label); }
.sf-nav-of  { font-size: 13px; color: var(--apple-label3); }
.sf-nav-progress { flex: 1; height: 3px; background: var(--apple-fill); border-radius: 99px; overflow: hidden; }
.sf-nav-prog-track { height: 100%; background: var(--apple-fill); }
.sf-nav-prog-fill { height: 100%; background: var(--apple-blue); border-radius: 99px; transition: width 0.4s ease; }
.sf-nav-pct { font-size: 12px; color: var(--apple-label3); white-space: nowrap; font-weight: 500; }

.sf-thumb-area { flex: 1; overflow-y: auto; padding: 20px; }
.sf-thumb-grid { display: grid; gap: 14px; height: 100%; }
.sf-photo-card { background: var(--apple-surface); border-radius: var(--r-lg); overflow: hidden; box-shadow: var(--shadow-sm); border: 2px solid transparent; transition: border-color 0.2s, box-shadow 0.2s; display: flex; flex-direction: column; }
.sfpc-marked { border-color: var(--apple-red) !important; box-shadow: 0 0 0 3px rgba(255,59,48,0.12) !important; }

.sfpc-img-wrap { position: relative; aspect-ratio: 4/3; overflow: hidden; cursor: zoom-in; background: #000; }
.sfpc-img { width: 100%; height: 100%; object-fit: contain; }
.sfpc-no-img { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 13px; color: #666; background: #1a1a1a; }
.sfpc-trash-overlay { position: absolute; inset: 0; background: rgba(255,59,48,0.45); display: flex; align-items: center; justify-content: center; }
.sfpc-trash-badge { display: flex; align-items: center; gap: 6px; background: var(--apple-red); color: #fff; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 20px; }
.sfpc-zoom-hint { position: absolute; bottom: 10px; right: 10px; width: 28px; height: 28px; background: rgba(0,0,0,0.5); border-radius: 50%; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s; pointer-events: none; }
.sfpc-img-wrap:hover .sfpc-zoom-hint { opacity: 1; }

.sfpc-meta { padding: 12px 14px 8px; flex: 1; }
.sfpc-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--apple-label); }
.sfpc-path { font-size: 11px; color: var(--apple-label3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.sfpc-details { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.sfpc-details span { font-size: 11px; color: var(--apple-label3); background: var(--apple-fill2); padding: 2px 7px; border-radius: 4px; }
.sfpc-action { padding: 0 12px 12px; }
.sfpc-btn { width: 100%; padding: 9px; border-radius: var(--r-sm); font-size: 13px; font-weight: 500; cursor: pointer; border: none; transition: all 0.15s; font-family: inherit; }
.sfpc-btn-remove { background: var(--apple-red-light); color: var(--apple-red); }
.sfpc-btn-remove:hover { background: var(--apple-red); color: #fff; }
.sfpc-btn-keep { background: var(--apple-green-light); color: var(--apple-green); }
.sfpc-btn-keep:hover { background: var(--apple-green); color: #fff; }

.sf-review-bar { padding: 12px 20px; border-top: 1px solid var(--apple-separator); background: rgba(255,255,255,0.8); backdrop-filter: blur(10px); display: flex; align-items: center; gap: 8px; }
.sf-key-hints { padding: 5px 20px; font-size: 11px; color: var(--apple-label3); background: var(--apple-bg); text-align: center; }

/* ── CONFIRM ─────────────────────────────────────────────────────────────── */
.sf-confirm-card { width: 100%; max-width: 540px; }
.sf-confirm-header { display: flex; align-items: center; gap: 16px; padding: 28px 28px 20px; }
.sf-confirm-icon-wrap { width: 52px; height: 52px; background: var(--apple-red-light); border-radius: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.sf-confirm-title { font-size: 20px; font-weight: 600; letter-spacing: -0.3px; margin-bottom: 4px; }
.sf-confirm-sub { font-size: 14px; color: var(--apple-label2); }

.sf-confirm-list { max-height: 280px; overflow-y: auto; border-top: 1px solid var(--apple-separator); border-bottom: 1px solid var(--apple-separator); }
.sf-confirm-list::-webkit-scrollbar { width: 3px; }
.sf-confirm-list::-webkit-scrollbar-thumb { background: var(--apple-label3); border-radius: 99px; }
.sf-confirm-row { display: flex; align-items: center; gap: 12px; padding: 10px 28px; border-bottom: 1px solid var(--apple-separator); }
.sf-confirm-row:last-child { border-bottom: none; }
.sfcr-thumb { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: var(--apple-fill); }
.sfcr-info { flex: 1; min-width: 0; }
.sfcr-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfcr-path { font-size: 11px; color: var(--apple-label3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.sfcr-size { font-size: 12px; color: var(--apple-label3); flex-shrink: 0; }

.sf-confirm-options { padding: 16px 28px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--apple-separator); }
.sf-trash-note { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--apple-label2); background: var(--apple-fill2); padding: 12px 14px; border-radius: var(--r-sm); line-height: 1.4; }
.sf-perm-row { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; padding: 12px 14px; border-radius: var(--r-sm); border: 1.5px solid var(--apple-separator); transition: border-color 0.15s; }
.sf-perm-active { border-color: var(--apple-red) !important; background: var(--apple-red-light); }
.sf-cb { width: 16px; height: 16px; accent-color: var(--apple-red); flex-shrink: 0; margin-top: 2px; }
.sf-perm-title { font-size: 14px; font-weight: 500; color: var(--apple-label); }
.sf-perm-desc { font-size: 12px; color: var(--apple-label3); margin-top: 2px; }
.sf-confirm-actions { display: flex; gap: 10px; padding: 18px 28px; justify-content: flex-end; }

/* ── RESULTS ─────────────────────────────────────────────────────────────── */
.sf-results-card { width: 100%; max-width: 480px; }
.sf-results-hero { padding: 44px 36px 32px; text-align: center; border-bottom: 1px solid var(--apple-separator); }
.sf-results-checkmark { margin-bottom: 20px; display: flex; justify-content: center; }
.sf-results-title { font-size: 28px; font-weight: 700; letter-spacing: -0.8px; margin-bottom: 10px; }
.sf-results-sub { font-size: 16px; color: var(--apple-label2); line-height: 1.55; }

.sf-results-kpis { display: flex; border-bottom: 1px solid var(--apple-separator); }
.sf-rkpi { flex: 1; padding: 20px 12px; text-align: center; border-right: 1px solid var(--apple-separator); }
.sf-rkpi:last-child { border-right: none; }
.sf-rkpi-val { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; color: var(--apple-label); }
.sf-rkpi-label { font-size: 11px; color: var(--apple-label3); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.3px; font-weight: 500; }
.sf-rkpi-hi .sf-rkpi-val { color: var(--apple-blue); }
.sf-rkpi-ok .sf-rkpi-val { color: var(--apple-green); }

.sf-errors { padding: 12px 24px; background: var(--apple-red-light); border-bottom: 1px solid var(--apple-separator); }
.sf-error-row { font-size: 12px; color: var(--apple-red); margin-bottom: 3px; }
.sf-results-note { margin: 16px 24px; padding: 12px 16px; background: var(--apple-fill2); border-radius: var(--r-sm); font-size: 13px; color: var(--apple-label2); line-height: 1.45; }
.sf-results-actions { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; gap: 10px; }
.sf-results-actions .sf-btn-primary { flex: 1; }

/* ── ZOOM ────────────────────────────────────────────────────────────────── */
.sf-zoom-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.75); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 40px; }
.sf-zoom-box { position: relative; max-width: min(88vw,1200px); max-height: 88vh; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.sf-zoom-close { position: absolute; top: -14px; right: -14px; width: 28px; height: 28px; background: rgba(255,255,255,0.15); border: none; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #fff; transition: background 0.15s; z-index: 1; }
.sf-zoom-close:hover { background: rgba(255,255,255,0.25); }
.sf-zoom-img { max-width: 100%; max-height: calc(88vh - 60px); border-radius: var(--r-lg); box-shadow: 0 32px 80px rgba(0,0,0,0.6); object-fit: contain; }
.sf-zoom-no-img { color: #aaa; padding: 60px; font-size: 14px; }
.sf-zoom-meta { font-size: 12px; color: rgba(255,255,255,0.6); }

/* ── Scrollbars ──────────────────────────────────────────────────────────── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--apple-label3); border-radius: 99px; opacity: 0.5; }
`;
