/* Verkeersdashboard Van Brienenoordbrug — leest de statische data die fetch.py publiceert. */
"use strict";

// ================================================================ constanten
// Categorische volgorde, gevalideerd op kleurenblindheid (dataviz-palet).
const PALETTE = ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#4a3aa7","#e34948"];
const GROUPS = [
  {key:"rws500", label:"RWS 500 m-vakken",        test:id=>id.startsWith("RWS08_"),        on:true},
  {key:"rwsroute",label:"RWS-routes",              test:id=>/^RWS(04|09|10)_/.test(id),     on:false},
  {key:"grt",    label:"Gemeente Rotterdam",       test:id=>id.startsWith("GRT04_"),        on:false},
  {key:"pzh",    label:"Provincie Zuid-Holland",   test:id=>/^PZH0/.test(id),               on:false},
  {key:"other",  label:"Overig (regio, haven, …)", test:()=>true,                            on:false},
];
const PREFIX_LABELS = {RWS08:"RWS · 500 m-vak",RWS09:"RWS · route",RWS04:"RWS · DRIP-route",RWS10:"RWS · traject",GRT04:"Gemeente Rotterdam",PZH03:"Provincie Zuid-Holland",PZH04:"Provincie Zuid-Holland",RDH05:"Regio Rotterdam-Den Haag",RDH06:"Regio Rotterdam-Den Haag",HBR04:"Havenbedrijf",HBR05:"Havenbedrijf",SRR02:"Stadsregio",ABM01:"ABM"};
const SIGN_CATS = {A:"Snelheid",B:"Voorrang",C:"Gesloten",D:"Rijrichting",E:"Parkeren",F:"Geboden",G:"Verkeersregels",H:"Bebouwde kom",J:"Waarschuwing",K:"Bewegwijzering",L:"Informatie"};
const SIGN_ZOOM = 16, MSI_DETAIL_ZOOM = 14, DRIP_THUMB_ZOOM = 14, STEP = 300;
const LS_UI = "brienenoord-ui-v3", LS_PROJ = "brienenoord-projecten";
const METRICS = {
  reistijd:  {label:"Reistijd", unit:"min",   fmt:v=>mmss(v*60)},
  vertraging:{label:"Vertraging", unit:"min", fmt:v=>(v<0?"−":"+")+mmss(Math.abs(v)*60)},
  snelheid:  {label:"Gem. snelheid", unit:"km/u", fmt:v=>Math.round(v)+" km/u"},
  index:     {label:"Reistijdindex", unit:"×", fmt:v=>v.toFixed(2).replace(".",",")},
  intensiteit:{label:"Intensiteit", unit:"vtg/u", fmt:v=>Math.round(v)+" vtg/u"},
};

// ================================================================ toestand
let SITES = {}, DATA = {}, STATE = null, IDX = {days:[], buckets:32};
let PROJ = null, editing = null;
let TIME = null;                 // null = live, anders epoch (s)
let CLS = {};                    // id -> "0|1|2|.|-" op het getoonde moment
let ui = loadUI();

// ================================================================ helpers
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const mmss = s => { if (s==null || !isFinite(s)) return "–"; const t = Math.round(s); return `${Math.floor(t/60)}:${String(t%60).padStart(2,"0")}`; };
const hhmm = d => d.toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"});
const dmy = d => d.toLocaleDateString("nl-NL",{weekday:"short",day:"numeric",month:"short"});
const km = m => m==null ? "–" : (m/1000).toLocaleString("nl-NL",{maximumFractionDigits:1,minimumFractionDigits:1});
const uid = () => Math.random().toString(36).slice(2,10);
const prefix = id => id.split("_")[0];
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dayUTC = t => new Date(t*1000).toISOString().slice(0,10);
const nowS = () => Date.now()/1000;
function loadUI(){
  const def = {groups:Object.fromEntries(GROUPS.map(g=>[g.key,g.on])), signCats:["A","B","C","D","F","J"], layers:{mine:true,msi:false,drip:false,signs:false,loops:false,sit:false,plan:false,ovnet:false,ovveh:false}, dripActive:false, msiActive:true, base:"grijs", layersOpen:true,
    sitCats:["file","dicht","strook","snelheid","incident","brug"], planWhen:"at", ovKinds:["metro","tram","bus","trein","veer"]};
  try{ const u = JSON.parse(localStorage.getItem(LS_UI)); return u ? {...def, ...u, groups:{...def.groups, ...(u.groups||{})}, layers:{...def.layers, ...(u.layers||{})}} : def; }catch(e){ return def; }
}
function saveUI(){ try{ localStorage.setItem(LS_UI, JSON.stringify(ui)); }catch(e){} }
function toast(msg, err){ const t=$("#toast"); t.textContent=msg; t.className=err?"err":""; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true, err?9000:4500); }
function groupOf(id){ return GROUPS.find(g=>g.test(id)).key; }
function siteVisible(id){ return !!ui.groups[groupOf(id)]; }

function prettyName(id){
  const n = SITES[id]?.name || id;
  const m = n.match(/^([A-Z]?\d+)\s+(\w+?)_van_(\d+)_tot_(\d+)$/);
  if (m){
    const road = /^\d/.test(m[1]) ? "A"+m[1] : m[1];
    const side = {HRR:"Re",HRL:"Li"}[m[2]] || m[2];
    const f = v => (v/1000).toLocaleString("nl-NL",{minimumFractionDigits:1,maximumFractionDigits:1});
    return `${road} ${side} · km ${f(+m[3])}–${f(+m[4])}`;
  }
  return n.replace(/_/g," ");
}

// ================================================================ data
const bust = () => Math.floor(Date.now()/60000);
async function getJSON(u, v){ const r = await fetch(`${u}?v=${v ?? bust()}`,{cache:"no-store"}); if(!r.ok) throw new Error(r.status+" "+u); return r.json(); }
// archief van afgeronde dagen (branch 'data', via raw.githubusercontent.com)
let ARCH = null, ARCH_AT = 0;
function withArch(idx, kind){
  const pages = idx.pagesDays || idx.days || [], a = ARCH?.[kind] || [];
  return {...idx, pagesDays: pages, days: [...new Set([...a, ...pages])].sort()};
}
/** Dagbestand ophalen: van deze site, of uit het archief als de dag daar niet (meer) staat. */
function getDayJSON(path, day, kind, v, pagesDays){
  const inArch = !!ARCH && (ARCH[kind]||[]).includes(day);
  const fromArch = () => getJSON(ARCH.base + path, "final");
  if (inArch && pagesDays && !pagesDays.includes(day)) return fromArch();
  return getJSON(`data/${path}`, v).catch(e => { if (inArch) return fromArch(); throw e; });
}
window.archImg = (el, h) => { el.onerror = null; if (ARCH) el.src = `${ARCH.base}drip/img/${h}.png`; };
async function loadArchive(){
  if (ARCH && nowS() - ARCH_AT < 3600) return;
  try{ ARCH = await getJSON("data/archive.json"); ARCH_AT = nowS(); }catch(e){ ARCH_AT = nowS() - 3000; }
}
function bucketOf(id){ let h=0; for (const ch of id) h = (Math.imul(h,31) + ch.charCodeAt(0)) >>> 0; return h % (IDX.buckets||32); }
const isToday = day => day === IDX.days[IDX.days.length-1];
const verFor = day => isToday(day) ? STATE?.lastFetch : "final";

const histCache = new Map();     // "dag/bb" -> Promise<{times, sites}>
function loadBucket(day, b){
  const key = `${day}/${b}@${verFor(day)}`;
  if (!histCache.has(key)) histCache.set(key, getDayJSON(`hist/${day}/${String(b).padStart(2,"0")}.json`, day, "hist", verFor(day), IDX.pagesDays).catch(()=>({times:[],sites:{}})));
  return histCache.get(key);
}
/** Reistijden (s) per segment tussen from en to: {id: [[t, s], ...]} */
async function series(ids, from, to){
  const days = IDX.days.filter(d => { const a = Date.parse(d+"T00:00:00Z")/1000; return a+86400 > from && a <= to; });
  const out = Object.fromEntries(ids.map(id=>[id,[]]));
  const bs = [...new Set(ids.map(bucketOf))];
  const files = await Promise.all(days.flatMap(d => bs.map(b => loadBucket(d,b))));
  for (const f of files){
    for (const id of ids){
      const arr = f.sites[id]; if (!arr) continue;
      for (let i=0;i<arr.length;i++){ const t=f.times[i]; if (arr[i]!=null && t>=from && t<=to) out[id].push([t, arr[i]/10]); }
    }
  }
  for (const id of ids) out[id].sort((a,b)=>a[0]-b[0]);
  return out;
}
const tlCache = new Map();
function loadTL(day){
  const key = `${day}@${verFor(day)}`;
  if (!tlCache.has(key)) tlCache.set(key, getDayJSON(`tl/${day}.json`, day, "hist", verFor(day), IDX.pagesDays).catch(()=>null));
  return tlCache.get(key);
}

// ================================================================ metingen
function refOf(id){ const d = DATA[id]||{}; return d.ref ?? d.best ?? null; }
function classify(dur, ref){ if (dur==null) return "."; if (!ref) return "-"; const r = dur/ref; return r<1.25?"0":r<1.75?"1":"2"; }
const CLS_NAME = {"0":"ok","1":"warn","2":"bad",".":"na","-":"na"};
function flowColor(c){ return {ok:cssVar("--ok"),warn:cssVar("--warn"),bad:cssVar("--bad"),na:cssVar("--na")}[CLS_NAME[c]||"na"]; }

let AT = {};   // id -> reistijd (s) op het getoonde moment (alleen voor projectsegmenten bij historie)
function durOf(id){ return TIME==null ? (DATA[id]?.d ?? null) : (AT[id] ?? null); }

const isLus = it => it.kind==="lus";
let AT_L = {};   // lus-id -> [snelheid, intensiteit] op getoond moment
function loopVal(id){ if (TIME==null){ const v = LOOP_NOW[id]; return v ? [v.s, v.f] : null; } return AT_L[id] || null; }
function lusM(it){
  let f=0, sw=0, w=0, have=0;
  for (const id of it.ids){ const v = loopVal(id); if (!v) continue; have++; if (v[1]!=null){ f+=v[1]; if (v[0]!=null){ sw+=v[0]*v[1]; w+=v[1]; } } }
  const sp = w>0 ? sw/w : (it.ids.map(loopVal).find(v=>v&&v[0]!=null)||[null])[0];
  const ref = it.ids.map(id=>LOOP_REF[id]).filter(Boolean); const R = ref.length ? Math.max(...ref) : null;
  const c = loopClass(sp, R), cls = CLS_NAME[c];
  const txt = !have ? "geen data" : c==="0" ? "vlot" : c==="1" ? "druk" : c==="2" ? "stagnatie" : "geen referentie";
  return {f: have ? f : null, speed: sp, cls, txt, n: it.ids.length};
}
function groupM(item){
  let dur=0, ref=0, len=0, have=0, refOk=true, n=0;
  for (const id of item.ids){
    if (!SITES[id]) continue;
    n++; len += SITES[id].length||0;
    const d = durOf(id), r = refOf(id);
    if (d!=null){ dur += d; have++; }
    if (r!=null) ref += r; else refOk = false;
  }
  const complete = n>0 && have===n;
  const D = complete ? dur : null, R = refOk && n ? ref : null;
  const speed = (D && len) ? len/D*3.6 : null;
  const c = classify(D, R), cls = CLS_NAME[c];
  let txt = "geen data";
  if (!n) txt = "geen segmenten";
  else if (!complete) txt = `onvolledig (${have}/${n})`;
  else if (c==="0") txt = "vlot";
  else if (c==="-") txt = "geen referentie";
  else txt = `+${mmss(D-R)} vertraging`;
  return {dur:D, ref:R, len, speed, cls, txt, n};
}

// ================================================================ projecten
const project = () => PROJ.projects.find(p=>p.id===PROJ.active) || PROJ.projects[0];
const items = () => project().items;
const charts = () => (project().charts ||= []);
const pins = () => (project().pins ||= []);
const findItem = key => items().find(i=>i.key===key);
function nextColor(){ const used=new Set(items().map(i=>i.color)); return PALETTE.find(c=>!used.has(c)) || PALETTE[items().length%PALETTE.length]; }
function newProject(name){ return {id:uid(), name, note:"", items:[], charts:[]}; }
function saveProjects(){ try{ localStorage.setItem(LS_PROJ, JSON.stringify(PROJ)); }catch(e){ toast("Projecten konden niet in deze browser bewaard worden. Gebruik Exporteren.", true); } }
function b64u(str){ const bytes = new TextEncoder().encode(str); let bin=""; bytes.forEach(b=>bin+=String.fromCharCode(b)); return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function unb64u(s){ const bin = atob(s.replace(/-/g,"+").replace(/_/g,"/")); return new TextDecoder().decode(Uint8Array.from(bin,c=>c.charCodeAt(0))); }
function encodeShare(p){
  const keys = p.items.map(i=>i.key);
  return b64u(JSON.stringify({n:p.name, o:p.note, i:p.items.map(i=>[i.label,i.color,i.on?1:0,i.ids,i.kind||""]), d:p.pins||[],
    c:(p.charts||[]).map(c=>({...c, id:undefined, items:c.items.map(k=>keys.indexOf(k)).filter(x=>x>=0)}))}));
}
function decodeShare(str){
  const j = JSON.parse(unb64u(str));
  const its = (j.i||[]).map(x=>({key:uid(), label:x[0], color:x[1], on:!!x[2], ids:x[3]||[], ...(x[4]?{kind:x[4]}:{})}));
  return {id:uid(), name:j.n||"Gedeeld project", note:j.o||"", items:its, pins:j.d||[],
          charts:(j.c||[]).map(c=>({...c, id:uid(), items:(c.items||[]).map(i=>its[i]?.key).filter(Boolean)}))};
}
function loadProjects(){
  let p = null;
  try{ p = JSON.parse(localStorage.getItem(LS_PROJ)); }catch(e){}
  if (!p?.projects?.length){ const first = newProject("Werkzaamheden Van Brienenoordbrug"); p = {projects:[first], active:first.id}; }
  PROJ = p;
  const m = location.hash.match(/[#&]p=([^&]+)/);
  if (m){
    try{ const sp = decodeShare(m[1]); PROJ.projects.push(sp); PROJ.active = sp.id; saveProjects(); setTimeout(()=>toast(`Gedeeld project "${sp.name}" toegevoegd.`), 400); }
    catch(e){ setTimeout(()=>toast("De gedeelde link is ongeldig.", true), 400); }
    history.replaceState(null, "", location.pathname + location.search);
  }
}
function renderProjectBar(){
  $("#proj-select").innerHTML = PROJ.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===PROJ.active?"selected":""}>${esc(p.name)}</option>`).join("");
  $("#proj-note").value = project().note || "";
  $("#charts-proj").textContent = project().name;
}
function switchProject(id){
  PROJ.active = id; editing = null; saveProjects();
  renderProjectBar(); drawMine(); renderSelected(); renderList(); refreshAt().then(()=>{ renderSelected(); }); renderCharts(); drawDrips();
  const b = projectBounds(); if (b) map.fitBounds(b.pad(.25));
}
function projectBounds(){
  const pts = items().flatMap(i=>i.ids.filter(id=>SITES[id]).flatMap(id=>SITES[id].coords));
  return pts.length ? L.latLngBounds(pts) : null;
}
$("#proj-select").onchange = e => switchProject(e.target.value);
$("#proj-new").onclick = ()=>{ const name = prompt("Naam van het nieuwe project:", "Nieuw project"); if (!name) return; const p = newProject(name.trim()); PROJ.projects.push(p); switchProject(p.id); };
$("#proj-note").oninput = e => { project().note = e.target.value; saveProjects(); };
$("#proj-menu").onclick = e => { e.stopPropagation(); $("#proj-menu-list").hidden = !$("#proj-menu-list").hidden; };
document.addEventListener("click", ()=> $("#proj-menu-list").hidden = true);
$("#proj-menu-list").onclick = e => {
  const act = e.target.dataset.act; if (!act) return;
  const p = project();
  if (act==="rename"){ const n = prompt("Nieuwe naam:", p.name); if (n){ p.name=n.trim(); saveProjects(); renderProjectBar(); } }
  if (act==="dup"){ const c = JSON.parse(JSON.stringify(p)); c.id=uid(); c.name=p.name+" (kopie)"; PROJ.projects.push(c); switchProject(c.id); }
  if (act==="share"){
    const url = location.origin + location.pathname + "#p=" + encodeShare(p);
    (navigator.clipboard?.writeText(url) || Promise.reject()).then(()=>toast("Link gekopieerd. Wie hem opent krijgt een eigen kopie van dit project, inclusief grafieken."), ()=>prompt("Kopieer deze link:", url));
  }
  if (act==="export"){
    const blob = new Blob([JSON.stringify({version:2, project:p}, null, 2)], {type:"application/json"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = p.name.replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"_")+".json"; a.click(); URL.revokeObjectURL(a.href);
  }
  if (act==="import") $("#proj-import").click();
  if (act==="delete"){
    if (PROJ.projects.length===1){ toast("Er moet minstens één project blijven."); return; }
    if (!confirm(`Project "${p.name}" verwijderen?`)) return;
    PROJ.projects = PROJ.projects.filter(x=>x.id!==p.id); switchProject(PROJ.projects[0].id);
  }
};
$("#proj-import").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try{ const j = JSON.parse(await f.text()); const p = j.project || j; if (!p.items) throw 0; p.id = uid(); p.charts ||= []; PROJ.projects.push(p); switchProject(p.id); toast(`Project "${p.name}" geïmporteerd.`); }
  catch(err){ toast("Dit bestand is geen geldig project.", true); }
  e.target.value = "";
};

// ================================================================ kaart
const OffsetLine = L.Polyline.extend({
  _projectLatlngs(latlngs, result, bounds){
    L.Polyline.prototype._projectLatlngs.call(this, latlngs, result, bounds);
    const o = this.options.offset; if (!o) return;
    for (const ring of result){
      if (ring._off || ring.length < 2) continue;
      ring._off = true;
      const n = ring.length, normals = [];
      for (let i=0;i<n-1;i++){ const dx = ring[i+1].x-ring[i].x, dy = ring[i+1].y-ring[i].y, len = Math.hypot(dx,dy)||1; normals.push([-dy/len, dx/len]); }
      const out = ring.map((p,i)=>{ const a = normals[Math.max(0,i-1)], b = normals[Math.min(n-2,i)]; let nx=a[0]+b[0], ny=a[1]+b[1]; const l=Math.hypot(nx,ny)||1; nx/=l; ny/=l; const cos=Math.max(.5, nx*b[0]+ny*b[1]); return L.point(p.x+nx*o/cos, p.y+ny*o/cos); });
      out.forEach((q,i)=>{ ring[i].x=q.x; ring[i].y=q.y; });
    }
  }
});
const offLine = (ll, o) => new OffsetLine(ll, o);
L.Popup.mergeOptions({autoPanPaddingTopLeft:[20,70], autoPanPaddingBottomRight:[290,20]});

const map = L.map("map",{zoomControl:false, preferCanvas:false}).setView([51.901,4.539], 13);
L.control.zoom({position:"bottomleft"}).addTo(map);
const ATTR = 'Kaart &copy; <a href="https://www.kadaster.nl">Kadaster</a> / <a href="https://www.pdok.nl">PDOK</a> · data <a href="https://opendata.ndw.nu/">NDW</a>';
const brt = l => L.tileLayer(`https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/${l}/EPSG:3857/{z}/{x}/{y}.png`,{maxZoom:20,maxNativeZoom:19,attribution:ATTR});
const BASES = {
  grijs: brt("grijs"), kleur: brt("standaard"), donker: brt("grijs"),
  foto: L.tileLayer("https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg",{maxZoom:21,maxNativeZoom:19,attribution:'Luchtfoto &copy; <a href="https://www.pdok.nl">PDOK</a> / Beeldmateriaal.nl · data <a href="https://opendata.ndw.nu/">NDW</a>'}),
};
let baseLayer = null;
function setBase(k){ if (baseLayer) baseLayer.remove(); baseLayer = (BASES[k]||BASES.grijs).addTo(map); map.getContainer().classList.toggle("basemap-dark", k==="donker"); ui.base=k; saveUI(); }
setBase(ui.base in BASES ? ui.base : "grijs");
document.querySelectorAll('input[name=base]').forEach(r=>{ r.checked = r.value===ui.base; r.onchange=()=>setBase(r.value); });

[["flow",405],["mine",420],["signs",430],["msi",440],["drip",450]].forEach(([n,z])=>{ map.createPane(n).style.zIndex=z; });
const flowRenderer = L.canvas({pane:"flow", padding:.3, tolerance:5});
const mineRenderer = L.svg({pane:"mine"});
L.marker([51.901,4.539],{icon:L.divIcon({className:"",html:'<div style="width:12px;height:12px;background:#28DB76;border:2px solid #042D23;transform:rotate(45deg)"></div>',iconSize:[12,12]}),title:"Van Brienenoordbrug",pane:"drip"}).addTo(map).bindTooltip("Van Brienenoordbrug");

// ---- doorstroming (alle segmenten, per bron aan/uit)
const flowLines = {};
function buildFlow(){
  Object.values(flowLines).forEach(l=>l.remove());
  for (const id in SITES){
    const l = offLine(SITES[id].coords,{renderer:flowRenderer,weight:3.5,opacity:.9,lineCap:"round",offset:3.5});
    l.on("click", e => onSegmentClick(id, e.latlng));
    l.on("mouseover", ()=>{ l.setStyle({weight:7}); l.bindTooltip(esc(prettyName(id)),{sticky:true,opacity:.95}).openTooltip(); });
    l.on("mouseout", ()=> styleFlowOne(id));
    flowLines[id] = l;
  }
  styleFlow();
}
function styleFlowOne(id){
  const l = flowLines[id]; if (!l) return;
  if (!siteVisible(id) && !editing){ l.remove(); return; }
  const c = CLS[id] ?? ".";
  l.setStyle({color:flowColor(c), weight: editing?4.5:3.5, opacity: c==="."||c==="-" ? .55 : .92, dashArray: c==="."||c==="-" ? "2 5" : null});
  if (!map.hasLayer(l)) l.addTo(map);
}
function styleFlow(){ for (const id in flowLines) styleFlowOne(id); }
function renderGroups(){
  const counts = {}; Object.keys(SITES).forEach(id=>{ const g=groupOf(id); counts[g]=(counts[g]||0)+1; });
  $("#seg-groups").innerHTML = GROUPS.filter(g=>counts[g.key]).map(g=>
    `<label class="chk"><input type="checkbox" data-g="${g.key}" ${ui.groups[g.key]?"checked":""}> ${esc(g.label)} <span class="cnt num">${counts[g.key]}</span></label>`).join("");
}
$("#seg-groups").addEventListener("change", e=>{ const g = e.target.dataset.g; if (!g) return; ui.groups[g] = e.target.checked; saveUI(); styleFlow(); renderList(); });

// ---- mijn trajecten
const mineGroup = L.layerGroup().addTo(map);
function drawMine(){
  mineGroup.clearLayers();
  if (!ui.layers.mine) return;
  for (const it of items()){
    if (!it.on && it.key!==editing) continue;
    if (isLus(it)){
      for (const id of it.ids){ const s = LOOPS[id]; if (!s) continue;
        L.circleMarker([s.lat,s.lon],{renderer:mineRenderer,radius:9,color:it.color,weight:4,fillColor:"#fff",fillOpacity:.9})
          .bindTooltip(esc(it.label)).on("click", e=>{ L.popup().setLatLng(e.latlng).setContent("<div class='pop'>laden…</div>").openOn(map); loopPopup(id).then(h=>map._popup?.setContent(h)); }).addTo(mineGroup); }
      continue;
    }
    for (const id of it.ids){
      const s = SITES[id]; if (!s) continue;
      offLine(s.coords,{renderer:mineRenderer,color:"#fff",weight:11,opacity:.95,interactive:false,lineCap:"round",offset:6}).addTo(mineGroup);
      const l = offLine(s.coords,{renderer:mineRenderer,color:it.color,weight:7,opacity:1,lineCap:"round",offset:6,dashArray: it.on?null:"6 6"}).addTo(mineGroup);
      l.on("click", e => editing ? onSegmentClick(id, e.latlng) : L.popup().setLatLng(e.latlng).setContent(itemPopup(it, id)).openOn(map));
      l.bindTooltip(esc(it.label),{sticky:true});
    }
  }
}
function itemPopup(it, id){
  const g = groupM(it);
  return `<div class="pop">${TIME!=null?`<span class="hist">${esc(timeLabel(TIME))}</span>`:""}<h4>${esc(it.label)}</h4>
    <div class="m num">${mmss(g.dur)} min · ${g.speed?Math.round(g.speed)+" km/u · ":""}${km(g.len)} km</div>
    <div class="m">${esc(g.txt)} · segment ${esc(prettyName(id))}</div>
    <div class="acts"><button class="ghost sm" onclick="startEdit('${it.key}')">Segmenten bewerken</button></div></div>`;
}
function segPopup(id){
  const s = SITES[id], d = durOf(id), r = refOf(id), c = classify(d, r);
  const opts = items().map(i=>`<option value="${esc(i.key)}">${esc(i.label)}</option>`).join("");
  return `<div class="pop">${TIME!=null?`<span class="hist">${esc(timeLabel(TIME))}</span>`:""}<h4>${esc(prettyName(id))}</h4>
    <div class="m num">${mmss(d)} min${d&&s.length?` · ${Math.round(s.length/d*3.6)} km/u`:""} · ${km(s.length)} km</div>
    <div class="m"><span style="color:${flowColor(c)}">●</span> ${r?`referentie ${mmss(r)}`:"geen referentie"} · ${esc(PREFIX_LABELS[prefix(id)]||prefix(id))}</div>
    <div class="m" style="font-size:11px">${esc(id)}</div>
    <div class="acts"><button class="primary sm" onclick="addAsNew('${id}')">› Als nieuw traject</button>
    ${opts?`<select id="addto-${id}">${opts}</select><button class="ghost sm" onclick="addTo('${id}', document.getElementById('addto-${id}').value)">Toevoegen</button>`:""}</div></div>`;
}
function onSegmentClick(id, latlng){
  if (editing){ toggleInItem(editing, id); return; }
  L.popup().setLatLng(latlng).setContent(segPopup(id)).openOn(map);
}
window.addAsNew = id => { items().push({key:uid(), label:prettyName(id), color:nextColor(), on:true, ids:[id]}); map.closePopup(); changed(); };
window.addTo = (id, key) => { const it = findItem(key); if (it && !it.ids.includes(id)) it.ids.push(id); map.closePopup(); changed(); };
function toggleInItem(key, id){ const it = findItem(key); if (!it) return; const i = it.ids.indexOf(id); if (i>=0) it.ids.splice(i,1); else it.ids.push(id); changed(); }
async function changed(){ saveProjects(); drawMine(); renderSelected(); renderList(); await refreshAt(); renderSelected(); renderCharts(); }
window.startEdit = key => {
  editing = key; const it = findItem(key); map.closePopup();
  $("#editbar").hidden = false; $("#editbar-name").textContent = it.label; $("#editbar-sw").style.background = it.color;
  styleFlow(); drawMine(); renderSelected();
};
function stopEdit(){ editing = null; $("#editbar").hidden = true; styleFlow(); drawMine(); renderSelected(); }
$("#editbar-done").onclick = stopEdit;
document.addEventListener("keydown", e=>{ if (e.key==="Escape" && editing) stopEdit(); });
$("#new-group").onclick = ()=>{
  const it = {key:uid(), label:`Traject ${items().length+1}`, color:nextColor(), on:true, ids:[]};
  items().push(it); saveProjects(); startEdit(it.key);
  requestAnimationFrame(()=>document.querySelector(`.card[data-key="${it.key}"]`)?.scrollIntoView({block:"nearest",behavior:"smooth"}));
  toast("Klik op de gekleurde lijnen op de kaart om segmenten aan dit traject toe te voegen.");
};

// ================================================================ trajectkaarten
const I = {
  eye:'<svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:'<svg viewBox="0 0 24 24"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-7 0-11-7-11-7a19 19 0 0 1 5.1-5.9M9.9 5.2A9.6 9.6 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-2.2 3.2M1 1l22 22"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  zoom:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  edit:'<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  chart:'<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 6-6"/></svg>',
  table:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg>',
  dl:'<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14"/></svg>',
  copy:'<svg viewBox="0 0 24 24"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
};
let SPARK = {};   // key -> [[t, s]]
function sumSeries(segSeries, ids){
  const ok = ids.filter(id=>SITES[id]); if (!ok.length) return [];
  const maps = ok.map(id=>new Map(segSeries[id]||[]));
  const times = [...maps[0].keys()];
  const out = [];
  for (const t of times){ let s=0, all=true; for (const m of maps){ const v=m.get(t); if (v==null){ all=false; break; } s+=v; } if (all) out.push([t,s]); }
  return out;
}
function sparkline(it){
  const pts = SPARK[it.key] || [];
  const fmtv = isLus(it) ? (v=>Math.round(v)+" vtg/u") : mmss;
  if (pts.length < 2) return `<div class="spark-meta"><span>verloop verschijnt na een paar metingen</span></div>`;
  const W=360,H=30,t0=pts[0][0],t1=pts[pts.length-1][0], vals=pts.map(p=>p[1]), lo=Math.min(...vals), hi=Math.max(...vals), sp=(hi-lo)||1;
  const x=t=>((t-t0)/((t1-t0)||1))*W, y=v=>H-3-((v-lo)/sp)*(H-6);
  const d = pts.map((p,i)=>`${i?"L":"M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const l = pts[pts.length-1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="verloop laatste 6 uur"><path d="${d}" stroke="${it.color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/><circle cx="${x(l[0])}" cy="${y(l[1])}" r="2.5" fill="${it.color}" stroke="none"/></svg>
    <div class="spark-meta num"><span>${hhmm(new Date(t0*1000))}</span><span>min ${fmtv(lo)} · max ${fmtv(hi)}</span><span>${hhmm(new Date(t1*1000))}</span></div>`;
}
function renderSelected(){
  const box = $("#selected"), list = items();
  if (!list.length){ box.innerHTML = `<div class="empty">Nog geen trajecten. Klik een segment in de lijst of op de kaart, of stel een traject samen uit meerdere segmenten.</div>`; return; }
  box.innerHTML = list.map(it=>{
    if (isLus(it)){
      const g = lusM(it);
      return `<div class="card ${it.on?"":"off"}" style="--c:${it.color}" data-key="${esc(it.key)}">
      <div class="top">
        <label class="swatch" title="Kleur kiezen"><input type="color" value="${it.color}" data-act="color"></label>
        <span class="name" contenteditable="plaintext-only" spellcheck="false" title="Klik om de naam te wijzigen" data-act="name">${esc(it.label)}</span>
        <button class="icon" data-act="chart" title="Grafiek maken van dit meetpunt">${I.chart}</button>
        <button class="icon" data-act="zoom" title="Inzoomen">${I.zoom}</button>
        <button class="icon" data-act="on" title="${it.on?"Verbergen op kaart":"Tonen op kaart"}" aria-pressed="${it.on}">${it.on?I.eye:I.eyeOff}</button>
        <button class="icon" data-act="del" title="Verwijderen">${I.x}</button>
      </div>
      <div class="segs">meetpunt lusdetectie${g.n>1?` · ${g.n} lussen`:""}</div>
      <div class="metrics">
        <div><div class="big num">${g.f!=null?Math.round(g.f):"–"}</div><div class="lbl">intensiteit (vtg/u)</div></div>
        <div><div class="big num">${g.speed!=null?Math.round(g.speed):"–"}</div><div class="lbl">km/u gem.</div></div>
        <span class="badge ${g.cls}">${esc(g.txt)}</span>
      </div>
      ${sparkline(it)}
    </div>`;
    }
    const g = groupM(it);
    return `<div class="card ${it.on?"":"off"} ${editing===it.key?"editing":""}" style="--c:${it.color}" data-key="${esc(it.key)}">
      <div class="top">
        <label class="swatch" title="Kleur kiezen"><input type="color" value="${it.color}" data-act="color"></label>
        <span class="name" contenteditable="plaintext-only" spellcheck="false" title="Klik om de naam te wijzigen" data-act="name">${esc(it.label)}</span>
        <button class="icon ${editing===it.key?"on":""}" data-act="edit" title="Segmenten kiezen op de kaart">${I.edit}</button>
        <button class="icon" data-act="chart" title="Grafiek maken van dit traject">${I.chart}</button>
        <button class="icon" data-act="zoom" title="Inzoomen">${I.zoom}</button>
        <button class="icon" data-act="on" title="${it.on?"Verbergen op kaart":"Tonen op kaart"}" aria-pressed="${it.on}">${it.on?I.eye:I.eyeOff}</button>
        <button class="icon" data-act="del" title="Verwijderen">${I.x}</button>
      </div>
      <div class="segs">${g.n} segment${g.n===1?"":"en"} · ${km(g.len)} km</div>
      <div class="metrics">
        <div><div class="big num">${mmss(g.dur)}</div><div class="lbl">reistijd (min)</div></div>
        <div><div class="big num">${g.speed?Math.round(g.speed):"–"}</div><div class="lbl">km/u gem.</div></div>
        <span class="badge ${g.cls}" title="referentie ${g.ref?mmss(g.ref):"–"}">${esc(g.txt)}</span>
      </div>
      ${sparkline(it)}
    </div>`;
  }).join("");
}
$("#selected").addEventListener("click", e=>{
  const b = e.target.closest("[data-act]"); if (!b || b.dataset.act==="name" || b.dataset.act==="color") return;
  const key = b.closest(".card").dataset.key, it = findItem(key);
  switch (b.dataset.act){
    case "on": it.on=!it.on; saveProjects(); drawMine(); renderSelected(); break;
    case "del": if (it.ids.length>1 && !confirm(`"${it.label}" verwijderen?`)) return;
      if (editing===key) stopEdit(); project().items = items().filter(i=>i.key!==key);
      charts().forEach(c=>c.items = c.items.filter(k=>k!==key)); changed(); break;
    case "zoom": { const pts = isLus(it) ? it.ids.filter(id=>LOOPS[id]).map(id=>[LOOPS[id].lat,LOOPS[id].lon]) : it.ids.filter(id=>SITES[id]).flatMap(id=>SITES[id].coords);
      if (pts.length) isLus(it) ? map.setView(pts[0], 16) : map.fitBounds(L.latLngBounds(pts).pad(.4)); break; }
    case "edit": editing===key ? stopEdit() : startEdit(key); break;
    case "chart": openChartDialog(null, {items:[key], title:it.label, metric: isLus(it) ? "intensiteit" : "reistijd"}); break;
  }
});
$("#selected").addEventListener("input", e=>{
  if (e.target.dataset.act!=="color") return;
  const card = e.target.closest(".card"), it = findItem(card.dataset.key);
  it.color = e.target.value; card.style.setProperty("--c", it.color); drawMine();
  if (editing===it.key) $("#editbar-sw").style.background = it.color;
});
$("#selected").addEventListener("change", e=>{ if (e.target.dataset.act==="color"){ saveProjects(); renderList(); renderCharts(); } });
$("#selected").addEventListener("focusout", e=>{
  if (e.target.dataset.act!=="name") return;
  const it = findItem(e.target.closest(".card").dataset.key), v = e.target.textContent.trim();
  if (v && v!==it.label){ it.label = v; saveProjects(); drawMine(); renderCharts(); if (editing===it.key) $("#editbar-name").textContent=v; }
  else e.target.textContent = it.label;
});
$("#selected").addEventListener("keydown", e=>{ if (e.target.dataset.act==="name" && e.key==="Enter"){ e.preventDefault(); e.target.blur(); } });
$("#all-on").onclick = ()=>{ items().forEach(i=>i.on=true); saveProjects(); drawMine(); renderSelected(); };
$("#all-off").onclick = ()=>{ items().forEach(i=>i.on=false); saveProjects(); drawMine(); renderSelected(); };

// ================================================================ segmentenlijst
function itemOf(id){ return items().find(i=>i.ids.includes(id)); }
function loopRoad(id){
  const m = /^(\d{3})\d(h?r[lr])/.exec(LOOPS[id]?.name||"");
  return m ? `A${+m[1]} ${m[2].endsWith("l")?"Li":"Re"}` : "";
}
function renderLoopList(q, inView, b){
  let ids = Object.keys(LOOPS);
  if (q) ids = ids.filter(id => (loopName(id)+" "+id+" "+loopRoad(id)).toLowerCase().includes(q));
  if (inView) ids = ids.filter(id => b.contains([LOOPS[id].lat, LOOPS[id].lon]));
  ids.sort((a,c)=>(LOOPS[a].dist??0)-(LOOPS[c].dist??0));
  $("#count").textContent = `${ids.length} / ${Object.keys(LOOPS).length}`;
  if (!Object.keys(LOOPS).length){ $("#list").innerHTML = `<div class="empty" style="padding:12px 16px">De meetpunten (lusdetectie) zijn nog niet geladen.</div>`; return; }
  $("#list").innerHTML = ids.slice(0,300).map(id=>{
    const it = items().find(i=>isLus(i) && i.ids.includes(id)), v = TIME==null ? LOOP_NOW[id] : null, s = LOOPS[id], c = LCLS[id] ?? ".";
    const road = loopRoad(id);
    return `<div class="row ${it?"in":""}" data-loop="${esc(id)}" ${it?`style="--c:${it.color}"`:""}>
      <span class="dotc" style="background:${it?it.color:flowColor(c)}"></span>
      <div style="min-width:0"><div class="n">${esc(loopName(id))}</div>
        <div class="sub">meetpunt${road?" · "+esc(road):""} · ${s.lanes||"?"} rijstroken${it?` · in “${esc(it.label)}”`:""}</div></div>
      <div class="tt num">${v?.f!=null?`${v.f.toLocaleString("nl-NL")}<small>vtg/u${v.s!=null?" · "+v.s+" km/u":""}</small>`:""}</div></div>`;
  }).join("") || `<div class="empty" style="padding:12px 16px">Geen meetpunten${inView?" in het kaartbeeld":""}. Zet “in beeld” uit of zoom uit.</div>`;
}
function renderList(){
  const q = $("#q").value.trim().toLowerCase(), inView = $("#inview").checked, b = map.getBounds();
  if (ui.listKind==="lus") return renderLoopList(q, inView, b);
  let ids = Object.keys(SITES).filter(siteVisible);
  if (q) ids = ids.filter(id => (prettyName(id)+" "+SITES[id].name+" "+id).toLowerCase().includes(q));
  if (inView) ids = ids.filter(id => SITES[id].coords.some(c=>b.contains(c)));
  ids.sort((a,c)=>SITES[a].dist-SITES[c].dist);
  $("#count").textContent = `${ids.length} / ${Object.keys(SITES).length}`;
  $("#list").innerHTML = ids.slice(0,300).map(id=>{
    const d = TIME==null ? DATA[id]?.d : null, r = refOf(id), it = itemOf(id), s = SITES[id], c = CLS[id] ?? ".";
    return `<div class="row ${it?"in":""}" data-id="${esc(id)}" ${it?`style="--c:${it.color}"`:""}>
      <span class="dotc" style="background:${it?it.color:flowColor(c)}"></span>
      <div style="min-width:0"><div class="n">${esc(prettyName(id))}</div>
        <div class="sub">${esc(PREFIX_LABELS[prefix(id)]||prefix(id))} · ${km(s.length)} km${it?` · in “${esc(it.label)}”`:""}</div></div>
      <div class="tt num">${TIME==null?mmss(d):""}${TIME==null&&d!=null&&r?`<small>${d-r>=1?"+"+mmss(d-r):"±0:00"}</small>`:""}</div></div>`;
  }).join("") || `<div class="empty" style="padding:12px 16px">Geen segmenten${inView?" in het kaartbeeld":""}. Zet in Kaartlagen meer bronnen aan of zoom uit.</div>`;
}
$("#list").addEventListener("click", e=>{
  const lr = e.target.closest("[data-loop]");
  if (lr){
    const id = lr.dataset.loop, s = LOOPS[id];
    if (!ui.layers.loops){ $("#ly-loops").checked = true; $("#ly-loops").dispatchEvent(new Event("change")); }
    if (!items().some(i=>isLus(i) && i.ids.includes(id))) addLoop(id);
    map.setView([s.lat, s.lon], Math.max(map.getZoom(), 15));
    return;
  }
  const row = e.target.closest(".row"); if (!row) return;
  const id = row.dataset.id;
  if (editing){ toggleInItem(editing, id); return; }
  if (itemOf(id)){ map.fitBounds(L.latLngBounds(SITES[id].coords).pad(1.5)); return; }
  addAsNew(id);
});
$("#list").addEventListener("mouseover", e=>{ const lr=e.target.closest("[data-loop]"); if (lr){ loopMarkers[lr.dataset.loop]?.setStyle({radius:9, weight:3, color:"#121212"}); return; } const r=e.target.closest(".row"); const l = r && flowLines[r.dataset.id]; if (l && map.hasLayer(l)) l.setStyle({weight:9}); });
$("#list").addEventListener("mouseout", e=>{ const lr=e.target.closest("[data-loop]"); if (lr){ const c = LCLS[lr.dataset.loop] ?? "."; loopMarkers[lr.dataset.loop]?.setStyle({radius: c==="."||c==="-" ? 3 : 4.5, weight:1.5, color:"#fff"}); return; } const r=e.target.closest(".row"); if (r) styleFlowOne(r.dataset.id); });
if (ui.listKind==="lus") $("#q").placeholder = "Zoek meetpunt, bv. A16, 0160hrr, richting zuid…";
document.querySelectorAll('input[name=lk]').forEach(r=>{ r.checked = r.value===(ui.listKind||"seg"); r.onchange = ()=>{ ui.listKind = r.value; saveUI();
  $("#q").placeholder = ui.listKind==="lus" ? "Zoek meetpunt, bv. A16, 0160hrr, richting zuid…" : "Zoek, bv. A16 Re, Stadionweg, N471…";
  if (ui.listKind==="lus" && !ui.layers.loops){ $("#ly-loops").checked = true; $("#ly-loops").dispatchEvent(new Event("change")); toast("Laag Lusdetectie aangezet; meetpunten zie je vanaf zoomniveau 12."); }
  renderList(); }; });
$("#q").oninput = renderList; $("#inview").onchange = renderList;
let moveT; map.on("moveend", ()=>{ clearTimeout(moveT); moveT=setTimeout(()=>{ if ($("#inview").checked) renderList(); refreshSigns(); },150); });

// ================================================================ lagenpaneel
function bindLayer(id, key, fn){ const el = $(id); el.checked = !!ui.layers[key]; el.onchange = ()=>{ ui.layers[key] = el.checked; saveUI(); fn(); }; }
bindLayer("#ly-mine","mine", drawMine);
bindLayer("#ly-msi","msi", ()=>{ $("#msi-box").hidden = !ui.layers.msi; drawMsi(); });
bindLayer("#ly-loops","loops", ()=>{ $("#loops-box").hidden = !ui.layers.loops; drawLoops(); });
bindLayer("#ly-sit","sit", ()=>{ $("#sit-box").hidden = !ui.layers.sit; drawSits(); });
bindLayer("#ly-plan","plan", ()=>{ $("#plan-box").hidden = !ui.layers.plan; drawPlan(); });
bindLayer("#ly-ovnet","ovnet", ()=>{ $("#ovnet-box").hidden = !ui.layers.ovnet; drawOvNet(); });
bindLayer("#ly-ovveh","ovveh", ()=>{ $("#ovveh-box").hidden = !ui.layers.ovveh; drawOvVeh(); });
for (const k of ["loops","sit","plan","ovnet","ovveh"]) $(`#${k}-box`).hidden = !ui.layers[k];
$("#plan-when").value = ui.planWhen || "at"; $("#plan-when").onchange = e=>{ ui.planWhen = e.target.value; saveUI(); drawPlan(); };

bindLayer("#ly-drip","drip", ()=>{ $("#drip-box").hidden = !ui.layers.drip; drawDrips(); });
bindLayer("#ly-signs","signs", ()=>{ $("#signs-box").hidden = !ui.layers.signs; refreshSigns(); });
$("#msi-box").hidden = !ui.layers.msi; $("#drip-box").hidden = !ui.layers.drip; $("#signs-box").hidden = !ui.layers.signs;
$("#msi-active").checked = ui.msiActive; $("#msi-active").onchange = e=>{ ui.msiActive = e.target.checked; saveUI(); drawMsi(); };
$("#drip-size").value = ui.dripSize || "m"; $("#drip-size").onchange = e=>{ ui.dripSize = e.target.value; saveUI(); drawDrips(); };
$("#drip-active").checked = ui.dripActive; $("#drip-active").onchange = e=>{ ui.dripActive = e.target.checked; saveUI(); drawDrips(); };
$("#layers-toggle").onclick = ()=>{ ui.layersOpen = !ui.layersOpen; saveUI(); applyLayersOpen(); };
function applyLayersOpen(){ $("#layers-body").hidden = !ui.layersOpen; $("#layers-toggle").setAttribute("aria-expanded", ui.layersOpen); }
applyLayersOpen();
L.DomEvent.disableClickPropagation($("#layers")); L.DomEvent.disableScrollPropagation($("#layers"));

// ================================================================ MSI
const msiGroup = L.layerGroup().addTo(map);
let MSI_LIVE = [], MSI_META = null;
function decodeLane(code){
  const f = code.endsWith("*"), c = f ? code.slice(0,-1) : code, d = {};
  if (f) d.f = 1;
  if (c[0]==="s"){ d.k="speedlimit"; d.v=c.slice(1).replace("r",""); if (c.endsWith("r")) d.r=1; }
  else d.k = {x:"lane_closed","<":"lane_closed_ahead",">":"lane_closed_ahead",o:"lane_open",e:"restriction_end",b:"blank"}[c] || "unknown";
  if (c==="<") d.s="merge_left"; if (c===">") d.s="merge_right";
  return d;
}
function decodePortal(key, code, meta){
  return {k:key, ...meta, lanes: code.split(";").map(x=>{ const [n,c]=x.split("="); return {n, d:decodeLane(c||"?")}; })};
}
const dayCache = new Map();
function loadDayChanges(kind, day){
  const key = `${kind}/${day}@${isToday(day)?bust():"f"}`;
  if (!dayCache.has(key)) dayCache.set(key, getDayJSON(`${kind}/${day}.json`, day, kind, isToday(day)?undefined:"final").catch(()=>({steps:[]})));
  return dayCache.get(key);
}
/** Stand van matrixborden/DRIP's op tijdstip T door de wijzigingen van die dag af te spelen. */
async function stateAt(kind, T){
  const day = dayUTC(T);
  let f = await loadDayChanges(kind, day), st = {};
  if (!f.steps.length || f.steps[0][0] > T){
    const prev = dayUTC(T-86400); f = {steps:[...(await loadDayChanges(kind, prev)).steps, ...f.steps]};
  }
  let at = null;
  for (const [t, ch] of f.steps){ if (t > T) break; at = t; for (const [k,v] of Object.entries(ch)){ if (v==null) delete st[k]; else st[k]=v; } }
  return {state: st, at};
}
function laneHtml(l){
  const h = laneSym(l);
  return l.d?.f ? h.replace(/<\/b>$/, '<i class="fl l"></i><i class="fl r"></i></b>') : h;
}
function laneSym(l){
  const d = l.d||{}, f = d.f ? " f" : "";
  switch (d.k){
    case "speedlimit": return `<b class="sp${d.r?" r":""}${f}">${esc(d.v)}</b>`;
    case "lane_closed": return `<b class="x${f}">✕</b>`;
    case "lane_closed_ahead": return `<b class="ar${f}">${d.s==="merge_left"?"↙":"↘"}</b>`;
    case "lane_open": return `<b class="op${f}">↓</b>`;
    case "restriction_end": return `<b class="end${f}"></b>`;
    case "blank": return `<b${f?' class="f"':""}></b>`;
    default: return `<b class="unk">?</b>`;
  }
}
const LANE_TXT = {speedlimit:"snelheid",lane_closed:"rijstrook dicht (kruis)",lane_closed_ahead:"rijstrook dicht verderop",lane_open:"rijstrook open (pijl)",restriction_end:"einde beperkingen",blank:"leeg",unknown:"onbekend"};
function portalSummary(p){ const k = p.lanes.map(l=>l.d?.k); return k.includes("lane_closed") ? "x" : k.includes("speedlimit") ? "sp" : (k.includes("lane_open")||k.includes("lane_closed_ahead")) ? "op" : ""; }
const portalActive = p => p.lanes.some(l=>l.d && (l.d.f || (l.d.k!=="blank" && l.d.k!=="unknown")));
const portalFlash = p => p.lanes.some(l=>l.d?.f);
let msiReq = 0;
async function drawMsi(){
  const my = ++msiReq;
  if (!ui.layers.msi){ msiGroup.clearLayers(); return; }
  let portals = MSI_LIVE;
  if (TIME!=null){
    try{
      MSI_META ||= await getJSON("data/msi/meta.json");
      const r = await stateAt("msi", TIME);
      portals = Object.entries(r.state).filter(([k])=>MSI_META[k]).map(([k,c])=>decodePortal(k, c, MSI_META[k]));
      portals.forEach(p=>p.lanes.sort((a,b)=>(+a.n||99)-(+b.n||99)));
    }catch(e){ portals = []; }
  }
  if (my!==msiReq) return;
  msiGroup.clearLayers();
  const detail = map.getZoom() >= MSI_DETAIL_ZOOM;
  let shown = 0;
  for (const p of portals){
    if (ui.msiActive && !portalActive(p)) continue;
    shown++;
    // Draaien naar de rijrichting: de weggebruiker rijdt richting 'bearing' (graden vanaf noord, met de klok mee)
    // en kijkt tegen het portaal aan; rijstrook 1 staat links. Zonder rijrichting: niet draaien.
    const rot = p.bearing!=null ? `transform:rotate(${p.bearing}deg)` : "";
    const html = detail
      ? `<div class="msi-rot" style="${rot}"><div class="msi">${p.lanes.map(laneHtml).join("")}</div><i class="msi-dir"></i></div>`
      : `<div class="msi-rot" style="${rot}"><div class="msi-dot ${portalSummary(p)} ${portalFlash(p)?"fl":""}"></div></div>`;
    const w = detail ? p.lanes.length*20+4 : 12, h = detail ? 22 : 6;
    L.marker([p.lat,p.lon],{pane:"msi",icon:L.divIcon({className:"",html,iconSize:[w,h],iconAnchor:[w/2,h/2]})})
      .bindPopup(()=>`<div class="pop">${TIME!=null?`<span class="hist">${esc(timeLabel(TIME))}</span>`:""}<h4>${esc(p.road)} ${esc(p.cw)} · km ${esc(p.km)}</h4>
        <div class="msi" style="display:inline-flex;transform:scale(1.4);transform-origin:left top;margin:2px 0 14px">${p.lanes.map(laneHtml).join("")}</div>
        <div class="kv">${p.lanes.map(l=>`<span>Rijstrook ${esc(l.n)}</span><span>${esc(LANE_TXT[l.d?.k]||l.d?.k)}${l.d?.v?" "+esc(l.d.v):""}${l.d?.r?" (verplicht)":""}${l.d?.f?" · knipperlichten aan":""}</span>`).join("")}</div>
        ${p.bearing!=null?`<div class="m" style="margin-top:6px">rijrichting ${p.bearing}°</div>`:""}</div>`)
      .addTo(msiGroup);
  }
  const act = portals.filter(portalActive).length;
  $("#cnt-msi").textContent = portals.length ? `${act} / ${portals.length}` : "";
  $("#cnt-msi").title = `${act} portalen met beeldstand van ${portals.length}`;
}
async function loadMsi(){ try{ MSI_LIVE = (await getJSON("data/msi.json", STATE?.msiTime)).portals||[]; }catch(e){ MSI_LIVE = []; } if (TIME==null) drawMsi(); }
let lastDetail = map.getZoom() >= MSI_DETAIL_ZOOM;
let lastZ = map.getZoom();
map.on("zoomend", ()=>{
  const z = map.getZoom(), d = z >= MSI_DETAIL_ZOOM;
  if (d!==lastDetail){ lastDetail=d; drawMsi(); drawDrips(); }
  if ((z>=LOOP_ZOOM)!==(lastZ>=LOOP_ZOOM)) { drawLoops(); drawOvVeh(); }
  if ((z>=15)!==(lastZ>=15)) drawOvNet();
  lastZ = z;
});

// ================================================================ DRIP
const dripGroup = L.layerGroup().addTo(map);
let DRIPS_LIVE = [], DRIP_META = null;
const imgUrl = h => `data/drip/img/${h}.png`;
const imgTag = (h, alt="") => `<img alt="${esc(alt)}" src="${imgUrl(h)}" onerror="archImg(this,'${h}')">`;
const DRIP_W = {s:64, m:110, l:170};
const pinGroup = L.layerGroup().addTo(map);
map.createPane("dripPin").style.zIndex = 660;
async function dripList(){
  if (TIME==null) return DRIPS_LIVE;
  DRIP_META ||= await getJSON("data/drip/meta.json");
  const r = await stateAt("drip", TIME);
  return Object.entries(r.state).filter(([k])=>DRIP_META[k]).map(([k,v])=>({id:k, ...DRIP_META[k], img:v.i, text:v.x, working:v.w, active:!!v.a}));
}
function drawPins(list){
  pinGroup.clearLayers();
  const ids = pins(); if (!ids.length) return;
  const byId = Object.fromEntries(list.map(d=>[d.id,d]));
  for (const id of ids){
    const d = byId[id] || (DRIP_META?.[id] ? {id, ...DRIP_META[id], img:[], text:[]} : DRIPS_LIVE.find(x=>x.id===id));
    if (!d) continue;
    const body = d.img?.length ? d.img.map(h=>imgTag(h, `Beeld van DRIP ${d.name}`)).join("")
      : d.text?.some(t=>t.trim()) ? `<div class="dp-t">${dripLines(d.text)}</div>` : `<div class="dp-e">toont niets</div>`;
    const html = `<div class="drip-pin ${TIME!=null?"hist":""}" data-pin="${esc(id)}"><div class="dp-h"><span title="${esc(d.name)}">${esc(d.name)}</span><button data-unpin="${esc(id)}" title="Losmaken" aria-label="DRIP losmaken">×</button></div>${body}</div>`;
    L.marker([d.lat,d.lon],{pane:"dripPin", icon:L.divIcon({className:"", html, iconSize:[0,0], iconAnchor:[0,0]}), keyboard:false}).addTo(pinGroup);
  }
}
window.togglePin = id => {
  const ps = pins(), i = ps.indexOf(id);
  if (i>=0) ps.splice(i,1); else ps.push(id);
  saveProjects(); map.closePopup(); drawDrips();
  toast(i>=0 ? "DRIP losgemaakt." : "DRIP vastgepind. Het beeld blijft groot op de kaart staan, ook bij uitzoomen; klik × om los te maken.");
};
document.addEventListener("click", e => {
  const u = e.target.closest("[data-unpin]"); if (u){ e.stopPropagation(); e.preventDefault(); togglePin(u.dataset.unpin); return; }
  const p = e.target.closest("[data-pin]"); if (p){ const d = DRIPS_LIVE.find(x=>x.id===p.dataset.pin) || DRIP_META?.[p.dataset.pin]; if (d) map.setView([d.lat,d.lon], Math.max(map.getZoom(), 15)); }
}, true);
function dripLines(lines){ return lines.map(l => esc(l).replace(/%s(\d+)/g,'<span class="rt">$1</span>')).join("<br>"); }
let dripReq = 0;
async function drawDrips(){
  const my = ++dripReq;
  if (!ui.layers.drip && !pins().length){ dripGroup.clearLayers(); pinGroup.clearLayers(); return; }
  let list;
  try{ list = await dripList(); }catch(e){ list = []; }
  if (my!==dripReq) return;
  dripGroup.clearLayers();
  drawPins(list);
  if (!ui.layers.drip) return;
  const pinned = new Set(pins()), dw = DRIP_W[ui.dripSize||"m"] || 110;
  const thumbs = map.getZoom() >= DRIP_THUMB_ZOOM;
  for (const d of list){
    if (ui.dripActive && !d.active) continue;
    if (pinned.has(d.id)) continue;
    const off = d.working && d.working!=="working";
    let icon;
    if (d.active && thumbs && d.img?.length){
      icon = L.divIcon({className:"",html:`<span class="drip-thumb" style="--dw:${dw}px">${d.img.map(h=>imgTag(h)).join("")}</span>`,iconSize:[dw+5,null],iconAnchor:[(dw+5)/2,dw/3]});
    } else {
      icon = L.divIcon({className:"",html:`<div class="drip-ic ${d.active?"on":""} ${off?"off":""}"></div>`,iconSize:d.active?[22,15]:[16,11]});
    }
    L.marker([d.lat,d.lon],{pane:"drip",title:d.name,icon,zIndexOffset:d.active?1000:0}).bindPopup(()=>{
      const imgs = (d.img||[]).map(h=>`<img class="drip" alt="Beeld van DRIP ${esc(d.name)}" src="${imgUrl(h)}" onerror="archImg(this,'${h}')">`).join("");
      const pinBtn = `<div class="acts"><button class="primary sm pin" onclick="togglePin('${esc(d.id)}')">${pins().includes(d.id)?"Losmaken":"📌 Vastpinnen op kaart"}</button></div>`;
      return `<div class="pop">${TIME!=null?`<span class="hist">${esc(timeLabel(TIME))}</span>`:""}<h4>${esc(d.name)}</h4>
        <div class="m">${d.active?"<b style='color:var(--mg-green)'>Toont een boodschap</b>":"Toont niets"}${off?" · ⚠ buiten werking":""}</div>
        ${imgs}${d.text?.some(t=>t.trim())?`<div class="lines">${dripLines(d.text)}</div>`:""}
        <div class="m" style="font-size:11px">${esc(d.id)}</div>${pinBtn}</div>`;
    },{maxWidth:440, minWidth:240}).addTo(dripGroup);
  }
  const act = list.filter(d=>d.active).length;
  $("#cnt-drip").textContent = list.length ? `${act} / ${list.length}` : "";
  $("#cnt-drip").title = `${act} met boodschap van ${list.length}`;
}
async function loadDrips(){ try{ DRIPS_LIVE = (await getJSON("data/drips.json", STATE?.dripTime)).drips||[]; }catch(e){ DRIPS_LIVE = []; } if (TIME==null) drawDrips(); }

// ================================================================ verkeersborden
const signGroup = L.layerGroup().addTo(map);
let signCatsKnown = {}, SIGN_META = null, signReq = 0, signKey = "";
const signTiles = new Map();
function renderSignCats(){
  $("#sign-cats").innerHTML = Object.keys(SIGN_CATS).map(c=>`<span class="chip ${ui.signCats.includes(c)?"on":""}" data-c="${c}" title="${esc(SIGN_CATS[c])}${signCatsKnown[c]?` · ${signCatsKnown[c]} borden`:""}">${c} ${esc(SIGN_CATS[c])}</span>`).join("");
}
$("#sign-cats").addEventListener("click", e=>{ const c = e.target.closest(".chip"); if (!c) return; const k = c.dataset.c, i = ui.signCats.indexOf(k); if (i>=0) ui.signCats.splice(i,1); else ui.signCats.push(k); saveUI(); renderSignCats(); refreshSigns(true); });
function signIcon(s){
  const code = s.rvvCode || "?", c = code[0];
  const label = (s.blackCode && s.blackCode.length<=3 && /^\d+$/.test(s.blackCode)) ? s.blackCode : code;
  let cls = "vb " + (SIGN_CATS[c] ? c : "X");
  if (code==="B6") cls = "vb Bt"; else if (c==="B") cls = "vb X";
  return L.divIcon({className:"",html:`<div class="${cls}">${esc(label)}</div>`,iconSize:cls.includes(" K")?[26,16]:[22,22]});
}
function signPopup(s){
  const row = (k,v) => v ? `<span>${k}</span><span>${esc(v)}</span>` : "";
  return `<div class="pop"><h4>${esc(s.rvvCode)} – ${esc(SIGN_CATS[(s.rvvCode||"")[0]]||"bord")}</h4>
    <div class="kv">${row("Onderbord",s.blackCode)}${row("Tekst",s.textSigns)}${row("Weg",s.roadName)}${row("Plaats",s.townName)}${row("Richting",s.bearing?s.bearing+"°":"")}
    ${row("Geplaatst",s.placedOn)}${row("Verwacht weg",s.expectedRemovedOn)}${row("Laatst gezien",s.lastSeenOn)}</div>
    ${s.imageUrl?`<a href="${esc(s.imageUrl)}" target="_blank" rel="noopener"><img class="photo" loading="lazy" alt="Foto van bord ${esc(s.rvvCode)}" src="${esc(s.imageUrl)}"></a>`:""}</div>`;
}
async function refreshSigns(force){
  if (!ui.layers.signs){ signGroup.clearLayers(); signKey=""; return; }
  try{ SIGN_META ||= await getJSON("data/signs/meta.json", STATE?.signsTime); }
  catch(e){ $("#signs-hint").textContent = "Verkeersborden zijn nog niet beschikbaar."; return; }
  signCatsKnown = SIGN_META.cats||{}; renderSignCats();
  $("#cnt-signs").textContent = SIGN_META.count||"";
  const z = map.getZoom();
  if (z < SIGN_ZOOM){ signGroup.clearLayers(); signKey=""; $("#signs-hint").textContent = `Zoom verder in om borden te zien (niveau ${z}, nodig ${SIGN_ZOOM}).`; return; }
  const b = map.getBounds().pad(.15), key = [b.toBBoxString(), ui.signCats.join()].join("|");
  if (!force && key===signKey) return;
  signKey = key; const my = ++signReq, size = SIGN_META.tile, have = new Set(SIGN_META.tiles), ks = [];
  for (let i=Math.floor(b.getSouth()/size); i<=Math.floor(b.getNorth()/size); i++) for (let j=Math.floor(b.getWest()/size); j<=Math.floor(b.getEast()/size); j++) if (have.has(`${i}_${j}`)) ks.push(`${i}_${j}`);
  const lists = await Promise.all(ks.map(k=>{ if (!signTiles.has(k)) signTiles.set(k, getJSON(`data/signs/t/${k}.json`, SIGN_META.time).catch(()=>[])); return signTiles.get(k); }));
  if (my!==signReq) return;
  const cats = new Set(ui.signCats), LIMIT = 2500;
  const hits = lists.flat().filter(s => b.contains([s.lat,s.lon]) && cats.has((s.rvvCode||"?")[0]));
  signGroup.clearLayers();
  for (const s of hits.slice(0,LIMIT)) L.marker([s.lat,s.lon],{pane:"signs",icon:signIcon(s)}).bindPopup(()=>signPopup(s)).addTo(signGroup);
  $("#signs-hint").textContent = `${Math.min(hits.length,LIMIT)} van ${hits.length} borden in beeld · stand ${new Date(SIGN_META.time*1000).toLocaleDateString("nl-NL")}.`;
}


// ================================================================ LUSDETECTIE
let LOOPS = {}, LOOP_NOW = {}, LOOP_REF = {}, LIDX = {days:[], buckets:32}, LCLS = {};
const loopGroup = L.layerGroup().addTo(map);
const loopRenderer = L.canvas({pane:"msi", padding:.3, tolerance:4});
const loopMarkers = {};
const LOOP_ZOOM = 12;
const SIDE_NL = {northBound:"noord",southBound:"zuid",eastBound:"oost",westBound:"west",northEastBound:"noordoost",northWestBound:"noordwest",southEastBound:"zuidoost",southWestBound:"zuidwest"};
function loopClass(sp, ref){ if (sp==null) return "."; if (!ref) return "-"; const r = sp/ref; return r>=.75?"0":r>=.5?"1":"2"; }
const lisToday = day => day === LIDX.days[LIDX.days.length-1];
const lhistCache = new Map();
function loadLBucket(day, b){
  const v = lisToday(day) ? STATE?.loopsTime : "final", key = `${day}/${b}@${v}`;
  if (!lhistCache.has(key)) lhistCache.set(key, getDayJSON(`lhist/${day}/${String(b).padStart(2,"0")}.json`, day, "lhist", v, LIDX.pagesDays).catch(()=>({times:[],sites:{}})));
  return lhistCache.get(key);
}
/** Lusreeksen: {id: [[t, snelheid, intensiteit], ...]} */
async function loopSeries(ids, from, to){
  const days = LIDX.days.filter(d => { const a = Date.parse(d+"T00:00:00Z")/1000; return a+86400 > from && a <= to; });
  const out = Object.fromEntries(ids.map(id=>[id,[]]));
  const bs = [...new Set(ids.map(bucketOf))];
  const files = await Promise.all(days.flatMap(d => bs.map(b => loadLBucket(d,b))));
  for (const f of files) for (const id of ids){
    const arr = f.sites[id]; if (!arr) continue;
    for (let i=0;i<arr.length;i++){ const t=f.times[i], v=arr[i]; if (v && t>=from && t<=to) out[id].push([t, v[0], v[1]]); }
  }
  for (const id of ids) out[id].sort((a,b)=>a[0]-b[0]);
  return out;
}
const ltlCache = new Map();
function loadLTL(day){ const v = lisToday(day) ? STATE?.loopsTime : "final", key = `${day}@${v}`; if (!ltlCache.has(key)) ltlCache.set(key, getDayJSON(`ltl/${day}.json`, day, "lhist", v, LIDX.pagesDays).catch(()=>null)); return ltlCache.get(key); }
async function computeLoopCls(){
  LCLS = {};
  if (TIME==null){ for (const id in LOOPS) LCLS[id] = loopClass(LOOP_NOW[id]?.s, LOOP_REF[id]); return; }
  const tl = await loadLTL(dayUTC(TIME)); if (!tl) return;
  let i = -1; for (let k=0;k<tl.times.length;k++){ if (tl.times[k] <= TIME) i = k; else break; }
  if (i<0 || TIME - tl.times[i] > 900) return;
  tl.sites.forEach((id,k)=>{ LCLS[id] = tl.rows[i][k]; });
}
function drawLoops(){
  const show = ui.layers.loops && map.getZoom() >= LOOP_ZOOM;
  if (!show){ loopGroup.clearLayers(); for (const k in loopMarkers) delete loopMarkers[k]; return; }
  for (const id in LOOPS){
    const s = LOOPS[id], c = LCLS[id] ?? ".";
    let m = loopMarkers[id];
    if (!m){
      m = loopMarkers[id] = L.circleMarker([s.lat,s.lon],{renderer:loopRenderer,radius:4.5,weight:1.5,color:"#fff",fillOpacity:1});
      m.on("click", e => L.popup().setLatLng(e.latlng).setContent("<div class='pop'>laden…</div>").openOn(map) && loopPopup(id).then(h=>map._popup?.setContent(h)));
      m.bindTooltip(()=>esc(loopName(id)), {sticky:true});
      m.addTo(loopGroup);
    }
    m.setStyle({fillColor: flowColor(c), radius: c==="."||c==="-" ? 3 : 4.5});
  }
}
function loopName(id){ const s = LOOPS[id]; if (!s) return id; const side = SIDE_NL[s.side]; return `${s.name}${side?` · richting ${side}`:""}`; }
async function loopPopup(id){
  const s = LOOPS[id]; let v = LOOP_NOW[id], hist = "";
  if (TIME!=null){
    const r = await loopSeries([id], TIME-900, TIME+60); const p = r[id].filter(x=>x[0]<=TIME).pop();
    v = p ? {s:p[1], f:p[2]} : null; hist = `<span class="hist">${esc(timeLabel(TIME))}</span>`;
  }
  const lanes = v?.l ? `<table class="data"><tr><th>Rijstrook</th><th>vtg/u</th><th>km/u</th></tr>${v.l.map(r=>`<tr><td>${esc(r[0]==="9"?"vluchtstrook":r[0])}</td><td class="num">${r[1]??"–"}</td><td class="num">${r[2]??"–"}</td></tr>`).join("")}</table>` : "";
  const cls = v?.c ? `<div class="m" style="margin-top:6px">Licht ${v.c.L??0} · middelzwaar ${v.c.M??0} · zwaar ${v.c.Z??0} vtg/u</div>` : "";
  const inProj = items().some(i=>i.kind==="lus" && i.ids.includes(id));
  return `<div class="pop">${hist}<h4>${esc(loopName(id))}</h4>
    <div class="m num">${v?.s!=null?v.s+" km/u":"geen snelheid"} · ${v?.f!=null?v.f+" vtg/u":"geen intensiteit"}${LOOP_REF[id]?` · vrij ±${Math.round(LOOP_REF[id])} km/u`:""}</div>
    ${lanes}${cls}<div class="m" style="font-size:11px">${esc(id)} · ${s.lanes||"?"} rijstroken</div>
    <div class="acts">${inProj?`<span class="muted">staat in je project</span>`:`<button class="primary sm" onclick="addLoop('${id}')">› Toevoegen aan project</button>`}</div></div>`;
}
window.addLoop = id => { items().push({key:uid(), kind:"lus", label:loopName(id), color:nextColor(), on:true, ids:[id]}); map.closePopup(); changed(); toast("Meetpunt toegevoegd aan je project. Maak er een grafiek van met het grafiek-icoon."); };
async function loadLoops(){
  try{
    if (!Object.keys(LOOPS).length || (STATE?.loopsTime && !loadLoops._meta)){ const j = await getJSON("data/loops/sites.json", STATE?.loopsTime); LOOPS = j.sites||{}; loadLoops._meta = true; }
    const n = await getJSON("data/loops/now.json", STATE?.loopsTime); LOOP_NOW = n.now||{}; LOOP_REF = n.ref||{};
    try{ LIDX = withArch(await getJSON("data/lhist/index.json", STATE?.loopsTime), "lhist"); }catch(e){}
  }catch(e){ LOOPS = {}; }
  $("#cnt-loops").textContent = Object.keys(LOOPS).length || "";
  if (ui.listKind==="lus") renderList();
  if (TIME==null){ await computeLoopCls(); drawLoops(); }
}

// ================================================================ SITUATIES (actueel) + PLANNING
const SIT_CATS = {
  file:     {label:"Files",               color:"#d6372c", glyph:"≡"},
  dicht:    {label:"Afsluitingen",        color:"#5b1a7a", glyph:"⛔"},
  strook:   {label:"Rijstrookmaatregelen",color:"#eb6834", glyph:"⇢"},
  snelheid: {label:"Snelheidsmaatregelen",color:"#2a78d6", glyph:"⊘"},
  omleiding:{label:"Omleidingen",         color:"#6b7470", glyph:"↪"},
  incident: {label:"Ongevallen en pech",  color:"#c62828", glyph:"!"},
  brug:     {label:"Brugopeningen",       color:"#0891b2", glyph:"⌒"},
  werk:     {label:"Werkzaamheden",       color:"#ca8a04", glyph:"⚒"},
  evenement:{label:"Evenementen",         color:"#9333ea", glyph:"★"},
};
const SUB_NL = {carriagewayClosures:"rijbaan dicht",roadClosed:"weg dicht",laneClosures:"rijstrook dicht",lanesDeviated:"rijstroken verlegd",hardShoulderRunningInOperation:"spitsstrook open",narrowLanes:"versmalde rijstroken",useOfSpecifiedLanesOrCarriagewaysAllowed:"gebruik andere rijbaan",useSpecifiedLanesOrCarriageways:"gebruik andere rijbaan",speedRestrictionInOperation:"snelheidsbeperking",followDiversionSigns:"volg omleiding",slowTraffic:"langzaam rijdend verkeer",stationaryTraffic:"stilstaand verkeer",queuingTraffic:"wachtrij",bridgeSwingInOperation:"brug open",accident:"ongeval",other:"overig"};
function recCat(r){
  switch (r.t){
    case "AbnormalTraffic": return "file";
    case "RoadOrCarriagewayOrLaneManagement": return ["carriagewayClosures","roadClosed"].includes(r.sub) ? "dicht" : "strook";
    case "SpeedManagement": return "snelheid";
    case "ReroutingManagement": return "omleiding";
    case "GeneralNetworkManagement": return r.sub==="bridgeSwingInOperation" ? "brug" : "strook";
    case "MaintenanceWorks": case "ConstructionWorks": return "werk";
    case "PublicEvent": return "evenement";
    default: return "incident";
  }
}
const sitCats = s => [...new Set(s.r.map(recCat))];
function sitTitle(s){
  const cm = s.r.flatMap(r=>r.cmt||[]);
  if (cm.length) return cm[0];
  const r = s.r.find(r=>recCat(r)!=="omleiding") || s.r[0], c = SIT_CATS[recCat(r)];
  return `${c.label.replace(/s$/,"")}${r.sub&&SUB_NL[r.sub]?`: ${SUB_NL[r.sub]}`:""}`;
}
function fmtDT(iso){ if (!iso) return "–"; const d = new Date(iso); const o={weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}; if (d.getFullYear()!==new Date().getFullYear()) o.year="numeric"; return d.toLocaleString("nl-NL",o); }
function sitDetails(s){
  const rows = s.r.map(r=>{
    const c = SIT_CATS[recCat(r)];
    const bits = [SUB_NL[r.sub]||r.sub, r.queue?`file ${(r.queue/1000).toFixed(1).replace(".",",")} km`:null, r.delay?`+${mmss(r.delay)} min`:null,
      r.speed?`max ${r.speed} km/u`:null, r.lr!=null&&r.ln?`${r.lr} van ${r.ln} rijstroken dicht`:null].filter(Boolean).join(" · ");
    return `<div class="m"><span class="tag k" style="--c:${c.color}">${esc(c.label)}</span> ${esc(bits)}</div>`;
  }).join("");
  const r0 = s.r[0], cm = [...new Set(s.r.flatMap(r=>r.cmt||[]))];
  return `${rows}${cm.slice(1).map(t=>`<p style="margin:4px 0">${esc(t)}</p>`).join("")}
    <div class="m">${fmtDT(r0.st)} → ${r0.en?fmtDT(r0.en):"onbepaald"}${r0.per?.length>1?` · ${r0.per.length} perioden`:""}</div>
    <div class="m" style="font-size:11px">${esc(r0.src||"")}${r0.hind?` · hinderklasse ${esc(r0.hind.replace("hindranceClass",""))}`:""} · ${esc(s.id)}</div>`;
}
let SIT_LIVE = [], PLAN = [];
const sitGroup = L.layerGroup().addTo(map), planGroup = L.layerGroup().addTo(map);
const sitRenderer = L.svg({pane:"mine"});
function drawSitList(list, group, isPlan){
  group.clearLayers();
  const cats = new Set(ui.sitCats);
  for (const s of list){
    for (const r of s.r){
      const cat = recCat(r); if (!isPlan && !cats.has(cat)) continue;
      if (isPlan && cat==="omleiding") continue;
      const c = SIT_CATS[cat];
      const pop = () => `<div class="pop">${TIME!=null&&!isPlan?`<span class="hist">${esc(timeLabel(TIME))}</span>`:""}<h4>${esc(sitTitle(s))}</h4>${sitDetails(s)}</div>`;
      const dash = {dicht:"10 6", strook:"4 6", snelheid:"2 6", omleiding:"8 8", werk:"12 6", evenement:"3 5"}[cat] || null;
      for (const ln of r.lines||[]){
        if (cat==="file") L.polyline(ln,{renderer:sitRenderer,color:"#fff",weight:12,opacity:.9,interactive:false}).addTo(group);
        L.polyline(ln,{renderer:sitRenderer,color:c.color,weight:cat==="file"?8:cat==="omleiding"?3:6,opacity:cat==="omleiding"?.6:.9,dashArray:dash,lineCap:"butt"}).bindPopup(pop,{maxWidth:340}).addTo(group);
      }
      if (cat==="file" && r.lines?.length && r.queue){
        const ln = r.lines[0], mid = ln[Math.floor(ln.length/2)];
        L.marker(mid,{pane:"drip",interactive:false,icon:L.divIcon({className:"",html:`<span class="sit-lbl">${(r.queue/1000).toFixed(1).replace(".",",")} km${r.delay?` · +${Math.round(r.delay/60)}′`:""}</span>`,iconSize:null,iconAnchor:[0,-6]})}).addTo(group);
      }
      const pts = r.pts?.length ? r.pts : (r.lines?.length ? [] : []);
      for (const p of pts){
        L.marker([p[0],p[1]],{pane:"drip",icon:L.divIcon({className:"",html:`<div class="sit-ic" style="background:${c.color}">${c.glyph}</div>`,iconSize:[24,24]})}).bindPopup(pop,{maxWidth:340}).addTo(group);
      }
      if (!pts.length && r.lines?.length && cat!=="omleiding" && cat!=="file"){
        const ln = r.lines[0];
        L.marker(ln[0],{pane:"drip",icon:L.divIcon({className:"",html:`<div class="sit-ic" style="background:${c.color};width:20px;height:20px;font-size:11px">${c.glyph}</div>`,iconSize:[20,20]})}).bindPopup(pop,{maxWidth:340}).addTo(group);
      }
    }
  }
}
let sitReq = 0;
async function drawSits(){
  const my = ++sitReq;
  if (!ui.layers.sit){ sitGroup.clearLayers(); return; }
  let list = SIT_LIVE;
  if (TIME!=null){ try{ list = Object.values((await stateAt("sit", TIME)).state); }catch(e){ list = []; } }
  if (my!==sitReq) return;
  drawSitList(list, sitGroup, false);
  $("#cnt-sit").textContent = list.length || "";
}
function renderSitCats(){
  $("#sit-cats").innerHTML = ["file","dicht","strook","snelheid","omleiding","incident","brug"].map(k=>`<span class="chip ${ui.sitCats.includes(k)?"on":""}" data-c="${k}">${esc(SIT_CATS[k].label)}</span>`).join("");
}
$("#sit-cats").addEventListener("click", e=>{ const c = e.target.closest(".chip"); if (!c) return; const k=c.dataset.c, i=ui.sitCats.indexOf(k); if (i>=0) ui.sitCats.splice(i,1); else ui.sitCats.push(k); saveUI(); renderSitCats(); drawSits(); });
function planActive(s, from, to){
  return s.r.some(r=>{
    const per = r.per?.length ? r.per : [[r.st, r.en]];
    return per.some(([a,b])=>{ const A = a?Date.parse(a)/1000:-Infinity, B = b?Date.parse(b)/1000:Infinity; return A <= to && B >= from; });
  });
}
function planFiltered(){
  const now = TIME ?? nowS(), w = ui.planWhen || "at";
  if (w==="all") return PLAN;
  if (w==="at") return PLAN.filter(s=>planActive(s, now, now));
  return PLAN.filter(s=>planActive(s, now, now + (+w)*86400));
}
function drawPlan(){
  if (!ui.layers.plan){ planGroup.clearLayers(); return; }
  const list = planFiltered();
  drawSitList(list, planGroup, true);
  $("#cnt-plan").textContent = `${list.length}`;
}
async function loadSits(){ try{ SIT_LIVE = (await getJSON("data/sit.json", STATE?.sitTime)).sits||[]; }catch(e){ SIT_LIVE=[]; } if (TIME==null) drawSits(); renderMeld(); }
async function loadPlan(){ try{ PLAN = (await getJSON("data/planning.json", STATE?.planningTime)).items||[]; }catch(e){ PLAN=[]; } drawPlan(); renderMeld(); }

// ================================================================ OV
let OVNET = null, OVVEH = [], OVALERTS = [];
const ovNetGroup = L.layerGroup().addTo(map), ovVehGroup = L.layerGroup().addTo(map);
const ovRenderer = L.canvas({pane:"flow", padding:.3, tolerance:4});
const OV_KIND_COL = {metro:"#e30613", tram:"#2a78d6", bus:"#6b7470", trein:"#ffc400", veer:"#0891b2"};
const OV_KINDS = ["metro","tram","bus","trein","veer"];
function routeColor(r){ return (r?.c && r.c!=="#FFFFFF" && r.c!=="#ffffff") ? r.c : OV_KIND_COL[r?.k] || "#6b7470"; }
function drawOvNet(){
  ovNetGroup.clearLayers();
  if (!ui.layers.ovnet || !OVNET) return;
  const kinds = new Set(ui.ovKinds);
  for (const [rid, r] of Object.entries(OVNET.routes)){
    if (!kinds.has(r.k)) continue;
    for (const sh of r.shapes){
      L.polyline(sh,{renderer:ovRenderer,color:routeColor(r),weight:r.k==="bus"?2:3.5,opacity:r.k==="bus"?.55:.85})
        .bindTooltip(`${esc(r.k)} ${esc(r.n)} · ${esc(r.l)}`,{sticky:true}).addTo(ovNetGroup);
    }
  }
  if (map.getZoom() >= 15){
    const alertStops = new Set(OVALERTS.flatMap(a=>a.stops));
    for (const s of OVNET.stops){
      const lines = s.r.map(id=>OVNET.routes[id]).filter(r=>r && kinds.has(r.k));
      if (!lines.length) continue;
      const warn = alertStops.has(s.id);
      L.circleMarker([s.lat,s.lon],{renderer:ovRenderer,radius:warn?6:4,color:warn?"#d6372c":"#042D23",weight:warn?3:1.5,fillColor:"#fff",fillOpacity:1})
        .bindPopup(()=>`<div class="pop"><h4>${esc(s.n)}</h4><div style="display:flex;flex-wrap:wrap;gap:3px;margin:6px 0">${lines.map(r=>`<span class="ov-badge" style="background:${routeColor(r)}" title="${esc(r.l)}">${esc(r.n)}</span>`).join("")}</div>
          ${OVALERTS.filter(a=>a.stops.includes(s.id)).map(a=>`<p style="margin:4px 0;color:var(--bad)">⚠ ${esc(a.head||a.desc||"")}</p>`).join("")}<div class="m" style="font-size:11px">halte ${esc(s.code||s.id)}</div></div>`)
        .addTo(ovNetGroup);
    }
  }
  $("#cnt-ovnet").textContent = Object.values(OVNET.routes).filter(r=>kinds.has(r.k)).length || "";
}
function delayCol(d){ if (d==null) return "#6b7470"; if (d < -60) return "#2a78d6"; if (d <= 60) return cssVar("--ok"); if (d <= 180) return cssVar("--warn"); return cssVar("--bad"); }
let ovReq = 0;
async function drawOvVeh(){
  const my = ++ovReq;
  if (!ui.layers.ovveh){ ovVehGroup.clearLayers(); return; }
  let rows = OVVEH;
  if (TIME!=null){
    try{ const f = await getJSON(`data/ovh/${dayUTC(TIME)}.json`, isToday(dayUTC(TIME))?undefined:"final"); const st = f.steps.filter(s=>s[0]<=TIME).pop(); rows = st && TIME-st[0] <= 900 ? st[1].map(v=>[v[0],v[1],v[2],v[3]]) : []; }
    catch(e){ rows = []; }
  }
  if (my!==ovReq) return;
  ovVehGroup.clearLayers();
  if (map.getZoom() < 12){ $("#cnt-ovveh").textContent = rows.length || ""; return; }
  const kinds = new Set(ui.ovKinds);
  for (const v of rows){
    const r = OVNET?.routes?.[v[0]]; if (r && !kinds.has(r.k)) continue;
    L.marker([v[1],v[2]],{pane:"drip",icon:L.divIcon({className:"",html:`<div class="ov-veh" style="background:${delayCol(v[3])}">${esc(r?.n||"?")}</div>`,iconSize:null,iconAnchor:[11,8]})})
      .bindPopup(()=>`<div class="pop">${TIME!=null?`<span class="hist">${esc(timeLabel(TIME))}</span>`:""}<h4><span class="ov-badge" style="background:${routeColor(r)}">${esc(r?.n||"?")}</span> ${esc(v[4]||r?.l||"")}</h4>
        <div class="m">${esc(r?.k||"")} · ${esc(r?.a||"")}</div>
        <div class="m"><b style="color:${delayCol(v[3])}">${v[3]==null?"vertraging onbekend":v[3]<-30?`${mmss(-v[3])} min te vroeg`:v[3]<=30?"op tijd":`${mmss(v[3])} min vertraging`}</b></div>
        ${v[5]?`<div class="m" style="font-size:11px">voertuig ${esc(v[5])}${v[7]?` · positie ${hhmm(new Date(v[7]*1000))}`:""}</div>`:""}</div>`)
      .addTo(ovVehGroup);
  }
  $("#cnt-ovveh").textContent = rows.length || "";
}
function renderOvKinds(){
  const present = new Set(Object.values(OVNET?.routes||{}).map(r=>r.k));
  $("#ov-kinds").innerHTML = OV_KINDS.filter(k=>present.has(k)).map(k=>`<span class="chip ${ui.ovKinds.includes(k)?"on":""}" data-k="${k}">${k}</span>`).join("");
}
$("#ov-kinds").addEventListener("click", e=>{ const c = e.target.closest(".chip"); if (!c) return; const k=c.dataset.k, i=ui.ovKinds.indexOf(k); if (i>=0) ui.ovKinds.splice(i,1); else ui.ovKinds.push(k); saveUI(); renderOvKinds(); drawOvNet(); drawOvVeh(); });
async function loadOvNet(){ try{ OVNET = await getJSON("data/ov/net.json", "d"+Math.floor(nowS()/21600)); }catch(e){ OVNET = null; } renderOvKinds(); drawOvNet(); }
async function loadOvVeh(){
  try{ OVVEH = (await getJSON("data/ov/veh.json", STATE?.ovTime)).v||[]; }catch(e){ OVVEH=[]; }
  try{ OVALERTS = (await getJSON("data/ov/alerts.json", STATE?.ovTime)).alerts||[]; }catch(e){ OVALERTS=[]; }
  if (TIME==null) drawOvVeh();
  renderMeld();
}

// ================================================================ MELDINGEN (lijsten)
function meldMatches(txt){ const q = ($("#meld-q").value||"").trim().toLowerCase(); return !q || txt.toLowerCase().includes(q); }
let meldKind = "actueel", meldPlanWin = "30";
function zoomToSit(s){
  const pts = s.r.flatMap(r=>[...(r.lines||[]).flat(), ...(r.pts||[]).map(p=>[p[0],p[1]])]);
  if (!pts.length) return;
  showView("kaart");
  setTimeout(()=>{ map.fitBounds(L.latLngBounds(pts).pad(.3)); },50);
}
window.meldZoom = (kind, id) => {
  const s = (kind==="plan" ? PLAN : SIT_LIVE).find(x=>x.id===id); if (!s) return;
  if (kind==="plan" && !ui.layers.plan){ ui.layers.plan = true; $("#ly-plan").checked = true; $("#plan-box").hidden=false; saveUI(); }
  if (kind==="plan"){ ui.planWhen = "all"; $("#plan-when").value = "all"; drawPlan(); }
  if (kind==="sit" && !ui.layers.sit){ ui.layers.sit = true; $("#ly-sit").checked = true; $("#sit-box").hidden=false; saveUI(); drawSits(); }
  zoomToSit(s);
};
function sitItemHtml(s, kind){
  const cats = sitCats(s).filter(c=>c!=="omleiding" || sitCats(s).length===1), c = SIT_CATS[cats[0]||"werk"], r0 = s.r[0];
  const cm = [...new Set(s.r.flatMap(r=>r.cmt||[]))];
  return `<div class="mitem" style="--c:${c.color}">
    <div class="when"><b>${esc(fmtDT(r0.st))}</b>${r0.en?`t/m ${esc(fmtDT(r0.en))}`:"tot nader bericht"}</div>
    <div><h3>${esc(sitTitle(s))}</h3>${cm.slice(1,3).map(t=>`<p>${esc(t)}</p>`).join("")}
      <div class="tags">${sitCats(s).map(k=>`<span class="tag k" style="--c:${SIT_CATS[k].color}">${esc(SIT_CATS[k].label)}</span>`).join("")}
      ${s.r.map(r=>r.speed?`<span class="tag">max ${r.speed} km/u</span>`:r.queue?`<span class="tag">${(r.queue/1000).toFixed(1).replace(".",",")} km</span>`:"").join("")}</div>
      <div class="meta">${esc(r0.src||"")}${r0.hind?` · hinderklasse ${esc(r0.hind.replace("hindranceClass",""))}`:""}</div></div>
    <button class="ghost sm" onclick="meldZoom('${kind}','${esc(s.id)}')">Op kaart</button></div>`;
}
function renderMeld(){
  const nAct = SIT_LIVE.length, nOv = OVALERTS.length;
  const now = nowS(), planSoon = PLAN.filter(s=>planActive(s, now, now+30*86400));
  $("#meld-n-act").textContent = nAct||""; $("#meld-n-plan").textContent = planSoon.length||""; $("#meld-n-ov").textContent = nOv||"";
  const nFile = SIT_LIVE.filter(s=>sitCats(s).includes("file")||sitCats(s).includes("incident")).length;
  $("#tab-meld-n").textContent = nFile || "";
  $("#tab-meld-n").title = `${nFile} files/incidenten nu`;
  if ($('.view[data-view="meldingen"]').hidden) return;
  const box = $("#meld-list"), filt = $("#meld-filters");
  if (meldKind==="actueel"){
    filt.innerHTML = "";
    const order = ["file","incident","brug","dicht","strook","snelheid","omleiding"];
    const list = SIT_LIVE.filter(s=>meldMatches(sitTitle(s)+" "+s.r.flatMap(r=>r.cmt||[]).join(" ")+" "+(s.r[0].src||"")))
      .sort((a,b)=>order.indexOf(sitCats(a)[0]) - order.indexOf(sitCats(b)[0]) || (b.r[0].st||"").localeCompare(a.r[0].st||""));
    box.innerHTML = list.map(s=>sitItemHtml(s,"sit")).join("") || `<div class="mempty">Geen actuele situaties gevonden.</div>`;
  } else if (meldKind==="planning"){
    filt.innerHTML = [["7","komende 7 dagen"],["30","komende 30 dagen"],["90","komende 90 dagen"],["all","alles"]].map(([v,l])=>`<span class="chip ${meldPlanWin===v?"on":""}" data-w="${v}">${l}</span>`).join("");
    const to = meldPlanWin==="all" ? Infinity : now + (+meldPlanWin)*86400;
    const list = PLAN.filter(s=>meldPlanWin==="all" || planActive(s, now, to))
      .filter(s=>meldMatches(sitTitle(s)+" "+s.r.flatMap(r=>r.cmt||[]).join(" ")+" "+(s.r[0].src||"")))
      .sort((a,b)=>(a.r[0].st||"").localeCompare(b.r[0].st||""));
    box.innerHTML = list.slice(0,400).map(s=>sitItemHtml(s,"plan")).join("") || `<div class="mempty">Geen geplande werkzaamheden of evenementen in deze periode.</div>`;
  } else {
    filt.innerHTML = "";
    const list = OVALERTS.filter(a=>meldMatches((a.head||"")+" "+(a.desc||"")+" "+a.routes.map(r=>OVNET?.routes?.[r]?.n||"").join(" ")))
      .sort((x,y)=>(y.per?.[0]?.[0]||0)-(x.per?.[0]?.[0]||0));
    box.innerHTML = list.map(a=>{
      const stopRoutes = OVNET ? OVNET.stops.filter(s=>a.stops.includes(s.id)).flatMap(s=>s.r) : [];
      const lines = [...new Set([...a.routes, ...stopRoutes])].map(r=>OVNET?.routes?.[r]).filter(Boolean).sort((x,y)=>String(x.n).localeCompare(String(y.n),"nl",{numeric:true}));
      const per = a.per?.[0]; const st = per?.[0] ? new Date(per[0]*1000).toISOString() : null, en = per?.[1] ? new Date(per[1]*1000).toISOString() : null;
      return `<div class="mitem" style="--c:#d6372c"><div class="when"><b>${esc(fmtDT(st))}</b>${en?`t/m ${esc(fmtDT(en))}`:""}</div>
        <div><h3>${esc(a.head||"Storing")}</h3>${a.desc&&a.desc!==a.head?`<p style="white-space:pre-line">${esc(a.desc)}</p>`:""}
        <div class="tags">${lines.map(r=>`<span class="ov-badge" style="background:${routeColor(r)}">${esc(r.n)}</span>`).join(" ")}${a.effect?`<span class="tag">${esc(a.effect)}</span>`:""}${a.cause?`<span class="tag">${esc(a.cause)}</span>`:""}</div>
        <div class="meta">${a.stops.length} halte${a.stops.length===1?"":"s"} in het gebied</div></div><span></span></div>`;
    }).join("") || `<div class="mempty">Geen OV-storingen in het gebied.</div>`;
  }
}
document.querySelectorAll('input[name=meld]').forEach(r=>r.onchange=()=>{ meldKind = r.value; renderMeld(); });
$("#meld-q").oninput = renderMeld;
$("#meld-filters").addEventListener("click", e=>{ const c = e.target.closest(".chip"); if (!c) return; meldPlanWin = c.dataset.w; renderMeld(); });

// ================================================================ tijdbalk
function timeLabel(t){ const d = new Date(t*1000); return `${dmy(d)} ${hhmm(d)}`; }
function rangeBounds(){
  const first = IDX.days[0] ? Date.parse(IDX.days[0]+"T00:00:00Z")/1000 : nowS()-86400;
  const last = Math.max(STATE?.generated || nowS(), first+3600);
  return [Math.floor(first/STEP)*STEP, Math.ceil(last/STEP)*STEP];
}
function renderTimebar(){
  const [a,b] = rangeBounds(), r = $("#tb-range");
  r.min = a; r.max = b; r.value = TIME ?? b;
  const marks = []; const d = new Date(a*1000); d.setHours(24,0,0,0);
  for (let t = d.getTime()/1000; t < b; t += 86400){ marks.push(t); }
  const step = Math.ceil(marks.length/10);
  $("#tb-days").innerHTML = marks.filter((_,i)=>i%step===0).map(t=>`<span style="left:${((t-a)/(b-a)*100).toFixed(2)}%">${new Date(t*1000).toLocaleDateString("nl-NL",{weekday:"short",day:"numeric"})}</span>`).join("");
  const shown = TIME ?? (STATE?.publicationTime ? Date.parse(STATE.publicationTime)/1000 : b);
  $("#tb-time").textContent = hhmm(new Date(shown*1000));
  $("#tb-date").textContent = TIME==null ? "live · " + dmy(new Date(shown*1000)) : dmy(new Date(shown*1000));
  $("#tb-live").classList.toggle("on", TIME==null);
  $("#timechip").hidden = TIME==null;
  if (TIME!=null) $("#timechip-t").textContent = timeLabel(TIME);
}
let timeT = null;
function setTime(t, immediate){
  const [a,b] = rangeBounds();
  if (t!=null){ t = Math.max(a, Math.min(b, Math.round(t/STEP)*STEP)); if (t >= b - STEP/2) t = null; }
  TIME = t; renderTimebar();
  clearTimeout(timeT);
  timeT = setTimeout(applyTime, immediate ? 0 : 140);
}
async function applyTime(){
  await computeCls();
  styleFlow(); renderList();
  await refreshAt();
  renderSelected(); drawMsi(); drawDrips(); drawCharts();
  await computeLoopCls(); drawLoops(); drawSits(); drawPlan(); drawOvVeh();
}
async function computeCls(){
  if (TIME==null){ CLS = {}; for (const id in SITES) CLS[id] = classify(DATA[id]?.d ?? null, refOf(id)); return; }
  const tl = await loadTL(dayUTC(TIME));
  CLS = {};
  if (!tl) return;
  let i = -1; for (let k=0;k<tl.times.length;k++){ if (tl.times[k] <= TIME) i = k; else break; }
  if (i<0 || TIME - tl.times[i] > 900) return;
  const row = tl.rows[i];
  tl.sites.forEach((id,k)=>{ CLS[id] = row[k]; });
}
/** Waarden voor projectsegmenten op het getoonde moment + sparkline-data. */
async function refreshAt(){
  const end = TIME ?? (STATE?.publicationTime ? Date.parse(STATE.publicationTime)/1000 : nowS());
  const lids = [...new Set(items().filter(isLus).flatMap(i=>i.ids))];
  const lser = lids.length ? await loopSeries(lids, end - 6*3600, (TIME ?? nowS()) + 60) : {};
  AT_L = {};
  for (const id of lids){ const last = lser[id].filter(p=>p[0] <= (TIME ?? Infinity)).pop(); if (last && (TIME ?? nowS()) - last[0] <= 900) AT_L[id] = [last[1], last[2]]; }
  const ids = [...new Set(items().filter(i=>!isLus(i)).flatMap(i=>i.ids))].filter(id=>SITES[id]);
  SPARK = {};
  for (const it of items().filter(isLus)){
    const byT = new Map(); for (const id of it.ids) for (const [t,,f] of lser[id]||[]) if (f!=null) byT.set(t, (byT.get(t)||0)+f);
    SPARK[it.key] = [...byT.entries()].sort((a,b)=>a[0]-b[0]);
  }
  if (!ids.length){ AT = {}; return; }
  const s = await series(ids, end - 6*3600, end + 60);
  AT = {};
  for (const id of ids){ const arr = s[id]; const last = arr[arr.length-1]; if (last && end - last[0] <= 900) AT[id] = last[1]; }
  for (const it of items().filter(i=>!isLus(i))) SPARK[it.key] = sumSeries(s, it.ids);
}
$("#tb-range").addEventListener("input", e=> setTime(+e.target.value));
$("#tb-live").onclick = ()=> setTime(null, true);
$("#timechip-live").onclick = ()=> setTime(null, true);
$("#tb-back").onclick = ()=> setTime((TIME ?? rangeBounds()[1]) - STEP, true);
$("#tb-fwd").onclick = ()=> TIME!=null && setTime(TIME + STEP, true);
$("#tb-back60").onclick = ()=> setTime((TIME ?? rangeBounds()[1]) - 3600, true);
let playT = null;
$("#tb-play").onclick = ()=>{
  if (playT){ clearInterval(playT); playT=null; $("#tb-play").textContent="▶"; return; }
  if (TIME==null) setTime(rangeBounds()[1] - 3*3600, true);
  $("#tb-play").textContent = "❚❚";
  playT = setInterval(()=>{ if (TIME==null){ clearInterval(playT); playT=null; $("#tb-play").textContent="▶"; return; } setTime(TIME + STEP, true); }, 700);
};

// ================================================================ grafieken
const chartData = new Map();   // chart.id -> berekende reeksen
function periodRange(c){
  const end = Math.ceil(nowS()/STEP)*STEP;
  const rel = {"6h":6*3600,"24h":86400,"3d":3*86400,"7d":7*86400,"14d":14*86400,"30d":30*86400,"90d":90*86400}[c.period];
  if (rel) return [end - rel, end];
  const a = c.from ? new Date(c.from+"T00:00").getTime()/1000 : end-86400;
  const b = c.to ? new Date(c.to+"T00:00").getTime()/1000 + 86400 : end;
  return [a, Math.max(a+STEP, b)];
}
function metricValue(metric, s, ref, len){
  if (metric==="reistijd") return s/60;
  if (metric==="vertraging") return ref!=null ? (s-ref)/60 : null;
  if (metric==="snelheid") return len ? len/s*3.6 : null;
  if (metric==="index") return ref ? s/ref : null;
}
async function computeChart(c){
  const lusMetric = c.metric==="intensiteit" || c.metric==="snelheid";
  const its = c.items.map(findItem).filter(Boolean).filter(it => isLus(it) ? lusMetric : c.metric!=="intensiteit");
  const lusIts = its.filter(isLus), trIts = its.filter(i=>!isLus(i));
  const ids = [...new Set(trIts.flatMap(i=>i.ids))].filter(id=>SITES[id]);
  if (!its.length) return {series:[], empty: c.metric==="intensiteit" ? "Intensiteit is alleen beschikbaar voor meetpunten (lusdetectie). Voeg een meetpunt toe via de kaartlaag Lusdetectie." : "Kies minstens één traject of meetpunt."};
  const dagen = c.type==="dagen";
  const wd = new Set((dagen ? [0,1,2,3,4,5,6] : (c.weekdays ?? [0,1,2,3,4,5,6])).map(Number));
  const agg = (+c.agg||15)*60;
  function binIt(raw, it, dash, suffix, base){
    const bins = new Map();
    for (const [t,v] of raw){
      let k;
      if (base!=null) k = Math.floor((t-base)/agg)*agg;
      else if (c.type==="profiel"){ const d = new Date(t*1000); k = Math.floor((d.getHours()*3600 + d.getMinutes()*60)/agg)*agg; }
      else k = Math.floor(t/agg)*agg;
      const e = bins.get(k) || [0,0]; e[0]+=v; e[1]++; bins.set(k,e);
    }
    const pts = [...bins.entries()].sort((a,b)=>a[0]-b[0]).map(([k,[s,n]])=>[c.type==="profiel" || base!=null ? k : k + agg/2, s/n]);
    return {key:it.key, label:it.label + (suffix||""), color:it.color, dash, pts};
  }
  async function build(from, to, dash, suffix, base){
    const lids = [...new Set(lusIts.flatMap(i=>i.ids))];
    const lser = lids.length ? await loopSeries(lids, from, to) : {};
    const lusOut = lusIts.map(it=>{
      const byT = new Map();
      for (const id of it.ids) for (const [t,sp,f] of lser[id]||[]){ const e = byT.get(t)||[0,0,0]; if (f!=null){ e[0]+=f; if (sp!=null){ e[1]+=sp*f; e[2]+=f; } } byT.set(t,e); }
      const raw = [...byT.entries()].filter(([t])=>wd.has(new Date(t*1000).getDay()))
        .map(([t,e])=>[t, c.metric==="intensiteit" ? e[0] : (e[2]>0 ? e[1]/e[2] : null)]).filter(p=>p[1]!=null);
      return binIt(raw, it, dash, suffix, base);
    });
    if (!trIts.length) return lusOut;
    const segs = await series(ids, from, to);
    return lusOut.concat(trIts.map(it=>{
      const refs = it.ids.filter(id=>SITES[id]).map(refOf); const ref = refs.every(r=>r!=null) ? refs.reduce((a,b)=>a+b,0) : null;
      const len = it.ids.filter(id=>SITES[id]).reduce((a,id)=>a+(SITES[id].length||0),0);
      const raw = sumSeries(segs, it.ids).filter(([t])=>wd.has(new Date(t*1000).getDay()))
        .map(([t,s])=>[t, metricValue(c.metric, s, ref, len)]).filter(p=>p[1]!=null && isFinite(p[1]));
      return binIt(raw, it, dash, suffix, base);
    }));
  }
  if (dagen){
    const days = (c.days||[]).slice(0, 8);
    if (!days.length) return {series:[], empty:"Kies minstens één dag."};
    const DASH = [false, "6 4", "2 3", "10 3 2 3"];
    let out = [];
    for (const [di, day] of days.entries()){
      const d0 = new Date(day+"T00:00"), d1 = new Date(d0); d1.setDate(d1.getDate()+1);
      const a = d0.getTime()/1000, b = d1.getTime()/1000;
      const ser = await build(a, b, false, "", a);
      for (const sr of ser){
        const ii = its.findIndex(i=>i.key===sr.key);
        sr.color = PALETTE[di % PALETTE.length]; sr.dash = DASH[ii % DASH.length];
        sr.label = (its.length>1 ? sr.label+" · " : "") + dayLabel(day);
        sr.day = day;
      }
      out = out.concat(ser);
    }
    const withData = new Set(out.filter(s=>s.pts.length).map(s=>s.day));
    return {series: out.filter(s=>s.pts.length), range:[0,86400], agg, missing: days.filter(d=>!withData.has(d)), empty: "Geen metingen op deze dagen. Historie is er vanaf de eerste run van het dashboard; oudere dagen komen uit het archief."};
  }
  const [a,b] = periodRange(c);
  let out = await build(a, b, false, c.cmp && c.type==="profiel" ? " (A)" : "");
  if (c.type==="profiel" && c.cmp && c.cfrom && c.cto){
    const ca = new Date(c.cfrom+"T00:00").getTime()/1000, cb = new Date(c.cto+"T00:00").getTime()/1000 + 86400;
    out = out.concat(await build(ca, cb, true, " (B)"));
  }
  return {series: out.filter(s=>s.pts.length), range:[a,b], agg};
}
function dayLabel(day){ return new Date(day+"T12:00").toLocaleDateString("nl-NL",{weekday:"short",day:"numeric",month:"short"}); }
function describeChart(c){
  if (c.type==="dagen") return `${METRICS[c.metric].label} · dagen vergelijken: ${(c.days||[]).map(dayLabel).join(", ")} · per ${c.agg} min`;
  const p = {"6h":"laatste 6 uur","24h":"laatste 24 uur","3d":"laatste 3 dagen","7d":"laatste 7 dagen","14d":"laatste 14 dagen","30d":"laatste 30 dagen","90d":"laatste 90 dagen"}[c.period] || `${c.from||"?"} t/m ${c.to||"?"}`;
  const wdN = ["zo","ma","di","wo","do","vr","za"], wd = (c.weekdays ?? [0,1,2,3,4,5,6]);
  const wdTxt = wd.length===7 ? "alle dagen" : wd.length===5 && !wd.includes(0) && !wd.includes(6) ? "werkdagen" : wd.map(d=>wdN[d]).join(", ");
  return `${METRICS[c.metric].label} · ${c.type==="profiel"?"gemiddeld dagprofiel":"tijdlijn"} · ${p} · ${wdTxt} · per ${c.agg} min${c.cmp&&c.type==="profiel"?` · vergeleken met ${c.cfrom} t/m ${c.cto}`:""}`;
}
function renderCharts(){
  const box = $("#charts");
  $("#charts-proj").textContent = project().name;
  const list = charts();
  if (!list.length){
    box.innerHTML = `<div class="charts-empty"><h2>Nog geen grafieken in dit project</h2>
      <p>Maak een tijdlijn van een of meer trajecten of meetpunten, zet losse dagen naast elkaar (00–24 uur), of maak een gemiddeld dagprofiel om de spits vóór en tijdens de werkzaamheden te vergelijken.</p>
      <button class="primary" onclick="openChartDialog()">› Nieuwe grafiek</button></div>`;
    return;
  }
  box.innerHTML = list.map(c=>`<article class="ccard" data-id="${esc(c.id)}">
    <div class="ccard-h"><h3>${esc(c.title || "Grafiek")}</h3>
      <button class="icon" data-act="table" title="Tabel tonen">${I.table}</button>
      <button class="icon" data-act="csv" title="Download als CSV">${I.dl}</button>
      <button class="icon" data-act="dup" title="Dupliceren">${I.copy}</button>
      <button class="icon" data-act="edit" title="Bewerken">${I.edit}</button>
      <button class="icon" data-act="del" title="Verwijderen">${I.x}</button></div>
    <div class="ccard-sub">${esc(describeChart(c))}</div>
    <div class="plot"><div class="loading">Gegevens laden…</div></div>
    <div class="legend"></div><div class="tbl-wrap" hidden></div></article>`).join("");
  for (const c of list) computeChart(c).then(r=>{ chartData.set(c.id, r); drawChart(c); }).catch(()=>{ chartData.set(c.id,{series:[],empty:"Kon gegevens niet laden."}); drawChart(c); });
}
function drawCharts(){ if (!$('.view[data-view="grafieken"]').hidden) charts().forEach(drawChart); }
function niceStep(span){ const raw = span/5, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw/p; return (m<1.5?1:m<3.5?2:m<7.5?5:10)*p; }
function drawChart(c){
  const card = document.querySelector(`.ccard[data-id="${c.id}"]`); if (!card) return;
  const r = chartData.get(c.id); if (!r) return;
  const plot = card.querySelector(".plot"), leg = card.querySelector(".legend");
  if (!r.series.length){ plot.innerHTML = `<div class="nodata">${esc(r.empty || "Nog geen metingen in deze periode. De historie groeit elke 5–10 minuten.")}</div>`; leg.innerHTML=""; return; }
  const M = METRICS[c.metric], prof = c.type==="profiel" || c.type==="dagen";
  const W=640,H=260,P={l:52,r:14,t:18,b:28};
  const all = r.series.flatMap(s=>s.pts);
  const x0 = prof ? 0 : r.range[0], x1 = prof ? 86400 : r.range[1];
  let lo = Math.min(...all.map(p=>p[1])), hi = Math.max(...all.map(p=>p[1]));
  if (c.metric!=="index" && c.metric!=="vertraging") lo = Math.min(0, lo);
  if (c.metric==="index") lo = Math.min(1, lo);
  if (hi<=lo) hi = lo + 1;
  const st = niceStep(hi-lo); lo = Math.floor(lo/st)*st; hi = Math.ceil(hi/st)*st;
  const x = t => P.l + (t-x0)/(x1-x0)*(W-P.l-P.r), y = v => H-P.b-(v-lo)/(hi-lo)*(H-P.t-P.b);
  const yLab = v => c.metric==="index" ? v.toFixed(1).replace(".",",") : (c.metric==="snelheid"||c.metric==="intensiteit") ? Math.round(v).toLocaleString("nl-NL") : (v<0?"−":"")+mmss(Math.abs(v)*60).replace(/:00$/,"");
  let g = "";
  for (let v=lo; v<=hi+1e-9; v+=st) g += `<line x1="${P.l}" x2="${W-P.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${P.l-6}" y="${y(v)+3}" text-anchor="end">${esc(yLab(v))}</text>`;
  g += `<text x="0" y="6" text-anchor="start">${esc(M.unit)}</text>`;
  if (c.metric==="index") g += `<line x1="${P.l}" x2="${W-P.r}" y1="${y(1)}" y2="${y(1)}" stroke="var(--muted)" stroke-dasharray="2 3"/>`;
  if (prof){ for (let h=0; h<=24; h+=3) g += `<text x="${x(h*3600)}" y="${H-8}" text-anchor="middle">${String(h).padStart(2,"0")}:00</text>`; }
  else {
    const span = x1-x0, hs = [900,1800,3600,7200,10800,21600,43200,86400,172800].find(s=>span/s<=7) || 86400, tz = new Date().getTimezoneOffset()*60;
    for (let t=Math.ceil((x0-tz)/hs)*hs+tz; t<=x1; t+=hs){ const d=new Date(t*1000); g += `<text x="${x(t)}" y="${H-8}" text-anchor="middle">${hs>=86400 || (d.getHours()===0&&d.getMinutes()===0) ? d.toLocaleDateString("nl-NL",{day:"numeric",month:"short"}) : hhmm(d)}</text>`; }
  }
  const gap = (+c.agg||15)*60*2.5;
  const paths = r.series.map(s=>{
    let d = "", prev = null, dots = "";
    s.pts.forEach(([t,v], i)=>{
      const start = prev==null || t-prev>gap, next = s.pts[i+1], alone = start && (!next || next[0]-t>gap);
      d += `${start ? "M" : "L"}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      if (alone) dots += `<circle cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${s.color}" stroke="none"/>`;   // losse meting zichtbaar maken
      prev = t;
    });
    return `<path d="${d}" stroke="${s.color}" stroke-width="2" ${s.dash?`stroke-dasharray="${s.dash===true?"6 4":s.dash}"`:""}/>${dots}`;
  }).join("");
  let marker = "";
  if (!prof && TIME!=null && TIME>=x0 && TIME<=x1) marker = `<line x1="${x(TIME)}" x2="${x(TIME)}" y1="${P.t}" y2="${H-P.b}" stroke="var(--mg-green)" stroke-width="1.5"/><text x="${x(TIME)+4}" y="${P.t+8}" style="fill:var(--mg-green)">${hhmm(new Date(TIME*1000))}</text>`;
  plot.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title||"grafiek")}">${g}${paths}${marker}
    <line class="cx" y1="${P.t}" y2="${H-P.b}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/>
    <rect x="${P.l}" y="${P.t}" width="${W-P.l-P.r}" height="${H-P.t-P.b}" fill="transparent" stroke="none" style="cursor:${prof?"crosshair":"pointer"}"/></svg><div class="tip" hidden></div>`;
  leg.innerHTML = r.series.map(s=>`<span><i class="${s.dash==="2 3"?"dot":s.dash?"dash":""}" style="background:${s.color};--c:${s.color}"></i>${esc(s.label)}</span>`).join("") + (r.missing?.length ? `<span class="muted">· geen metingen op ${esc(r.missing.map(dayLabel).join(", "))}</span>` : "")
    + (prof?"":`<span class="muted">· klik in de grafiek om de kaart naar dat moment te zetten</span>`);
  const svg = plot.querySelector("svg"), tip = plot.querySelector(".tip"), cx = svg.querySelector(".cx");
  const xs = [...new Set(all.map(p=>p[0]))].sort((a,b)=>a-b);
  const nearest = px => { const t = x0 + (px-P.l)/(W-P.l-P.r)*(x1-x0); let best = xs[0]; for (const v of xs) if (Math.abs(v-t)<Math.abs(best-t)) best=v; return best; };
  svg.addEventListener("mousemove", e=>{
    const rc = svg.getBoundingClientRect(), px = (e.clientX-rc.left)/rc.width*W, t = nearest(px);
    cx.setAttribute("x1",x(t)); cx.setAttribute("x2",x(t)); cx.setAttribute("visibility","visible");
    const head = prof ? `${String(Math.floor(t/3600)).padStart(2,"0")}:${String(Math.floor(t%3600/60)).padStart(2,"0")}` : timeLabel(t);
    tip.hidden = false;
    tip.innerHTML = `<b class="num">${esc(head)}</b>` + r.series.map(s=>{ const p = s.pts.find(p=>p[0]===t); return p?`<div class="r"><span><i style="background:${s.color}"></i>${esc(s.label)}</span><span class="num">${esc(M.fmt(p[1]))}</span></div>`:""; }).join("");
    const left = Math.min(rc.width-tip.offsetWidth-4, Math.max(4, x(t)/W*rc.width+12));
    tip.style.left = left+"px"; tip.style.top = "6px";
  });
  svg.addEventListener("mouseleave", ()=>{ tip.hidden=true; cx.setAttribute("visibility","hidden"); });
  if (!prof) svg.addEventListener("click", e=>{
    const rc = svg.getBoundingClientRect(), t = nearest((e.clientX-rc.left)/rc.width*W);
    setTime(t, true); toast(`Kaart staat nu op ${timeLabel(t)}. Ga naar het tabblad Kaart om te kijken.`);
  });
  const tbl = card.querySelector(".tbl-wrap");
  if (!tbl.hidden) tbl.innerHTML = chartTable(c, r);
}
function chartRows(c, r){
  const xs = [...new Set(r.series.flatMap(s=>s.pts.map(p=>p[0])))].sort((a,b)=>a-b);
  const maps = r.series.map(s=>new Map(s.pts));
  const fmtX = t => c.type==="profiel" || c.type==="dagen" ? `${String(Math.floor(t/3600)).padStart(2,"0")}:${String(Math.floor(t%3600/60)).padStart(2,"0")}` : new Date(t*1000).toLocaleString("nl-NL");
  return {head:[c.type!=="tijd"?"tijd van de dag":"tijdstip", ...r.series.map(s=>`${s.label} (${METRICS[c.metric].unit})`)],
          rows: xs.map(t=>[fmtX(t), ...maps.map(m=>m.has(t) ? +m.get(t).toFixed(c.metric==="index"?3:2) : "")])};
}
function chartTable(c, r){
  const {head, rows} = chartRows(c, r);
  return `<table class="data"><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(rw=>`<tr>${rw.map(v=>`<td class="${typeof v==="number"?"num":""}">${typeof v==="number"?v.toLocaleString("nl-NL"):esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
$("#charts").addEventListener("click", e=>{
  const b = e.target.closest("[data-act]"); if (!b) return;
  const card = b.closest(".ccard"), id = card.dataset.id, c = charts().find(x=>x.id===id);
  switch (b.dataset.act){
    case "edit": openChartDialog(c); break;
    case "del": if (!confirm(`Grafiek "${c.title||"Grafiek"}" verwijderen?`)) return; project().charts = charts().filter(x=>x.id!==id); saveProjects(); renderCharts(); break;
    case "dup": { const n = {...JSON.parse(JSON.stringify(c)), id:uid(), title:(c.title||"Grafiek")+" (kopie)"}; charts().splice(charts().indexOf(c)+1,0,n); saveProjects(); renderCharts(); break; }
    case "table": { const t = card.querySelector(".tbl-wrap"); t.hidden = !t.hidden; if (!t.hidden && chartData.get(id)) t.innerHTML = chartTable(c, chartData.get(id)); break; }
    case "csv": {
      const r = chartData.get(id); if (!r?.series.length){ toast("Nog geen gegevens om te downloaden."); return; }
      const {head, rows} = chartRows(c, r);
      const csv = [head, ...rows].map(rw=>rw.map(v=>typeof v==="number" ? String(v).replace(".",",") : `"${String(v).replace(/"/g,'""')}"`).join(";")).join("\r\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿"+csv],{type:"text/csv"}));
      a.download = (c.title||"grafiek").replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"_")+".csv"; a.click(); URL.revokeObjectURL(a.href);
      break;
    }
  }
});

// ---- grafiek-editor
let dlgChart = null;
window.openChartDialog = (c, preset) => {
  if (!items().length){ toast("Voeg eerst een traject toe aan dit project (tabblad Kaart)."); return; }
  dlgChart = c || null;
  const f = $("#chart-form"), v = c || {title:"", items:items().slice(0,4).map(i=>i.key), type:"tijd", metric:"reistijd", agg:15, period:"24h", weekdays:[0,1,2,3,4,5,6], ...preset};
  $("#chart-dlg-t").textContent = c ? "Grafiek bewerken" : "Nieuwe grafiek";
  f.title.value = v.title||""; f.type.value = v.type; f.metric.value = v.metric; f.agg.value = String(v.agg); f.period.value = v.period;
  const today = new Date().toISOString().slice(0,10), weekAgo = new Date(Date.now()-6*864e5).toISOString().slice(0,10);
  f.from.value = v.from || weekAgo; f.to.value = v.to || today;
  f.cmp.checked = !!v.cmp; f.cfrom.value = v.cfrom || ""; f.cto.value = v.cto || "";
  dlgDays = [...(v.days || defaultDays())]; f.dayadd.value = ""; renderDlgDays();
  f.querySelectorAll('input[name=wd]').forEach(x=> x.checked = (v.weekdays ?? [0,1,2,3,4,5,6]).map(String).includes(x.value));
  $("#cf-items").innerHTML = items().map(i=>`<label class="chk"><input type="checkbox" name="it" value="${esc(i.key)}" ${v.items.includes(i.key)?"checked":""}><span class="sw" style="background:${i.color}"></span>${esc(i.label)} <span class="muted" style="font-size:12px">${isLus(i)?"· meetpunt":"· traject"}</span></label>`).join("");
  syncDlg(); $("#chart-dlg").showModal();
};
let dlgDays = [];
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return isoDay(d); };
function defaultDays(){ return [daysAgo(0), daysAgo(1), daysAgo(7)]; }
function renderDlgDays(){
  dlgDays = [...new Set(dlgDays)].sort().slice(-8);
  $("#cf-days").innerHTML = dlgDays.length ? dlgDays.map((d,i)=>`<span class="chip"><i style="background:${PALETTE[i%PALETTE.length]}"></i>${esc(dayLabel(d))}<button type="button" data-rmday="${d}" aria-label="Verwijder ${esc(dayLabel(d))}">×</button></span>`).join("") : `<span class="empty">Nog geen dagen gekozen.</span>`;
}
$("#chart-form").addEventListener("click", e=>{
  const rm = e.target.closest("[data-rmday]"); if (rm){ dlgDays = dlgDays.filter(d=>d!==rm.dataset.rmday); renderDlgDays(); return; }
  const b = e.target.closest("[data-day]"); if (!b) return;
  const f = $("#chart-form");
  if (b.dataset.day==="pick"){ if (!f.dayadd.value){ toast("Kies eerst een datum.", true); return; } dlgDays.push(f.dayadd.value); }
  else {
    const n = +b.dataset.day;
    if (n>=7 && dlgDays.length){   // zelfde weekdag als de laatst gekozen dag
      const last = new Date(dlgDays[dlgDays.length-1]+"T12:00"); last.setDate(last.getDate()-n); dlgDays.push(isoDay(last));
    } else dlgDays.push(daysAgo(n));
  }
  if (dlgDays.length > 8) toast("Maximaal 8 dagen; de oudste valt weg.");
  renderDlgDays();
});
function syncDlg(){
  const f = $("#chart-form"), dagen = f.type.value==="dagen";
  f.querySelector(".dagen-only").hidden = !dagen;
  f.querySelector(".period-row").hidden = dagen;
  f.querySelector(".wd-row").hidden = dagen;
  f.querySelectorAll(".abs").forEach(el=>el.hidden = dagen || f.period.value!=="abs");
  f.querySelector(".profiel-only").hidden = f.type.value!=="profiel";
  f.querySelector(".cmp-row").hidden = !f.cmp.checked;
}
$("#chart-form").addEventListener("change", syncDlg);
$("#chart-new").onclick = ()=> openChartDialog();
$("#chart-dlg").addEventListener("close", ()=>{
  if ($("#chart-dlg").returnValue!=="ok") return;
  const f = $("#chart-form");
  const v = {id: dlgChart?.id || uid(), title: f.title.value.trim(), type: f.type.value, metric: f.metric.value, agg: +f.agg.value, period: f.period.value,
    from: f.from.value, to: f.to.value, weekdays: [...f.querySelectorAll('input[name=wd]:checked')].map(x=>+x.value),
    items: [...f.querySelectorAll('input[name=it]:checked')].map(x=>x.value), cmp: f.cmp.checked, cfrom: f.cfrom.value, cto: f.cto.value,
    days: [...dlgDays]};
  if (!v.items.length){ toast("Kies minstens één traject.", true); return; }
  if (!v.title) v.title = v.items.map(k=>findItem(k)?.label).filter(Boolean).slice(0,2).join(" & ");
  if (dlgChart) Object.assign(dlgChart, v); else charts().push(v);
  saveProjects(); showView("grafieken");
});
$("#chart-save").addEventListener("click", e=>{
  const f = $("#chart-form");
  if (f.period.value==="abs" && (!f.from.value || !f.to.value)){ e.preventDefault(); toast("Vul een begin- en einddatum in.", true); }
  if (f.type.value==="profiel" && f.cmp.checked && (!f.cfrom.value || !f.cto.value)){ e.preventDefault(); toast("Vul de vergelijkingsperiode in.", true); }
  if (f.type.value==="dagen" && !dlgDays.length){ e.preventDefault(); toast("Kies minstens één dag.", true); }
});

// ================================================================ tabbladen
function showView(v){
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active", x.dataset.view===v));
  document.querySelectorAll(".view").forEach(x=>x.hidden = x.dataset.view!==v);
  if (v==="kaart") setTimeout(()=>map.invalidateSize(), 0);
  if (v==="grafieken") renderCharts();
  if (v==="meldingen") renderMeld();
}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>showView(b.dataset.view));

// ================================================================ verversen
let seen = {fetch:null, msi:null, drip:null}, sitesLoaded = false;
async function poll(){
  try{
    STATE = await getJSON("data/state.json");
    await loadArchive();
    try{ IDX = withArch(await getJSON("data/hist/index.json", STATE.lastFetch), "hist"); }catch(e){}
    if (ARCH) LIDX = withArch(LIDX, "lhist");
    if (!sitesLoaded && STATE.siteCount>0){
      const j = await getJSON("data/sites.json", STATE.lastFetch); SITES = j.sites||{}; sitesLoaded = true;
      buildFlow(); renderGroups(); drawMine();
      const b = projectBounds(); if (b) map.fitBounds(b.pad(.25));
    }
    if (STATE.lastFetch!==seen.fetch){
      seen.fetch=STATE.lastFetch; DATA=STATE.data||{};
      if (TIME==null){ await computeCls(); styleFlow(); }
      await refreshAt(); renderSelected(); renderList(); drawMine();
      if (!$('.view[data-view="grafieken"]').hidden) renderCharts();
    }
    if (STATE.msiTime!==seen.msi){ seen.msi=STATE.msiTime; loadMsi(); }
    if (STATE.dripTime!==seen.drip){ seen.drip=STATE.dripTime; loadDrips(); }
    if (STATE.loopsTime!==seen.loops){ seen.loops=STATE.loopsTime; loadLoops(); }
    if (STATE.sitTime!==seen.sit){ seen.sit=STATE.sitTime; loadSits(); }
    if (STATE.planningTime!==seen.plan){ seen.plan=STATE.planningTime; loadPlan(); }
    if (STATE.ovTime!==seen.ov){ seen.ov=STATE.ovTime; if (!OVNET) await loadOvNet(); loadOvVeh(); }
    renderTimebar(); showStatus();
  }catch(e){ console.error(e); STATE=null; showStatus(e); }
}
function showStatus(err){
  const dot=$("#st-dot"), txt=$("#st-text");
  if (err || !STATE){ dot.className="dot err"; txt.textContent="Data niet bereikbaar"; return; }
  const pub = STATE.publicationTime ? new Date(STATE.publicationTime) : null;
  const errs = Object.entries(STATE.errors||{}), age = STATE.generated ? (nowS() - STATE.generated)/60 : 0;
  if (errs.length){ dot.className="dot err"; txt.textContent = (pub?`Data ${hhmm(pub)} · `:"")+`fout bij ${errs.map(e=>e[0]).join(", ")}`; txt.title = errs.map(e=>e.join(": ")).join("\n"); }
  else if (age > 30){ dot.className="dot busy"; txt.textContent = (pub?`Data ${hhmm(pub)} · `:"")+`${Math.round(age)} min oud`; txt.title="GitHub Actions loopt achter of staat uit"; }
  else { dot.className="dot"; txt.textContent = pub ? `Data van ${hhmm(pub)}` : "Bijgewerkt"; txt.title=""; }
  const f = t => t ? new Date(t*1000).toLocaleString("nl-NL",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "–";
  $("#src-tt").textContent = f(STATE.lastFetch); $("#src-msi").textContent = f(STATE.msiTime); $("#src-drip").textContent = f(STATE.dripTime);
  $("#src-signs").textContent = STATE.signsTime ? new Date(STATE.signsTime*1000).toLocaleDateString("nl-NL") : "–";
  $("#info-days").textContent = STATE.historyDays || 14;
  $("#info-arch").textContent = ARCH ? `Afgeronde dagen worden daarnaast bewaard in het archief (branch “data” van de repository${ARCH.keepDays>0?`, ${ARCH.keepDays} dagen`:", onbeperkt"}); daar staan nu ${ARCH.hist.length} dagen reistijden en ${ARCH.lhist.length} dagen lusdata.` : "";
  $("#src-loops").textContent = f(STATE.loopsTime); $("#src-sit").textContent = f(STATE.sitTime); $("#src-plan").textContent = f(STATE.planningTime); $("#src-ov").textContent = f(STATE.ovTime);
}

// ================================================================ start
(async function init(){
  loadProjects(); renderProjectBar(); renderSelected(); renderSignCats(); renderSitCats();
  await poll();
  if (ui.layers.signs) refreshSigns();
  setInterval(poll, 60000);
})();
