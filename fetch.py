#!/usr/bin/env python3
"""
Bouwt de data voor het verkeersdashboard (draait elke ~5 min in GitHub Actions).

  python fetch.py --state state --out site

--state  map die tussen runs bewaard blijft (historie, meetlocaties, borden)
--out    map die als website gepubliceerd wordt; data komt in <out>/data/
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
from datetime import datetime

import ndw

HIST_BUCKETS = 64
SIGN_TILE = 0.02  # graden; tegels voor verkeersborden


def log(*a):
    print(datetime.utcnow().strftime("%H:%M:%S"), *a, flush=True)


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


def bucket(sid):
    h = 0
    for ch in sid:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % HIST_BUCKETS


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

    def dl(self, url):
        path = os.path.join(self.tmp, url.rsplit("/", 1)[-1])
        size = ndw.download(url, path, timeout=900)
        log(f"{url.rsplit('/', 1)[-1]}: {size/1e6:.1f} MB")
        return path

    def stale(self, t, hours):
        return not t or time.time() - t > hours * 3600

    # ---------------------------------------------------------------- reistijden
    def traveltime(self):
        a, st = self.a, self.a.state
        tt = self.dl(ndw.TRAVELTIME_URL)
        pub, data = ndw.parse_traveltime(tt)
        log(f"reistijden: {len(data)} trajecten, publicatie {pub}")

        sites_f = os.path.join(st, "sites.json")
        sc = load(sites_f, {})
        if (self.stale(sc.get("time"), a.mst_hours) or sc.get("center") != list(self.center)
                or sc.get("radius") != a.radius or not sc.get("sites")):
            mst = self.dl(ndw.MST_URL)
            sites, seen, no_geo = ndw.parse_mst(mst, set(data), self.center, a.radius)
            log(f"meetlocaties: {seen} herkend, {no_geo} zonder ligging, {len(sites)} binnen {a.radius} km")
            sc = {"time": time.time(), "center": list(self.center), "radius": a.radius, "sites": sites}
            dump(sites_f, sc)
        sites = sc["sites"]

        # historie: gedeelde tijdas + per traject deciseconden
        hf = os.path.join(st, "history.json")
        h = load(hf, {"times": [], "sites": {}})
        t = epoch(pub) if pub else int(time.time())
        T = h["times"]
        if not T or t > T[-1]:
            T.append(t)
            for sid in sites:
                v = data.get(sid, {}).get("d")
                arr = h["sites"].setdefault(sid, [])
                if len(arr) < len(T) - 1:
                    arr.extend([None] * (len(T) - 1 - len(arr)))
                arr.append(int(round(v * 10)) if v is not None else None)
        cutoff = time.time() - a.history_days * 86400
        drop = 0
        while drop < len(T) and T[drop] < cutoff:
            drop += 1
        if drop:
            h["times"] = T = T[drop:]
            for sid in list(h["sites"]):
                h["sites"][sid] = h["sites"][sid][drop:]
        for sid in list(h["sites"]):
            if sid not in sites or not any(x is not None for x in h["sites"][sid]):
                del h["sites"][sid]
        dump(hf, h)

        # publiceren
        dump(os.path.join(self.data, "sites.json"),
             {"sites": sites, "center": list(self.center), "radius": a.radius})
        buckets = {}
        for sid, arr in h["sites"].items():
            buckets.setdefault(bucket(sid), {})[sid] = arr
        for b in range(HIST_BUCKETS):
            dump(os.path.join(self.data, "hist", f"{b:02d}.json"), {"times": T, "sites": buckets.get(b, {})})

        state = {}
        for sid in sites:
            v = data.get(sid)
            if not v:
                continue
            arr = [x for x in h["sites"].get(sid, []) if x is not None]
            state[sid] = {"d": v["d"], "ref": v["ref"], "best": (min(arr) / 10) if arr else None}
        self.state_data = state
        self.pub = pub
        self.times["traveltime"] = time.time()

    # ---------------------------------------------------------------- MSI
    def msi(self):
        st = self.a.state
        lf = os.path.join(st, "msi_locs.json")
        lc = load(lf, {})
        if self.stale(lc.get("time"), self.a.mst_hours) or not lc.get("locs"):
            locs = ndw.read_msi_shapefile(self.dl(ndw.MSI_SHP_URL))
            lc = {"time": time.time(), "locs": locs}
            dump(lf, lc)
        signs = ndw.parse_msi(self.dl(ndw.MSI_URL))
        portals = ndw.build_portals(signs, lc["locs"], self.center, self.a.radius)
        dump(os.path.join(self.data, "msi.json"), {"time": time.time(), "portals": portals})
        log(f"MSI: {len(portals)} portalen")
        self.times["msi"] = time.time()

    # ---------------------------------------------------------------- DRIP
    def drips(self):
        drips, imgs = ndw.parse_drips(self.dl(ndw.DRIP_URL), self.center, self.a.radius)
        d = os.path.join(self.data, "drip")
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        for cid, lst in imgs.items():
            safe = re.sub(r"[^A-Za-z0-9_-]", "_", cid)
            names = []
            for i, b in enumerate(lst):
                n = f"{safe}-{i}.png"
                with open(os.path.join(d, n), "wb") as f:
                    f.write(b)
                names.append(n)
            drips[cid]["img"] = names
        dump(os.path.join(self.data, "drips.json"), {"time": time.time(), "drips": list(drips.values())})
        log(f"DRIP's: {len(drips)}")
        self.times["drip"] = time.time()

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
            meta = {"time": time.time(), "center": list(self.center), "radius": a.radius,
                    "tile": SIGN_TILE, "tiles": sorted(tiles), "cats": cats, "count": len(items)}
            dump(os.path.join(sd, "meta.json"), meta)
            log(f"verkeersborden: {len(items)} in {len(tiles)} tegels")
        self.times["signs"] = meta["time"]

    # ---------------------------------------------------------------- alles
    def run(self):
        self.state_data, self.pub = {}, None
        steps = [("reistijden", self.traveltime), ("matrixborden", self.msi), ("drips", self.drips)]
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
            "generated": time.time(),
            "publicationTime": self.pub or prev.get("publicationTime"),
            "lastFetch": self.times.get("traveltime", prev.get("lastFetch")),
            "msiTime": self.times.get("msi", prev.get("msiTime")),
            "dripTime": self.times.get("drip", prev.get("dripTime")),
            "signsTime": self.times.get("signs", prev.get("signsTime")),
            "errors": self.errors,
            "siteCount": len(self.state_data or prev.get("data", {})),
            "data": self.state_data or prev.get("data", {}),
            "historyDays": self.a.history_days,
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
    p.add_argument("--radius", type=float, default=float(os.environ.get("RADIUS_KM", 12)))
    p.add_argument("--center", type=float, nargs=2)
    p.add_argument("--history-days", type=float, default=float(os.environ.get("HISTORY_DAYS", 14)))
    p.add_argument("--mst-hours", type=float, default=24)
    p.add_argument("--signs-days", type=float, default=7)
    p.add_argument("--no-signs", action="store_true")
    a = p.parse_args()
    os.makedirs(a.state, exist_ok=True)
    sys.exit(Builder(a).run())


if __name__ == "__main__":
    main()
