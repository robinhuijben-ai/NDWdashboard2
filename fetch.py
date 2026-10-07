#!/usr/bin/env python3
"""
Bouwt de data voor het verkeersdashboard (draait elke ~5 min in GitHub Actions).

  python fetch.py --state state --out site

--state  map die tussen runs bewaard blijft (historie, meetlocaties, borden)
--out    map die als website gepubliceerd wordt; data komt in <out>/data/

Gepubliceerde bestanden (in data/):
  state.json                 actuele reistijden + tijdstempels
  sites.json                 trajecten met weggeometrie
  hist/index.json            beschikbare dagen
  hist/<dag>/<bb>.json       reistijden per dag, verdeeld over buckets (per traject)
  tl/<dag>.json              doorstromingsklasse van alle trajecten per tijdstip (tijdbalk)
  msi.json, msi/<dag>.json   matrixborden actueel + wijzigingen per dag
  drips.json, drip/<dag>.json, drip/img/<hash>.png   DRIP's actueel + wijzigingen + beelden
  signs/...                  verkeersborden (tegels)
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone

import ndw
import ov

HIST_BUCKETS = 32
SIGN_TILE = 0.02  # graden; tegels voor verkeersborden


def log(*a):
    print(datetime.now(timezone.utc).strftime("%H:%M:%S"), *a, flush=True)


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def epoch(iso):
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())
    except Exception:
        return int(time.time())


def day_of(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")


def bucket(sid):
    h = 0
    for ch in sid:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % HIST_BUCKETS


def flow_class(d, ref):
    if d is None:
        return "."
    if not ref:
        return "-"
    r = d / ref
    return "0" if r < 1.25 else "1" if r < 1.75 else "2"


def lane_code(d):
    """Compacte code voor één rijstrookbeeld (zie web/app.js: decodeLane)."""
    if not d:
        return "?"
    k = d.get("k")
    c = {"speedlimit": "s" + str(d.get("v", "")) + ("r" if d.get("r") else ""),
         "lane_closed": "x",
         "lane_closed_ahead": "<" if d.get("s") == "merge_left" else ">",
         "lane_open": "o", "restriction_end": "e", "blank": "b"}.get(k, "?")
    return c + ("*" if d.get("f") else "")


def portal_code(p):
    return ";".join(f"{l['n']}={lane_code(l['d'])}" for l in p["lanes"])


class Builder:
    def __init__(self, a):
        self.a = a
        self.center = tuple(a.center) if a.center else ndw.BRIDGE
        self.tmp = tempfile.mkdtemp(prefix="ndw-")
        # gepubliceerde bestanden staan in state/pub, zodat bij een mislukte stap
        # de vorige versie blijft staan; aan het eind gaat alles naar <out>/data
        self.data = os.path.join(a.state, "pub")
        os.makedirs(self.data, exist_ok=True)
        self.errors = {}
        self.times = {}
        self.now = time.time()
        self.cutoff_day = day_of(self.now - a.history_days * 86400)

    def dl(self, url):
        path = os.path.join(self.tmp, url.rsplit("/", 1)[-1])
        size = ndw.download(url, path, timeout=900)
        log(f"{url.rsplit('/', 1)[-1]}: {size/1e6:.1f} MB")
        return path

    def stale(self, t, hours):
        return not t or self.now - t > hours * 3600

    def prune_days(self, folder, is_dir=False):
        """Verwijder dagbestanden ouder dan de bewaartermijn."""
        if not os.path.isdir(folder):
            return
        for n in os.listdir(folder):
            day = n[:10]
            if len(day) == 10 and day[4] == "-" and day < self.cutoff_day:
                p = os.path.join(folder, n)
                shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)

    # ---------------------------------------------------------------- trajecten
    def load_sites(self, data):
        a, st = self.a, self.a.state
        sites_f = os.path.join(st, "sites.json")
        sc = load(sites_f, {})
        if (self.stale(sc.get("time"), a.mst_hours) or sc.get("center") != list(self.center)
                or sc.get("radius") != a.radius or not sc.get("sites") or sc.get("v") != 2):
            mst = self.mst_path = self.dl(ndw.MST_URL)
            sites, seen, no_geo = ndw.parse_mst(mst, set(data), self.center, a.radius)
            log(f"meetlocaties: {seen} herkend, {no_geo} zonder ligging, {len(sites)} binnen {a.radius} km")
            try:
                geo = ndw.read_meetvakken(self.dl(ndw.MEETVAKKEN_URL), set(sites))
                for sid, g in geo.items():
                    if len(g["coords"]) >= 2:
                        sites[sid]["coords"] = ndw.simplify(g["coords"])
                        if g["length"]:
                            sites[sid]["length"] = round(g["length"])
                            sites[sid]["lengthSrc"] = "NDW"
                        sites[sid]["geom"] = 1
                log(f"weggeometrie: {len(geo)} van {len(sites)} trajecten")
            except Exception as e:
                traceback.print_exc()
                self.errors["weggeometrie"] = f"{type(e).__name__}: {e}"
            sc = {"v": 2, "time": self.now, "center": list(self.center), "radius": a.radius, "sites": sites}
            dump(sites_f, sc)
        return sc["sites"]

    def traveltime(self):
        a, st = self.a, self.a.state
        pub, data = ndw.parse_traveltime(self.dl(ndw.TRAVELTIME_URL))
        log(f"reistijden: {len(data)} trajecten, publicatie {pub}")
        sites = self.load_sites(data)
        ids = sorted(sites)

        # referentie per traject: NDW-referentie, anders snelste ooit gemeten
        refs_f = os.path.join(st, "refs.json")
        refs = load(refs_f, {})
        for sid in ids:
            v = data.get(sid) or {}
            if v.get("ref"):
                refs[sid] = {"r": v["ref"], "src": "ndw"}
            elif v.get("d") and (sid not in refs or (refs[sid]["src"] == "best" and v["d"] < refs[sid]["r"])):
                refs[sid] = {"r": v["d"], "src": "best"}
        dump(refs_f, refs)

        # dagbestand (werkkopie in state/hday)
        t = epoch(pub) if pub else int(self.now)
        day = day_of(t)
        hdir = os.path.join(st, "hday")
        self.migrate_old_history(hdir)
        hf = os.path.join(hdir, day + ".json")
        h = load(hf, {"times": [], "sites": {}})
        T = h["times"]
        new_step = not T or t > T[-1]
        if new_step:
            T.append(t)
            for sid in ids:
                v = (data.get(sid) or {}).get("d")
                arr = h["sites"].setdefault(sid, [])
                if len(arr) < len(T) - 1:
                    arr.extend([None] * (len(T) - 1 - len(arr)))
                arr.append(int(round(v * 10)) if v is not None else None)
            for sid, arr in h["sites"].items():
                if len(arr) < len(T):
                    arr.extend([None] * (len(T) - len(arr)))
            dump(hf, h)
        for n in os.listdir(hdir):  # alleen vandaag als werkkopie bewaren
            if n.endswith(".json") and n[:10] < day:
                os.remove(os.path.join(hdir, n))

        # publiceren: buckets + tijdlijn van vandaag
        if new_step or not os.path.exists(os.path.join(self.data, "tl", day + ".json")):
            self.publish_day(day, h, refs)
        self.prune_days(os.path.join(self.data, "hist"))
        self.prune_days(os.path.join(self.data, "tl"))
        days = sorted(n[:10] for n in os.listdir(os.path.join(self.data, "tl")) if n.endswith(".json"))
        dump(os.path.join(self.data, "hist", "index.json"), {"days": days, "buckets": HIST_BUCKETS})

        dump(os.path.join(self.data, "sites.json"),
             {"sites": sites, "center": list(self.center), "radius": a.radius})
        state = {}
        for sid in ids:
            v = data.get(sid)
            if not v:
                continue
            r = refs.get(sid) or {}
            state[sid] = {"d": v["d"], "ref": v["ref"], "best": r.get("r") if r.get("src") == "best" else None}
        self.state_data = state
        self.pub = pub
        self.times["traveltime"] = self.now

    def publish_day(self, day, h, refs):
        T = h["times"]
        buckets = {}
        for sid, arr in h["sites"].items():
            if any(x is not None for x in arr):
                buckets.setdefault(bucket(sid), {})[sid] = arr
        for b in range(HIST_BUCKETS):
            dump(os.path.join(self.data, "hist", day, f"{b:02d}.json"), {"times": T, "sites": buckets.get(b, {})})
        ids = sorted(h["sites"])
        rows = []
        for i in range(len(T)):
            rows.append("".join(
                flow_class(h["sites"][sid][i] / 10 if h["sites"][sid][i] is not None else None,
                           (refs.get(sid) or {}).get("r"))
                for sid in ids))
        dump(os.path.join(self.data, "tl", day + ".json"), {"sites": ids, "times": T, "rows": rows})

    def migrate_old_history(self, hdir):
        """Eenmalig: oude history.json (één bestand) omzetten naar dagbestanden."""
        old = os.path.join(self.a.state, "history.json")
        if not os.path.exists(old):
            return
        h = load(old, {"times": [], "sites": {}})
        refs = load(os.path.join(self.a.state, "refs.json"), {})
        per_day = {}
        for i, t in enumerate(h.get("times", [])):
            per_day.setdefault(day_of(t), []).append(i)
        for day, idx in per_day.items():
            dh = {"times": [h["times"][i] for i in idx],
                  "sites": {sid: [arr[i] if i < len(arr) else None for i in idx] for sid, arr in h["sites"].items()}}
            for sid, arr in dh["sites"].items():
                vals = [x / 10 for x in arr if x is not None]
                if vals and sid not in refs:
                    refs[sid] = {"r": min(vals), "src": "best"}
            if day >= self.cutoff_day:
                self.publish_day(day, dh, refs)
            os.makedirs(hdir, exist_ok=True)
            dump(os.path.join(hdir, day + ".json"), dh)
        dump(os.path.join(self.a.state, "refs.json"), refs)
        hpub = os.path.join(self.data, "hist")
        if os.path.isdir(hpub):
            for n in os.listdir(hpub):
                if n.endswith(".json") and n != "index.json":   # oude bucketbestanden (vorige versie)
                    os.remove(os.path.join(hpub, n))
        os.remove(old)
        log(f"oude historie omgezet naar {len(per_day)} dagbestanden")

    # ---------------------------------------------------------------- MSI
    def msi(self):
        st = self.a.state
        lf = os.path.join(st, "msi_locs.json")
        lc = load(lf, {})
        if self.stale(lc.get("time"), self.a.mst_hours) or not lc.get("locs"):
            locs = ndw.read_msi_shapefile(self.dl(ndw.MSI_SHP_URL))
            lc = {"time": self.now, "locs": locs}
            dump(lf, lc)
        signs = ndw.parse_msi(self.dl(ndw.MSI_URL))
        portals = ndw.build_portals(signs, lc["locs"], self.center, self.a.radius)
        dump(os.path.join(self.data, "msi.json"), {"time": self.now, "portals": portals})

        # wijzigingen per dag (voor de tijdbalk)
        meta_f = os.path.join(self.data, "msi", "meta.json")
        meta = load(meta_f, {})
        codes = {}
        for p in portals:
            meta[p["k"]] = {k: p[k] for k in ("road", "cw", "km", "lat", "lon", "bearing")}
            codes[p["k"]] = portal_code(p)
        dump(meta_f, meta)
        self.record_changes(os.path.join(self.data, "msi"), "msi_last.json", codes)
        log(f"MSI: {len(portals)} portalen")
        self.times["msi"] = self.now

    def record_changes(self, folder, last_name, current):
        """Schrijf alleen wat veranderd is t.o.v. de vorige run naar <folder>/<dag>.json."""
        day = day_of(self.now)
        last_f = os.path.join(self.a.state, last_name)
        last = load(last_f, {})
        df = os.path.join(folder, day + ".json")
        d = load(df, {"steps": []})
        if not d["steps"]:
            changes = dict(current)              # eerste stap van de dag: volledige stand
        else:
            changes = {k: v for k, v in current.items() if last.get(k) != v}
            changes.update({k: None for k in last if k not in current})
        if changes or not d["steps"]:
            d["steps"].append([int(self.now), changes])
            dump(df, d)
        dump(last_f, current)
        self.prune_days(folder)

    # ---------------------------------------------------------------- DRIP
    def drips(self):
        drips, imgs = ndw.parse_drips(self.dl(ndw.DRIP_URL), self.center, self.a.radius)
        imgdir = os.path.join(self.data, "drip", "img")
        os.makedirs(imgdir, exist_ok=True)
        for n in os.listdir(os.path.join(self.data, "drip")):   # beelden van de vorige versie
            if n.endswith(".png"):
                os.remove(os.path.join(self.data, "drip", n))
        current = {}
        for cid, d in drips.items():
            hs = []
            for b in imgs.get(cid, []):
                hsh = hashlib.sha1(b).hexdigest()[:16]
                p = os.path.join(imgdir, hsh + ".png")
                if not os.path.exists(p):
                    with open(p, "wb") as f:
                        f.write(b)
                hs.append(hsh)
            d["img"] = hs
            d["active"] = bool(any(ndw.image_has_content(b) for b in imgs.get(cid, []))
                               or any(t.strip() for t in d.get("text") or []))
            current[cid] = {"i": hs, "x": d.get("text") or [], "w": d.get("working"), "a": 1 if d["active"] else 0}
        dump(os.path.join(self.data, "drips.json"), {"time": self.now, "drips": list(drips.values())})
        meta_f = os.path.join(self.data, "drip", "meta.json")
        meta = load(meta_f, {})
        for cid, d in drips.items():
            meta[cid] = {k: d[k] for k in ("name", "lat", "lon", "bearing")}
        dump(meta_f, meta)
        self.record_changes(os.path.join(self.data, "drip"), "drip_last.json", current)

        # beelden opruimen die nergens meer naar verwezen worden
        used = set(h for v in current.values() for h in v["i"])
        folder = os.path.join(self.data, "drip")
        for n in os.listdir(folder):
            if n.endswith(".json") and n[:4].isdigit():
                for _, ch in load(os.path.join(folder, n), {"steps": []})["steps"]:
                    for v in ch.values():
                        if v:
                            used.update(v["i"])
        for n in os.listdir(imgdir):
            if n[:-4] not in used:
                os.remove(os.path.join(imgdir, n))
        log(f"DRIP's: {len(drips)} ({sum(1 for d in drips.values() if d['active'])} met boodschap), "
            f"beelden: {len(os.listdir(imgdir))}")
        self.times["drip"] = self.now


    # ---------------------------------------------------------------- lusdetectie
    def loops(self):
        a, st = self.a, self.a.state
        vals = ndw.parse_measured(self.dl(ndw.TRAFFICSPEED_URL))
        sf = os.path.join(st, "loop_sites.json")
        sc = load(sf, {})
        if (self.stale(sc.get("time"), a.mst_hours) or sc.get("radius") != a.loop_radius
                or sc.get("center") != list(self.center) or not sc.get("sites")):
            mst = getattr(self, "mst_path", None) or self.dl(ndw.MST_URL)
            sites = ndw.parse_loop_sites(mst, set(vals), self.center, a.loop_radius)
            sc = {"time": self.now, "center": list(self.center), "radius": a.loop_radius, "sites": sites}
            dump(sf, sc)
            log(f"lussen: {len(sites)} meetpunten binnen {a.loop_radius} km")
        sites = sc["sites"]
        now = {sid: ndw.summarize_loop(site, vals[sid]) for sid, site in sites.items() if sid in vals}
        # referentiesnelheid per meetpunt: hoogste recente snelheid, langzaam uitdovend
        rf = os.path.join(st, "loop_refs.json")
        refs = load(rf, {})
        for sid, v in now.items():
            sp = v.get("s")
            if sp and (v.get("f") or 0) > 0:
                old = refs.get(sid, 0) * 0.998
                refs[sid] = round(max(old, min(sp, 130)), 1)
        dump(rf, refs)
        meta = {sid: {k: site[k] for k in ("name", "lat", "lon", "lanes", "side", "dist")} for sid, site in sites.items()}
        dump(os.path.join(self.data, "loops", "sites.json"), {"time": sc["time"], "sites": meta})
        dump(os.path.join(self.data, "loops", "now.json"), {"time": self.now, "now": now, "ref": refs})
        # historie: per dag, per bucket {id: [[snelheid, intensiteit], ...]} + klassenregel per tijdstip
        t = int(self.now // 60 * 60)
        day = day_of(t)
        hf = os.path.join(st, "lday", day + ".json")
        h = load(hf, {"times": [], "sites": {}})
        if not h["times"] or t - h["times"][-1] >= 240:
            h["times"].append(t)
            n = len(h["times"])
            for sid in sites:
                v = now.get(sid) or {}
                arr = h["sites"].setdefault(sid, [])
                arr.extend([None] * (n - 1 - len(arr)))
                arr.append([v.get("s"), v.get("f")] if (v.get("s") is not None or v.get("f") is not None) else None)
            dump(hf, h)
            ids = sorted(h["sites"])
            buckets = {}
            for sid in ids:
                buckets.setdefault(bucket(sid), {})[sid] = h["sites"][sid] + [None] * (n - len(h["sites"][sid]))
            for b in range(HIST_BUCKETS):
                dump(os.path.join(self.data, "lhist", day, f"{b:02d}.json"), {"times": h["times"], "sites": buckets.get(b, {})})
            rows = []
            for i in range(n):
                row = []
                for sid in ids:
                    arr = h["sites"][sid]
                    v = arr[i] if i < len(arr) else None
                    sp, ref = (v or [None])[0], refs.get(sid)
                    row.append("." if sp is None else "-" if not ref else
                               "0" if sp / ref >= 0.75 else "1" if sp / ref >= 0.5 else "2")
                rows.append("".join(row))
            dump(os.path.join(self.data, "ltl", day + ".json"), {"sites": ids, "times": h["times"], "rows": rows})
        os.makedirs(os.path.join(st, "lday"), exist_ok=True)
        for n_ in os.listdir(os.path.join(st, "lday")):
            if n_[:10] < day:
                os.remove(os.path.join(st, "lday", n_))
        self.prune_days(os.path.join(self.data, "lhist"))
        self.prune_days(os.path.join(self.data, "ltl"))
        days = sorted(n_[:10] for n_ in os.listdir(os.path.join(self.data, "ltl")) if n_.endswith(".json"))
        dump(os.path.join(self.data, "lhist", "index.json"), {"days": days, "buckets": HIST_BUCKETS})
        log(f"lussen: {len(now)} met meting")
        self.times["loops"] = self.now

    # ---------------------------------------------------------------- situaties (actueel beeld)
    def situations(self):
        sits = ndw.parse_situations(self.dl(ndw.ACTUEEL_URL), self.center, self.a.radius)
        dump(os.path.join(self.data, "sit.json"), {"time": self.now, "sits": sits})
        self.record_changes(os.path.join(self.data, "sit"), "sit_last.json", {x["id"]: x for x in sits})
        log(f"situaties: {len(sits)} in gebied")
        self.times["sit"] = self.now

    # ---------------------------------------------------------------- planning werkzaamheden / evenementen / brugopeningen
    def planning(self):
        pf = os.path.join(self.data, "planning.json")
        cur = load(pf, {})
        if not self.stale(cur.get("time"), self.a.planning_hours):
            self.times["planning"] = cur["time"]
            return
        items = ndw.parse_situations(self.dl(ndw.PLANNING_URL), self.center, self.a.radius)
        for x in items:
            x["src"] = "werk"
        try:
            br = ndw.parse_situations(self.dl(ndw.BRUG_URL), self.center, self.a.radius)
            for x in br:
                x["src"] = "brug"
            items += br
        except Exception as e:
            traceback.print_exc()
            self.errors["brugopeningen"] = f"{type(e).__name__}: {e}"
        cutoff = datetime.fromtimestamp(self.now - 86400, timezone.utc).isoformat()
        def end_of(x):
            ens = [r.get("en") for r in x["r"]]
            return None if (not ens or any(e is None for e in ens)) else max(ens)
        items = [x for x in items if (end_of(x) or "9999") >= cutoff]
        dump(pf, {"time": self.now, "items": items})
        log(f"planning: {len(items)} items in gebied")
        self.times["planning"] = self.now

    # ---------------------------------------------------------------- OV
    def ov(self):
        a, st = self.a, self.a.state
        sf = os.path.join(st, "ov_static.json")
        sc = load(sf, {})
        if (self.stale(sc.get("time"), 24) or sc.get("center") != list(self.center)
                or sc.get("radius") != a.ov_radius):
            path = os.path.join(self.tmp, "gtfs-nl.zip")
            size = ov.download(ov.GTFS_URL, path)
            log(f"gtfs-nl.zip: {size/1e6:.0f} MB")
            res = ov.build_static(path, self.center, a.ov_radius, simplify=ndw.simplify, log=log)
            os.remove(path)
            sc = {"time": self.now, "center": list(self.center), "radius": a.ov_radius, **res}
            dump(sf, sc)
            dump(os.path.join(self.data, "ov", "net.json"), {"time": self.now, "routes": res["routes"], "stops": res["stops"]})
        trips = sc.get("trips", {})
        vp = os.path.join(self.tmp, "vehiclePositions.pb")
        ov.download(ov.VEH_URL, vp, timeout=120)
        with open(vp, "rb") as f:
            ts, veh = ov.parse_vehicles(f.read(), self.center, a.ov_radius)
        rows = []
        for v in veh:
            rid = v["route"] or (trips.get(v["trip"]) or [None])[0]
            head = (trips.get(v["trip"]) or [None, None])[1]
            rows.append([rid, v["lat"], v["lon"], v["delay"], head, v["label"], v["status"], v["t"], v["brg"]])
        dump(os.path.join(self.data, "ov", "veh.json"), {"time": self.now, "feed": ts, "v": rows})
        # historie (beperkt aantal dagen: posities zijn een momentopname per run)
        day = day_of(self.now)
        df = os.path.join(self.data, "ovh", day + ".json")
        d = load(df, {"steps": []})
        d["steps"].append([int(self.now), [[r[0], r[1], r[2], r[3]] for r in rows]])
        dump(df, d)
        keep = day_of(self.now - a.ov_history_days * 86400)
        for n_ in os.listdir(os.path.dirname(df)):
            if n_[:10] < keep:
                os.remove(os.path.join(os.path.dirname(df), n_))
        try:
            ap = os.path.join(self.tmp, "alerts.pb")
            ov.download(ov.ALERTS_URL, ap, timeout=120)
            with open(ap, "rb") as f:
                al = ov.parse_alerts(f.read(), set(sc["routes"]), {s["id"] for s in sc["stops"]})
            dump(os.path.join(self.data, "ov", "alerts.json"), {"time": self.now, "alerts": al})
        except Exception as e:
            traceback.print_exc()
            self.errors["ov-meldingen"] = f"{type(e).__name__}: {e}"
        log(f"OV: {len(rows)} voertuigen in gebied")
        self.times["ov"] = self.now

    # ---------------------------------------------------------------- borden
    def signs(self):
        a = self.a
        sd = os.path.join(a.state, "signs")
        meta = load(os.path.join(sd, "meta.json"), {})
        if (self.stale(meta.get("time"), a.signs_days * 24) or meta.get("center") != list(self.center)
                or meta.get("radius") != a.radius):
            log("verkeersborden: landelijk bestand downloaden (groot)")
            items = ndw.parse_signs(self.dl(ndw.SIGNS_URL), self.center, a.radius)
            shutil.rmtree(sd, ignore_errors=True)
            tiles, cats = {}, {}
            for s in items:
                k = f"{int(s['lat'] // SIGN_TILE)}_{int(s['lon'] // SIGN_TILE)}"
                tiles.setdefault(k, []).append(s)
                c = (s["rvvCode"] or "?")[:1]
                cats[c] = cats.get(c, 0) + 1
            for k, v in tiles.items():
                dump(os.path.join(sd, "t", k + ".json"), v)
            meta = {"time": self.now, "center": list(self.center), "radius": a.radius,
                    "tile": SIGN_TILE, "tiles": sorted(tiles), "cats": cats, "count": len(items)}
            dump(os.path.join(sd, "meta.json"), meta)
            log(f"verkeersborden: {len(items)} in {len(tiles)} tegels")
        self.times["signs"] = meta["time"]

    # ---------------------------------------------------------------- alles
    def run(self):
        self.state_data, self.pub = {}, None
        steps = [("reistijden", self.traveltime), ("lussen", self.loops), ("matrixborden", self.msi),
                 ("drips", self.drips), ("situaties", self.situations), ("planning", self.planning)]
        if not self.a.no_ov:
            steps.append(("ov", self.ov))
        if not self.a.no_signs:
            steps.append(("verkeersborden", self.signs))
        for name, fn in steps:
            try:
                fn()
            except Exception as e:
                traceback.print_exc()
                self.errors[name] = f"{type(e).__name__}: {e}"
        prev = load(os.path.join(self.data, "state.json"), {})
        dump(os.path.join(self.data, "state.json"), {
            "generated": self.now,
            "publicationTime": self.pub or prev.get("publicationTime"),
            "lastFetch": self.times.get("traveltime", prev.get("lastFetch")),
            "msiTime": self.times.get("msi", prev.get("msiTime")),
            "dripTime": self.times.get("drip", prev.get("dripTime")),
            "signsTime": self.times.get("signs", prev.get("signsTime")),
            "loopsTime": self.times.get("loops", prev.get("loopsTime")),
            "sitTime": self.times.get("sit", prev.get("sitTime")),
            "planningTime": self.times.get("planning", prev.get("planningTime")),
            "ovTime": self.times.get("ov", prev.get("ovTime")),
            "errors": self.errors,
            "siteCount": len(self.state_data or prev.get("data", {})),
            "data": self.state_data or prev.get("data", {}),
            "historyDays": self.a.history_days,
            "buckets": HIST_BUCKETS,
        })
        out = os.path.join(self.a.out, "data")
        shutil.rmtree(out, ignore_errors=True)
        shutil.copytree(self.data, out)
        sd = os.path.join(self.a.state, "signs")
        if os.path.isdir(sd):
            shutil.copytree(sd, os.path.join(out, "signs"))
        shutil.rmtree(self.tmp, ignore_errors=True)
        log("klaar" + (f" met fouten: {', '.join(self.errors)}" if self.errors else ""))
        # alleen falen als er nog nooit reistijden gepubliceerd zijn
        return 1 if not os.path.exists(os.path.join(out, "sites.json")) else 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--state", default="state")
    p.add_argument("--out", default="site")
    p.add_argument("--radius", type=float, default=float(os.environ.get("RADIUS_KM", 35)))
    p.add_argument("--center", type=float, nargs=2)
    p.add_argument("--history-days", type=float, default=float(os.environ.get("HISTORY_DAYS", 14)))
    p.add_argument("--mst-hours", type=float, default=24)
    p.add_argument("--signs-days", type=float, default=7)
    p.add_argument("--no-signs", action="store_true")
    p.add_argument("--no-ov", action="store_true")
    p.add_argument("--loop-radius", type=float, default=float(os.environ.get("LOOP_RADIUS_KM", 8)))
    p.add_argument("--ov-radius", type=float, default=float(os.environ.get("OV_RADIUS_KM", 8)))
    p.add_argument("--ov-history-days", type=float, default=float(os.environ.get("OV_HISTORY_DAYS", 3)))
    p.add_argument("--planning-hours", type=float, default=1)
    a = p.parse_args()
    os.makedirs(a.state, exist_ok=True)
    sys.exit(Builder(a).run())


if __name__ == "__main__":
    main()
