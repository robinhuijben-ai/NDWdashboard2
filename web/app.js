/* Verkeersdashboard Van Brienenoordbrug — frontend
   Praat alleen met de lokale server (server.py); die haalt de NDW-feeds op. */
"use strict";

const PALETTE = ["#2563eb","#e8590c","#0f9d58","#9333ea","#db2777","#0891b2","#ca8a04","#dc2626","#4f46e5","#65a30d","#92400e","#0d9488"];
const PREFIX_LABELS = {
  RWS08:"RWS – vakken 500 m", RWS09:"RWS – routes", RWS04:"RWS – DRIP-routes", RWS10:"RWS – trajecten",
  GRT04:"Gemeente Rotterdam", PZH03:"Provincie Zuid-Holland", PZH04:"Provincie Zuid-Holland",
  RDH05:"Regio Rotterdam-Den Haag", RDH06:"Regio Rotterdam-Den Haag", HBR04:"Havenbedrijf", HBR05:"Havenbedrijf",
  SRR02:"Stadsregio", ABM01:"ABM"
};
const SIGN_CATS = {A:"Snelheid",B:"Voorrang",C:"Geslotenverklaring",D:"Rijrichting",E:"Parkeren/stilstaan",F:"Overige geboden",G:"Verkeersregels",H:"Bebouwde kom",J:"Waarschuwing",K:"Bewegwijzering",L:"Informatie"};
const SIGN_ZOOM = 16, MSI_DETAIL_ZOOM = 14;
const LS = "brienenoord-ui-v2";

let SITES = {}, DATA = {}, STATE = null, HIST = {};
let PROJ = null;              // {projects:[...], active}
let editing = null;           // key van traject in bewerkmodus
let ui = loadUI();

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const mmss = s => { if (s==null) return "–"; const t = Math.round(s); return `${Math.floor(t/60)}:${String(t%60).padStart(2,"0")}`; };
const hhmm = d => d.toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"});
const km = m => m==null ? "–" : (m/1000).toLocaleString("nl-NL",{maximumFractionDigits:1,minimumFractionDigits:1});
const uid = () => Math.random().toString(36).slice(2,10);
const prefix = id => id.split("_")[0];
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function loadUI(){ try{ return Object.assign({prefixOff:[],signCats:["A","B","C","D","F","J"],layers:{mine:true,flow:true,drip:false,msi:false,signs:false},base:"light",layersOpen:true}, JSON.parse(localStorage.getItem(LS))||{}); }catch(e){ return {prefixOff:[],signCats:["A","B","C","D","F","J"],layers:{mine:true,flow:true},base:"light",layersOpen:true}; } }
function saveUI(){ try{ localStorage.setItem(LS, JSON.stringify(ui)); }catch(e){} }
function toast(msg, err){ const t=$("#toast"); t.textContent=msg; t.className=err?"err":""; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true, err?9000:4000); }

function prettyName(id){
  const n = SITES[id]?.name || id;
  // RWS-vakken: "16 HRR_van_27900_tot_28400" -> "A16 Re · km 27,9–28,4"
  const m = n.match(/^([A-Z]?\d+)\s+(\w+?)_van_(\d+)_tot_(\d+)$/);
  if (m){
    const road = /^\d/.test(m[1]) ? "A"+m[1] : m[1];
    const side = {HRR:"Re",HRL:"Li"}[m[2]] || m[2];
    const f = v => (v/1000).toLocaleString("nl-NL",{minimumFractionDigits:1,maximumFractionDigits:1});
    return `${road} ${side} · km ${f(+m[3])}–${f(+m[4])}`;
  }
  return n.replace(/_/g," ");
}

// ---------------------------------------------------------------- metrics
function siteM(id){
  const d = DATA[id] || {}, s = SITES[id] || {};
  const dur = d.d ?? null, ref = d.ref ?? d.best ?? null;
  return {dur, ref, len:s.length||null, refSrc: d.ref!=null ? "NDW-referentie" : "snelste gemeten"};
}
function classify(dur, ref){
  if (dur==null) return "na";
  if (!ref) return "na";
  const r = dur/ref; return r < 1.25 ? "ok" : r < 1.75 ? "warn" : "bad";
}
function groupM(item){
  let dur=0, ref=0, len=0, have=0, refOk=true, nd=0;
  const srcs = new Set();
  for (const id of item.ids){
    if (!SITES[id]) continue;
    nd++;
    const m = siteM(id);
    len += m.len||0;
    if (m.dur!=null){ dur += m.dur; have++; }
    if (m.ref!=null){ ref += m.ref; srcs.add(m.refSrc); } else refOk=false;
  }
  const complete = nd>0 && have===nd;
  const D = complete ? dur : null, R = refOk && nd ? ref : null;
  const speed = (D && len) ? len/D*3.6 : null;
  const cls = classify(D, R);
  let txt = "geen data";
  if (!nd) txt = "geen segmenten";
  else if (!complete) txt = `onvolledig (${have}/${nd})`;
  else if (cls==="ok") txt = "vrije doorstroming";
  else if (cls==="na") txt = "nog geen referentie";
  else txt = `+${mmss(D-R)} vertraging`;
  return {dur:D, ref:R, len, speed, cls, txt, have, n:nd, refSrc:[...srcs].join(" / ")||"–"};
}

// ---------------------------------------------------------------- projects
const project = () => PROJ.projects.find(p=>p.id===PROJ.active) || PROJ.projects[0];
const items = () => project().items;
const findItem = key => items().find(i=>i.key===key);
function nextColor(){ const used=new Set(items().map(i=>i.color)); return PALETTE.find(c=>!used.has(c)) || PALETTE[items().length%PALETTE.length]; }
function newProject(name){ return {id:uid(), name, note:"", items:[]}; }

const PKEY = "brienenoord-projecten";
function saveProjects(){
  try{ localStorage.setItem(PKEY, JSON.stringify(PROJ)); }
  catch(e){ toast("Projecten konden niet in deze browser bewaard worden. Gebruik Exporteren om ze te bewaren.", true); }
}
function encodeShare(p){
  const bytes = new TextEncoder().encode(JSON.stringify({n:p.name, o:p.note, i:p.items.map(i=>[i.label,i.color,i.on?1:0,i.ids])}));
  let bin=""; bytes.forEach(b=>bin+=String.fromCharCode(b));
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function decodeShare(str){
  const bin = atob(str.replace(/-/g,"+").replace(/_/g,"/"));
  const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin,c=>c.charCodeAt(0))));
  return {id:uid(), name:j.n||"Gedeeld project", note:j.o||"", items:(j.i||[]).map(x=>({key:uid(), label:x[0], color:x[1], on:!!x[2], ids:x[3]||[]}))};
}
async function loadProjects(){
  let p = null;
  try{ p = JSON.parse(localStorage.getItem(PKEY)) || JSON.parse(localStorage.getItem("brienenoord-projecten-backup")); }catch(e){}
  if (!p || !p.projects || !p.projects.length){
    const first = newProject("Werkzaamheden Van Brienenoordbrug");
    p = {projects:[first], active:first.id};
  }
  PROJ = p;
  const m = location.hash.match(/[#&]p=([^&]+)/);
  if (m){
    try{
      const sp = decodeShare(m[1]);
      PROJ.projects.push(sp); PROJ.active = sp.id; saveProjects();
      setTimeout(()=>toast(`Gedeeld project "${sp.name}" toegevoegd.`), 300);
    }catch(e){ setTimeout(()=>toast("De gedeelde link is ongeldig.", true), 300); }
    history.replaceState(null, "", location.pathname + location.search);
  }
}
function renderProjectBar(){
  const sel = $("#proj-select");
  sel.innerHTML = PROJ.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===PROJ.active?"selected":""}>${esc(p.name)}</option>`).join("");
  $("#proj-note").value = project().note || "";
}
function switchProject(id){
  PROJ.active = id; editing = null; saveProjects();
  renderProjectBar(); drawMine(); styleFlow(); renderSelected(); renderList(); loadHistory();
  const b = projectBounds(); if (b) map.fitBounds(b.pad(.25));
}
function projectBounds(){
  const pts = items().flatMap(i=>i.ids.filter(id=>SITES[id]).flatMap(id=>SITES[id].coords));
  return pts.length ? L.latLngBounds(pts) : null;
}

$("#proj-select").onchange = e => switchProject(e.target.value);
$("#proj-new").onclick = ()=>{
  const name = prompt("Naam van het nieuwe project:", "Nieuw project"); if (!name) return;
  const p = newProject(name.trim()); PROJ.projects.push(p); switchProject(p.id);
};
$("#proj-note").oninput = e => { project().note = e.target.value; saveProjects(); };
$("#proj-menu").onclick = e => { e.stopPropagation(); $("#proj-menu-list").hidden = !$("#proj-menu-list").hidden; };
document.addEventListener("click", ()=> $("#proj-menu-list").hidden = true);
$("#proj-menu-list").onclick = e => {
  const act = e.target.dataset.act; if (!act) return;
  const p = project();
  if (act==="rename"){ const n = prompt("Nieuwe naam:", p.name); if (n){ p.name=n.trim(); saveProjects(); renderProjectBar(); } }
  if (act==="dup"){ const c = JSON.parse(JSON.stringify(p)); c.id=uid(); c.name=p.name+" (kopie)"; PROJ.projects.push(c); switchProject(c.id); }
  if (act==="export"){
    const blob = new Blob([JSON.stringify({version:1, project:p}, null, 2)], {type:"application/json"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = p.name.replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"_")+".json"; a.click(); URL.revokeObjectURL(a.href);
  }
  if (act==="import") $("#proj-import").click();
  if (act==="share"){
    const url = location.origin + location.pathname + "#p=" + encodeShare(p);
    (navigator.clipboard?.writeText(url) || Promise.reject()).then(
      ()=>toast("Link gekopieerd. Wie hem opent krijgt een eigen kopie van dit project."),
      ()=>prompt("Kopieer deze link:", url));
  }
  if (act==="delete"){
    if (PROJ.projects.length===1){ toast("Er moet minstens één project blijven."); return; }
    if (!confirm(`Project "${p.name}" verwijderen?`)) return;
    PROJ.projects = PROJ.projects.filter(x=>x.id!==p.id); switchProject(PROJ.projects[0].id);
  }
};
$("#proj-import").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try{
    const j = JSON.parse(await f.text()); const p = j.project || j;
    if (!p.items) throw new Error("geen project");
    p.id = uid(); PROJ.projects.push(p); switchProject(p.id); toast(`Project "${p.name}" geïmporteerd.`);
  }catch(err){ toast("Dit bestand is geen geldig project.", true); }
  e.target.value = "";
};

// ---------------------------------------------------------------- map
/* Lijn die in schermruimte naar rechts (t.o.v. de rijrichting) verschoven wordt,
   zodat beide rijrichtingen naast elkaar zichtbaar zijn. */
const OffsetLine = L.Polyline.extend({
  _projectLatlngs(latlngs, result, bounds){
    L.Polyline.prototype._projectLatlngs.call(this, latlngs, result, bounds);
    const o = this.options.offset; if (!o) return;
    for (const ring of result){
      if (ring._off || ring.length < 2) continue;
      ring._off = true;
      const n = ring.length, normals = [];
      for (let i=0;i<n-1;i++){
        const dx = ring[i+1].x-ring[i].x, dy = ring[i+1].y-ring[i].y, len = Math.hypot(dx,dy)||1;
        normals.push([-dy/len, dx/len]);
      }
      const out = ring.map((p,i)=>{
        const a = normals[Math.max(0,i-1)], b = normals[Math.min(n-2,i)];
        let nx = a[0]+b[0], ny = a[1]+b[1]; const l = Math.hypot(nx,ny)||1; nx/=l; ny/=l;
        const cos = Math.max(.5, nx*b[0]+ny*b[1]);   // miter, begrensd
        return L.point(p.x + nx*o/cos, p.y + ny*o/cos);
      });
      out.forEach((q,i)=>{ ring[i].x=q.x; ring[i].y=q.y; });
    }
  }
});
const offLine = (ll, opts) => new OffsetLine(ll, opts);
L.Popup.mergeOptions({autoPanPaddingTopLeft:[280,70], autoPanPaddingBottomRight:[20,20]});

const map = L.map("map",{zoomControl:true}).setView([51.901,4.539], 13);
map.zoomControl.setPosition("topright");
const BASES = {
  light: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",{maxZoom:20,subdomains:"abcd",attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · data <a href="https://opendata.ndw.nu/">NDW</a>'}),
  dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:20,subdomains:"abcd",attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · data <a href="https://opendata.ndw.nu/">NDW</a>'}),
  photo: L.tileLayer("https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg",{maxZoom:21,maxNativeZoom:19,attribution:'Luchtfoto &copy; <a href="https://www.pdok.nl/">PDOK/Beeldmateriaal.nl</a> · data <a href="https://opendata.ndw.nu/">NDW</a>'})
};
let baseLayer = null;
function setBase(k){ if (baseLayer) baseLayer.remove(); baseLayer = (BASES[k]||BASES.light).addTo(map); ui.base=k; saveUI(); }
setBase(ui.base);
document.querySelectorAll('input[name=base]').forEach(r=>{ r.checked = r.value===ui.base; r.onchange=()=>setBase(r.value); });

[["flow",405],["mine",420],["signs",430],["msi",440],["drip",450]].forEach(([n,z])=>{ map.createPane(n).style.zIndex=z; });
const flowRenderer = L.canvas({pane:"flow", padding:.3, tolerance:4});
const mineRenderer = L.svg({pane:"mine"});
L.marker([51.901,4.539],{icon:L.divIcon({className:"",html:'<div style="width:12px;height:12px;background:var(--accent);border:2px solid #1b1f26;transform:rotate(45deg)"></div>',iconSize:[12,12]}),title:"Van Brienenoordbrug",pane:"drip"}).addTo(map).bindTooltip("Van Brienenoordbrug");

// ---- doorstroming (alle segmenten)
const flowLines = {};
function flowColor(cls){ return {ok:cssVar("--ok"),warn:cssVar("--warn"),bad:cssVar("--bad"),na:cssVar("--na")}[cls]; }
function siteVisibleByPrefix(id){ return !ui.prefixOff.includes(prefix(id)); }
function buildFlow(){
  Object.values(flowLines).forEach(l=>l.remove());
  for (const id in SITES){
    const l = offLine(SITES[id].coords,{renderer:flowRenderer,weight:3,opacity:.85,lineCap:"round",offset:3});
    l.on("click", e => onSegmentClick(id, e.latlng));
    l.on("mouseover", ()=>{ l.setStyle({weight:6}); l.bindTooltip(esc(prettyName(id)),{sticky:true,opacity:.95}).openTooltip(); });
    l.on("mouseout", ()=> styleFlowOne(id));
    flowLines[id] = l;
  }
  styleFlow();
}
function styleFlowOne(id){
  const l = flowLines[id]; if (!l) return;
  const show = (ui.layers.flow || editing) && siteVisibleByPrefix(id);
  if (!show){ l.remove(); return; }
  const m = siteM(id), cls = classify(m.dur, m.ref);
  l.setStyle({color:flowColor(cls), weight: editing?4:3, opacity: editing ? .9 : .8, dashArray: cls==="na" ? "2 5" : null});
  if (!map.hasLayer(l)) l.addTo(map);
}
function styleFlow(){ for (const id in flowLines) styleFlowOne(id); }

// ---- mijn trajecten
const mineGroup = L.layerGroup().addTo(map);
function drawMine(){
  mineGroup.clearLayers();
  if (!ui.layers.mine) return;
  for (const it of items()){
    if (!it.on && it.key!==editing) continue;
    for (const id of it.ids){
      const s = SITES[id]; if (!s) continue;
      offLine(s.coords,{renderer:mineRenderer,color:"#fff",weight:10,opacity:.95,interactive:false,lineCap:"round",offset:5}).addTo(mineGroup);
      const l = offLine(s.coords,{renderer:mineRenderer,color:it.color,weight:6,opacity:1,lineCap:"round",offset:5,dashArray: it.on?null:"6 6"}).addTo(mineGroup);
      l.on("click", e => editing ? onSegmentClick(id, e.latlng) : L.popup().setLatLng(e.latlng).setContent(itemPopup(it, id)).openOn(map));
      l.bindTooltip(esc(it.label||prettyName(id)),{sticky:true});
    }
  }
}
function itemPopup(it, id){
  const g = groupM(it);
  return `<div class="pop"><h4>${esc(it.label)}</h4>
    <div class="m num">${mmss(g.dur)} min · ${g.speed?Math.round(g.speed)+" km/u · ":""}${km(g.len)} km</div>
    <div class="m">${esc(g.txt)}</div>
    <div class="m">Segment: ${esc(prettyName(id))}</div>
    <div class="acts"><button onclick="startEdit('${it.key}')">Segmenten bewerken</button></div></div>`;
}

function segPopup(id){
  const m = siteM(id), cls = classify(m.dur, m.ref), s = SITES[id];
  const opts = items().map(i=>`<option value="${esc(i.key)}">${esc(i.label)}</option>`).join("");
  return `<div class="pop"><h4>${esc(prettyName(id))}</h4>
    <div class="m num">${mmss(m.dur)} min${m.dur&&s.length?` · ${Math.round(s.length/m.dur*3.6)} km/u`:""} · ${km(s.length)} km</div>
    <div class="m">${m.ref?`referentie ${mmss(m.ref)} (${esc(m.refSrc)})`:"geen referentie"} · <span style="color:${flowColor(cls)}">●</span></div>
    <div class="m" style="font-size:11px">${esc(id)}</div>
    <div class="acts"><button onclick="addAsNew('${id}')">Als nieuw traject</button>
    ${opts?`<select id="addto-${id}" style="font:inherit;font-size:12px;max-width:140px">${opts}</select><button onclick="addTo('${id}', document.getElementById('addto-${id}').value)">Toevoegen</button>`:""}</div></div>`;
}
function onSegmentClick(id, latlng){
  if (editing){ toggleInItem(editing, id); return; }
  L.popup().setLatLng(latlng).setContent(segPopup(id)).openOn(map);
}
window.addAsNew = id => { const it = {key:uid(), label:prettyName(id), color:nextColor(), on:true, ids:[id]}; items().push(it); map.closePopup(); changed(); };
window.addTo = (id, key) => { const it = findItem(key); if (it && !it.ids.includes(id)) it.ids.push(id); map.closePopup(); changed(); };
function toggleInItem(key, id){
  const it = findItem(key); if (!it) return;
  const i = it.ids.indexOf(id);
  if (i>=0) it.ids.splice(i,1); else it.ids.push(id);
  changed();
}
function changed(){ saveProjects(); drawMine(); renderSelected(); renderList(); loadHistory(); }

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

// ---------------------------------------------------------------- cards
const I = {
  eye:'<svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:'<svg viewBox="0 0 24 24"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-7 0-11-7-11-7a19 19 0 0 1 5.1-5.9M9.9 5.2A9.6 9.6 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-2.2 3.2M1 1l22 22"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  zoom:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  edit:'<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>'
};
function groupHist(it){
  const byT = new Map(); const n = it.ids.filter(id=>SITES[id]).length;
  for (const id of it.ids){ for (const [t,d] of (HIST[id]||[])){ const e = byT.get(t)||[0,0]; e[0]+=d; e[1]++; byT.set(t,e); } }
  return [...byT.entries()].filter(([,e])=>e[1]===n && n>0).sort((a,b)=>a[0]-b[0]).map(([t,e])=>[t,e[0]]);
}
function sparkline(it){
  const pts = groupHist(it);
  if (pts.length < 2) return `<div class="spark-meta"><span>verloop verschijnt na een paar metingen</span></div>`;
  const W=360,H=34,t0=pts[0][0],t1=pts[pts.length-1][0], vals=pts.map(p=>p[1]), lo=Math.min(...vals), hi=Math.max(...vals), sp=(hi-lo)||1;
  const x=t=>((t-t0)/((t1-t0)||1))*W, y=v=>H-3-((v-lo)/sp)*(H-6);
  const d = pts.map((p,i)=>`${i?"L":"M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const l = pts[pts.length-1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}" stroke="${it.color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${x(l[0])}" cy="${y(l[1])}" r="2.5" fill="${it.color}" stroke="none"/></svg>
    <div class="spark-meta num"><span>${hhmm(new Date(t0*1000))}</span><span>min ${mmss(lo)} · max ${mmss(hi)}</span><span>${hhmm(new Date(t1*1000))}</span></div>`;
}
function renderSelected(){
  const box = $("#selected"), list = items();
  if (!list.length){
    box.innerHTML = `<div class="empty">Nog geen trajecten in dit project. Klik een segment in de lijst of op de kaart, of stel een traject samen uit meerdere segmenten.</div>`;
    return;
  }
  box.innerHTML = list.map(it=>{
    const g = groupM(it);
    return `<div class="card ${it.on?"":"off"} ${editing===it.key?"editing":""}" style="--c:${it.color}" data-key="${esc(it.key)}">
      <div class="top">
        <label class="swatch" title="Kleur kiezen"><input type="color" value="${it.color}" data-act="color"></label>
        <span class="name" contenteditable="plaintext-only" spellcheck="false" title="Klik om de naam te wijzigen" data-act="name">${esc(it.label)}</span>
        <button class="icon ${editing===it.key?"on":""}" data-act="edit" title="Segmenten kiezen op de kaart">${I.edit}</button>
        <button class="icon" data-act="zoom" title="Inzoomen">${I.zoom}</button>
        <button class="icon" data-act="on" title="${it.on?"Verbergen op kaart":"Tonen op kaart"}" aria-pressed="${it.on}">${it.on?I.eye:I.eyeOff}</button>
        <button class="icon" data-act="del" title="Verwijderen">${I.x}</button>
      </div>
      <div class="segs">${g.n} segment${g.n===1?"":"en"} · ${km(g.len)} km</div>
      <div class="metrics">
        <div><div class="big num">${mmss(g.dur)}</div><div class="lbl">reistijd (min)</div></div>
        <div><div class="big num">${g.speed?Math.round(g.speed):"–"}</div><div class="lbl">km/u gem.</div></div>
        <span class="badge ${g.cls}" title="referentie: ${g.ref?mmss(g.ref):"–"} (${esc(g.refSrc)})">${esc(g.txt)}</span>
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
      if (editing===key) stopEdit(); project().items = items().filter(i=>i.key!==key); changed(); break;
    case "zoom": { const pts = it.ids.filter(id=>SITES[id]).flatMap(id=>SITES[id].coords); if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.4)); break; }
    case "edit": editing===key ? stopEdit() : startEdit(key); break;
  }
});
$("#selected").addEventListener("input", e=>{
  if (e.target.dataset.act!=="color") return;
  const card = e.target.closest(".card"), it = findItem(card.dataset.key);
  it.color = e.target.value; card.style.setProperty("--c", it.color); drawMine();
  if (editing===it.key) $("#editbar-sw").style.background = it.color;
});
$("#selected").addEventListener("change", e=>{ if (e.target.dataset.act==="color"){ saveProjects(); renderList(); renderChart(); } });
$("#selected").addEventListener("focusout", e=>{
  if (e.target.dataset.act!=="name") return;
  const it = findItem(e.target.closest(".card").dataset.key), v = e.target.textContent.trim();
  if (v && v!==it.label){ it.label = v; saveProjects(); drawMine(); renderChart(); if (editing===it.key) $("#editbar-name").textContent=v; }
  else e.target.textContent = it.label;
});
$("#selected").addEventListener("keydown", e=>{ if (e.target.dataset.act==="name" && e.key==="Enter"){ e.preventDefault(); e.target.blur(); } });
$("#all-on").onclick = ()=>{ items().forEach(i=>i.on=true); saveProjects(); drawMine(); renderSelected(); };
$("#all-off").onclick = ()=>{ items().forEach(i=>i.on=false); saveProjects(); drawMine(); renderSelected(); };

// ---------------------------------------------------------------- list
function itemOf(id){ return items().find(i=>i.ids.includes(id)); }
function renderList(){
  const q = $("#q").value.trim().toLowerCase(), inView = $("#inview").checked, b = map.getBounds();
  let ids = Object.keys(SITES).filter(siteVisibleByPrefix);
  if (q) ids = ids.filter(id => (prettyName(id)+" "+SITES[id].name+" "+id).toLowerCase().includes(q));
  if (inView) ids = ids.filter(id => SITES[id].coords.some(c=>b.contains(c)));
  ids.sort((a,c)=>SITES[a].dist-SITES[c].dist);
  $("#count").textContent = `${ids.length} / ${Object.keys(SITES).length}`;
  $("#list").innerHTML = ids.slice(0,300).map(id=>{
    const m = siteM(id), cls = classify(m.dur,m.ref), it = itemOf(id), s = SITES[id];
    return `<div class="row ${it?"in":""}" data-id="${esc(id)}" ${it?`style="--c:${it.color}"`:""}>
      <span class="dotc" style="background:${it?it.color:flowColor(cls)}"></span>
      <div style="min-width:0"><div class="n">${esc(prettyName(id))}</div>
        <div class="sub">${esc(PREFIX_LABELS[prefix(id)]||prefix(id))} · ${km(s.length)} km${it?` · in “${esc(it.label)}”`:""}</div></div>
      <div class="tt num">${mmss(m.dur)}${m.dur!=null&&m.ref?`<small>${m.dur-m.ref>=1?"+"+mmss(m.dur-m.ref):"±0:00"}</small>`:""}</div></div>`;
  }).join("") || `<div class="empty" style="padding:12px 14px">Geen segmenten gevonden${inView?" in het kaartbeeld":""}.</div>`;
}
$("#list").addEventListener("click", e=>{
  const row = e.target.closest(".row"); if (!row) return;
  const id = row.dataset.id;
  if (editing){ toggleInItem(editing, id); return; }
  const it = itemOf(id);
  if (it){ map.fitBounds(L.latLngBounds(SITES[id].coords).pad(1.5)); return; }
  addAsNew(id);
});
$("#list").addEventListener("mouseover", e=>{ const r=e.target.closest(".row"); if (r && flowLines[r.dataset.id] && map.hasLayer(flowLines[r.dataset.id])) flowLines[r.dataset.id].setStyle({weight:8}); });
$("#list").addEventListener("mouseout", e=>{ const r=e.target.closest(".row"); if (r) styleFlowOne(r.dataset.id); });
$("#q").oninput = renderList; $("#inview").onchange = renderList;
let moveT; map.on("moveend", ()=>{ clearTimeout(moveT); moveT=setTimeout(()=>{ if ($("#inview").checked) renderList(); refreshSigns(); },150); });

// ---------------------------------------------------------------- layers panel
function renderPrefixChips(){
  const counts = {}; Object.keys(SITES).forEach(id=>{ const p=prefix(id); counts[p]=(counts[p]||0)+1; });
  $("#prefix-box").innerHTML = `<div class="chips">${Object.keys(counts).sort().map(p=>
    `<span class="chip ${ui.prefixOff.includes(p)?"":"on"}" data-p="${esc(p)}" title="${esc(PREFIX_LABELS[p]||p)}">${esc(p)} <small>${counts[p]}</small></span>`).join("")}</div>`;
}
$("#prefix-box").addEventListener("click", e=>{
  const c = e.target.closest(".chip"); if (!c) return;
  const p = c.dataset.p, i = ui.prefixOff.indexOf(p);
  if (i>=0) ui.prefixOff.splice(i,1); else ui.prefixOff.push(p);
  saveUI(); renderPrefixChips(); styleFlow(); renderList();
});
function bindLayer(id, key, fn){
  const el = $(id); el.checked = !!ui.layers[key];
  el.onchange = ()=>{ ui.layers[key] = el.checked; saveUI(); fn(); };
}
bindLayer("#ly-mine","mine", drawMine);
bindLayer("#ly-flow","flow", ()=>{ $("#prefix-box").hidden = !ui.layers.flow; styleFlow(); });
bindLayer("#ly-drip","drip", ()=> ui.layers.drip ? loadDrips() : dripGroup.clearLayers());
bindLayer("#ly-msi","msi", ()=> ui.layers.msi ? loadMsi() : msiGroup.clearLayers());
bindLayer("#ly-signs","signs", ()=>{ $("#signs-box").hidden = !ui.layers.signs; refreshSigns(); });
$("#prefix-box").hidden = !ui.layers.flow; $("#signs-box").hidden = !ui.layers.signs;
$("#layers-toggle").onclick = ()=>{ ui.layersOpen = !ui.layersOpen; saveUI(); applyLayersOpen(); };
function applyLayersOpen(){ $("#layers-body").hidden = !ui.layersOpen; $("#layers-toggle").setAttribute("aria-expanded", ui.layersOpen); }
applyLayersOpen();
L.DomEvent.disableClickPropagation($("#layers")); L.DomEvent.disableScrollPropagation($("#layers"));

// ---------------------------------------------------------------- MSI
const msiGroup = L.layerGroup().addTo(map);
let MSI = [];
function laneHtml(l){
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
function portalSummary(p){
  const k = p.lanes.map(l=>l.d?.k);
  return k.includes("lane_closed") ? "x" : k.includes("speedlimit") ? "sp" : (k.includes("lane_open")||k.includes("lane_closed_ahead")) ? "op" : "";
}
function drawMsi(){
  msiGroup.clearLayers();
  if (!ui.layers.msi) return;
  const detail = map.getZoom() >= MSI_DETAIL_ZOOM;
  for (const p of MSI){
    const html = detail ? `<div class="msi">${p.lanes.map(laneHtml).join("")}</div>` : `<div class="msi-dot ${portalSummary(p)}"></div>`;
    const w = detail ? p.lanes.length*20+4 : 10, h = detail ? 22 : 10;
    const m = L.marker([p.lat,p.lon],{pane:"msi",icon:L.divIcon({className:"",html,iconSize:[w,h],iconAnchor:[w/2,h/2]})});
    const t = p.lanes.map(l=>l.t).filter(Boolean).sort().pop();
    m.bindPopup(()=>`<div class="pop"><h4>${esc(p.road)} ${esc(p.cw)} · km ${esc(p.km)}</h4>
      <div class="msi" style="display:inline-flex;transform:scale(1.4);transform-origin:left top;margin:2px 0 14px">${p.lanes.map(laneHtml).join("")}</div>
      <div class="kv">${p.lanes.map(l=>`<span>Rijstrook ${esc(l.n)}</span><span>${esc(LANE_TXT[l.d?.k]||l.d?.k)}${l.d?.v?" "+esc(l.d.v):""}${l.d?.r?" (verplicht)":""}${l.d?.f?" · knipperend":""}</span>`).join("")}</div>
      <div class="m" style="margin-top:6px">${p.bearing!=null?`rijrichting ${p.bearing}° · `:""}${t?"laatst gewijzigd "+new Date(t).toLocaleString("nl-NL"):""}</div></div>`);
    m.addTo(msiGroup);
  }
}
async function loadMsi(){
  try{ const j = await getJSON("data/msi.json"); MSI = j.portals||[]; $("#cnt-msi").textContent = MSI.length||""; drawMsi(); }
  catch(e){ toast("Matrixborden konden niet geladen worden.", true); }
}
let lastZoomDetail = map.getZoom() >= MSI_DETAIL_ZOOM;
map.on("zoomend", ()=>{ const d = map.getZoom() >= MSI_DETAIL_ZOOM; if (d!==lastZoomDetail){ lastZoomDetail=d; drawMsi(); } });

// ---------------------------------------------------------------- DRIP
const dripGroup = L.layerGroup().addTo(map);
let DRIPS = [];
function dripLines(lines){ return lines.map(l => esc(l).replace(/%s(\d+)/g,'<span class="rt">$1</span>')).join("<br>"); }
function drawDrips(){
  dripGroup.clearLayers();
  if (!ui.layers.drip) return;
  for (const d of DRIPS){
    const off = d.working && d.working!=="working";
    const m = L.marker([d.lat,d.lon],{pane:"drip",title:d.name,icon:L.divIcon({className:"",html:`<div class="drip-ic ${off?"off":""}"></div>`,iconSize:[22,15]})});
    m.bindPopup(()=>{
      const imgs = (d.img||[]).map(n=>`<img class="drip" alt="Beeld DRIP ${esc(d.name)}" src="data/drip/${encodeURIComponent(n)}?v=${encodeURIComponent(d.t||"")}">`).join("");
      return `<div class="pop"><h4>${esc(d.name)}</h4>
        ${imgs}${d.text?.length?`<div class="lines">${dripLines(d.text)}</div>`:""}
        <div class="m">${off?"⚠ buiten werking · ":""}${d.t?"laatst gewijzigd "+new Date(d.t).toLocaleString("nl-NL"):""}</div>
        <div class="m" style="font-size:11px">${esc(d.id)}</div></div>`;
    },{maxWidth:300});
    m.addTo(dripGroup);
  }
}
async function loadDrips(){
  try{ const j = await getJSON("data/drips.json"); DRIPS = j.drips||[]; $("#cnt-drip").textContent = DRIPS.length||""; drawDrips(); }
  catch(e){ toast("DRIP's konden niet geladen worden.", true); }
}

// ---------------------------------------------------------------- verkeersborden
const signGroup = L.layerGroup().addTo(map);
let signCatsKnown = {};
function renderSignCats(){
  const cats = Object.keys(SIGN_CATS);
  $("#sign-cats").innerHTML = cats.map(c=>`<span class="chip ${ui.signCats.includes(c)?"on":""}" data-c="${c}" title="${esc(SIGN_CATS[c])}">${c} ${esc(SIGN_CATS[c])}${signCatsKnown[c]?` <small>${signCatsKnown[c]}</small>`:""}</span>`).join("");
}
$("#sign-cats").addEventListener("click", e=>{
  const c = e.target.closest(".chip"); if (!c) return;
  const k = c.dataset.c, i = ui.signCats.indexOf(k);
  if (i>=0) ui.signCats.splice(i,1); else ui.signCats.push(k);
  saveUI(); renderSignCats(); refreshSigns(true);
});
function signIcon(s){
  const code = s.rvvCode || "?", c = code[0];
  const label = (s.blackCode && s.blackCode.length<=3 && /^\d+$/.test(s.blackCode)) ? s.blackCode : code;
  let cls = "vb " + (SIGN_CATS[c] ? c : "X");
  if (code==="B6") cls = "vb Bt";
  else if (c==="B") cls = "vb X";
  const big = cls.includes("K") ? [26,16] : [22,22];
  return L.divIcon({className:"",html:`<div class="${cls}">${esc(label)}</div>`,iconSize:big});
}
function signPopup(s){
  const row = (k,v) => v ? `<span>${k}</span><span>${esc(v)}</span>` : "";
  return `<div class="pop"><h4>${esc(s.rvvCode)} – ${esc(SIGN_CATS[(s.rvvCode||"")[0]]||"bord")}</h4>
    <div class="kv">${row("Onderbord",s.blackCode)}${row("Tekst",s.textSigns)}${row("Weg",s.roadName)}${row("Plaats",s.townName)}${row("Richting",s.bearing?s.bearing+"°":"")}
    ${row("Geplaatst",s.placedOn)}${row("Verwacht weg",s.expectedRemovedOn)}${row("Laatst gezien",s.lastSeenOn)}${row("Gevalideerd",s.validatedOn)}</div>
    ${s.imageUrl?`<a href="${esc(s.imageUrl)}" target="_blank" rel="noopener"><img class="photo" loading="lazy" alt="Foto van bord ${esc(s.rvvCode)}" src="${esc(s.imageUrl)}"></a>`:""}
    <div class="m" style="font-size:11px;margin-top:4px">${esc(s.id)}</div></div>`;
}
let signReq = 0, signKey = "", SIGN_META = null;
const signTiles = new Map();   // tegel -> Promise<array>
async function signMeta(){
  if (!SIGN_META) SIGN_META = await getJSON("data/signs/meta.json", STATE?.signsTime);
  return SIGN_META;
}
function tileList(b, size){
  const out = [];
  for (let i=Math.floor(b.getSouth()/size); i<=Math.floor(b.getNorth()/size); i++)
    for (let j=Math.floor(b.getWest()/size); j<=Math.floor(b.getEast()/size); j++) out.push(`${i}_${j}`);
  return out;
}
function loadTile(k){
  if (!signTiles.has(k)) signTiles.set(k, getJSON(`data/signs/t/${k}.json`, SIGN_META.time).catch(()=>[]));
  return signTiles.get(k);
}
async function refreshSigns(force){
  if (!ui.layers.signs){ signGroup.clearLayers(); signKey=""; return; }
  let meta;
  try{ meta = await signMeta(); }catch(e){ $("#signs-hint").textContent = "Verkeersborden zijn nog niet beschikbaar (eerste download loopt)."; return; }
  signCatsKnown = meta.cats||{}; renderSignCats();
  $("#cnt-signs").textContent = meta.count||"";
  const z = map.getZoom();
  if (z < SIGN_ZOOM){
    signGroup.clearLayers(); signKey="";
    $("#signs-hint").textContent = `Zoom verder in om borden te zien (nu niveau ${z}, nodig ${SIGN_ZOOM}).`;
    return;
  }
  const b = map.getBounds().pad(.15), key = [b.toBBoxString(), ui.signCats.join()].join("|");
  if (!force && key===signKey) return;
  signKey = key; const my = ++signReq;
  const have = new Set(meta.tiles);
  const lists = await Promise.all(tileList(b, meta.tile).filter(k=>have.has(k)).map(loadTile));
  if (my!==signReq) return;
  const cats = new Set(ui.signCats), LIMIT = 2500;
  const hits = lists.flat().filter(s => b.contains([s.lat,s.lon]) && cats.has((s.rvvCode||"?")[0]));
  signGroup.clearLayers();
  for (const s of hits.slice(0,LIMIT)) L.marker([s.lat,s.lon],{pane:"signs",icon:signIcon(s)}).bindPopup(()=>signPopup(s)).addTo(signGroup);
  $("#signs-hint").textContent = `${Math.min(hits.length,LIMIT)} van ${hits.length} borden in beeld · stand ${new Date(meta.time*1000).toLocaleDateString("nl-NL")}.`;
}

// ---------------------------------------------------------------- chart
function renderChart(){
  const box = $("#chart"), leg = $("#chart-legend");
  if (document.querySelector('.view[data-view="chart"]').hidden) return;
  const rel = document.querySelector('input[name=cmode]:checked').value === "rel";
  const series = items().map(it=>{
    const g = groupM(it); let pts = groupHist(it);
    if (rel){ if (!g.ref) return null; pts = pts.map(([t,v])=>[t, v-g.ref]); }
    return pts.length>1 ? {it, pts} : null;
  }).filter(Boolean);
  if (!series.length){ box.innerHTML = `<p class="hint">Nog niet genoeg metingen. Ongeveer elke 5–10 minuten komt er een punt bij; de historie wordt ${STATE?.historyDays||14} dagen bewaard.</p>`; leg.innerHTML=""; return; }
  const W=360,H=240,P={l:38,r:8,t:18,b:24};
  const all = series.flatMap(s=>s.pts), t0=Math.min(...all.map(p=>p[0])), t1=Math.max(...all.map(p=>p[0]));
  let lo = Math.min(0, ...all.map(p=>p[1])), hi = Math.max(...all.map(p=>p[1])); if (hi<=lo) hi=lo+60;
  const step = [30,60,120,300,600,900,1800,3600].find(s=>(hi-lo)/s<=5)||3600; hi = Math.ceil(hi/step)*step; lo = Math.floor(lo/step)*step;
  const x = t => P.l + (t-t0)/((t1-t0)||1)*(W-P.l-P.r), y = v => H-P.b-(v-lo)/(hi-lo)*(H-P.t-P.b);
  let g = "";
  for (let v=lo; v<=hi; v+=step) g += `<line x1="${P.l}" x2="${W-P.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${P.l-5}" y="${y(v)+3}" text-anchor="end" font-size="9" fill="var(--muted)">${v<0?"-":""}${mmss(Math.abs(v))}</text>`;
  g += `<text x="2" y="7" font-size="9" fill="var(--muted)">min</text>`;
  const span = t1-t0, hs = [60,300,600,900,1800,3600,7200,10800,21600,43200].find(s=>span/s<=5) || 86400;
  const tz = new Date().getTimezoneOffset()*60;
  for (let t=Math.ceil((t0-tz)/hs)*hs+tz; t<=t1; t+=hs) g += `<text x="${x(t)}" y="${H-8}" text-anchor="middle" font-size="9" fill="var(--muted)">${hhmm(new Date(t*1000))}</text>`;
  const lines = series.map(s=>`<path d="${s.pts.map((p,i)=>`${i?"L":"M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")}" stroke="${s.it.color}" stroke-width="2"/>`).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reistijd per traject">${g}${lines}<line id="cx" y1="${P.t}" y2="${H-P.b}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/></svg><div class="tip" hidden></div>`;
  leg.innerHTML = series.map(s=>`<span><i style="background:${s.it.color}"></i>${esc(s.it.label)}</span>`).join("");
  const svg = box.querySelector("svg"), tip = box.querySelector(".tip"), cx = box.querySelector("#cx");
  svg.addEventListener("mousemove", e=>{
    const r = svg.getBoundingClientRect(), px = (e.clientX-r.left)/r.width*W;
    const t = t0 + (px-P.l)/(W-P.l-P.r)*(t1-t0);
    let best = null; for (const p of all) if (!best || Math.abs(p[0]-t)<Math.abs(best-t)) best = p[0];
    cx.setAttribute("x1",x(best)); cx.setAttribute("x2",x(best)); cx.setAttribute("visibility","visible");
    tip.hidden = false;
    tip.innerHTML = `<b class="num">${hhmm(new Date(best*1000))}</b>` + series.map(s=>{ const p=s.pts.find(p=>p[0]===best); return p?`<div><span><i style="background:${s.it.color}"></i> ${esc(s.it.label)}</span><span class="num">${p[1]<0?"-":""}${mmss(Math.abs(p[1]))}</span></div>`:""; }).join("");
    const left = Math.min(r.width-tip.offsetWidth-4, Math.max(4, x(best)/W*r.width+10));
    tip.style.left = left+"px"; tip.style.top = "8px";
  });
  svg.addEventListener("mouseleave", ()=>{ tip.hidden=true; cx.setAttribute("visibility","hidden"); });
}
document.querySelectorAll('input[name=cmode]').forEach(r=>r.onchange=renderChart);

// ---------------------------------------------------------------- views
document.querySelectorAll(".rail-btn").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".rail-btn").forEach(x=>x.classList.toggle("active", x===b));
  document.querySelectorAll(".view").forEach(v=>v.hidden = v.dataset.view!==b.dataset.view);
  if (b.dataset.view==="chart") renderChart();
});

// ---------------------------------------------------------------- data
const bust = () => Math.floor(Date.now()/60000);   // ververst hooguit eens per minuut
async function getJSON(u, v){ const r = await fetch(`${u}?v=${v ?? bust()}`,{cache:"no-store"}); if(!r.ok) throw new Error(r.status); return r.json(); }
function bucketOf(id){ let h=0; for (const ch of id) h = (Math.imul(h,31) + ch.charCodeAt(0)) >>> 0; return h % 64; }
async function loadHistory(){
  const ids = [...new Set(items().flatMap(i=>i.ids))].filter(id=>SITES[id]).slice(0,300);
  if (!ids.length){ HIST = {}; renderSelected(); renderChart(); return; }
  const bs = [...new Set(ids.map(bucketOf))], H = {};
  await Promise.all(bs.map(async b=>{
    try{
      const j = await getJSON(`data/hist/${String(b).padStart(2,"0")}.json`, STATE?.lastFetch);
      for (const [id,arr] of Object.entries(j.sites)){
        const pts = []; arr.forEach((v,i)=>{ if (v!=null) pts.push([j.times[i], v/10]); });
        H[id] = pts;
      }
    }catch(e){}
  }));
  HIST = H;
  renderSelected(); renderChart();
}

let seen = {fetch:null, msi:null, drip:null}, sitesLoaded = false;
async function poll(){
  try{
    STATE = await getJSON("data/state.json");
    if (!sitesLoaded && STATE.siteCount>0){
      const j = await getJSON("data/sites.json", STATE.lastFetch); SITES = j.sites||{}; sitesLoaded = true;
      buildFlow(); renderPrefixChips(); drawMine();
      const b = projectBounds(); map.fitBounds(b ? b.pad(.25) : L.latLngBounds(Object.values(SITES).flatMap(s=>s.coords)).pad(-.2));
    }
    if (STATE.lastFetch!==seen.fetch){ seen.fetch=STATE.lastFetch; DATA=STATE.data||{}; styleFlow(); drawMine(); renderSelected(); renderList(); loadHistory(); }
    if (STATE.msiTime!==seen.msi){ seen.msi=STATE.msiTime; if (ui.layers.msi) loadMsi(); }
    if (STATE.dripTime!==seen.drip){ seen.drip=STATE.dripTime; if (ui.layers.drip) loadDrips(); }
    showStatus();
  }catch(e){ STATE=null; showStatus(e); }
}
function showStatus(err){
  const dot=$("#st-dot"), txt=$("#st-text");
  if (err || !STATE){ dot.className="dot err"; txt.textContent="Data niet bereikbaar — controleer je internetverbinding"; return; }
  const pub = STATE.publicationTime ? new Date(STATE.publicationTime) : null;
  const errs = Object.entries(STATE.errors||{});
  const age = STATE.generated ? (Date.now()/1000 - STATE.generated)/60 : 0;
  if (errs.length){ dot.className="dot err"; txt.textContent = (pub?`Reistijden van ${hhmm(pub)} · `:"")+`fout bij ${errs.map(e=>e[0]).join(", ")}`; txt.title = errs.map(e=>e.join(": ")).join("\n"); }
  else if (age > 30){ dot.className="dot busy"; txt.textContent = (pub?`Reistijden van ${hhmm(pub)} · `:"")+`al ${Math.round(age)} min niet bijgewerkt`; txt.title="GitHub Actions loopt achter of staat uit"; }
  else { dot.className="dot"; txt.textContent = pub ? `Reistijden van ${hhmm(pub)}` : "Bijgewerkt"; txt.title=""; }
  const f = t => t ? hhmm(new Date(t*1000)) : "–";
  $("#src-signs").textContent = STATE.signsTime ? new Date(STATE.signsTime*1000).toLocaleDateString("nl-NL") : "–";
  $("#src-tt").textContent = f(STATE.lastFetch); $("#src-msi").textContent = f(STATE.msiTime); $("#src-drip").textContent = f(STATE.dripTime);
}
setInterval(()=>{
  const el = $("#st-next"); if (!STATE?.generated){ el.textContent=""; return; }
  const m = Math.floor((Date.now()/1000 - STATE.generated)/60);
  el.textContent = `· opgehaald ${m<1?"zojuist":m+" min geleden"}`;
},10000);
$("#btn-refresh").onclick = async ()=>{ await poll(); toast("Laatste data opgehaald. Nieuwe metingen komen ongeveer elke 5–10 minuten binnen."); };

// ---------------------------------------------------------------- start
(async function init(){
  await loadProjects();
  renderProjectBar(); renderSelected(); renderSignCats();
  await poll();
  if (ui.layers.msi) loadMsi();
  if (ui.layers.drip) loadDrips();
  if (ui.layers.signs) refreshSigns();
  setInterval(poll, 60000);
})();
