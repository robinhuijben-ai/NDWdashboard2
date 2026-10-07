"""OV-data voor het dashboard (alleen standaardbibliotheek).

Bronnen (OpenOV / OVapi, open data, best effort):
  http://gtfs.ovapi.nl/nl/gtfs-nl.zip            dienstregeling NL (GTFS, dagelijks ververst)
  http://gtfs.ovapi.nl/nl/vehiclePositions.pb    voertuigposities + vertraging (GTFS-realtime, protobuf)
  http://gtfs.ovapi.nl/nl/alerts.pb              storingsmeldingen (GTFS-realtime)
Gebruiksvoorwaarden: User-Agent met contactgegevens, gzip accepteren, niet vaker dan nodig ophalen.
"""

import csv
import io
import math
import struct
import urllib.request
import zipfile

GTFS_URL = "http://gtfs.ovapi.nl/nl/gtfs-nl.zip"
VEH_URL = "http://gtfs.ovapi.nl/nl/vehiclePositions.pb"
ALERTS_URL = "http://gtfs.ovapi.nl/nl/alerts.pb"
USER_AGENT = "verkeersdashboard-brienenoord (GitHub Actions; zie repository README)"

ROUTE_TYPES = {0: "tram", 1: "metro", 2: "trein", 3: "bus", 4: "veer", 5: "kabelbaan", 6: "gondel", 7: "kabelspoor"}
EFFECTS = {1: "geen dienst", 2: "minder ritten", 3: "flinke vertraging", 4: "omleiding", 5: "extra ritten",
           6: "aangepaste dienst", 7: "anders", 8: "onbekend", 9: "halte verplaatst"}
CAUSES = {1: "onbekend", 2: "anders", 3: "technisch", 4: "staking", 5: "demonstratie", 6: "ongeval", 7: "feestdag",
          8: "weer", 9: "onderhoud", 10: "werkzaamheden", 11: "politie", 12: "medisch"}


def route_kind(t):
    try:
        t = int(t)
    except (TypeError, ValueError):
        return "bus"
    if t in ROUTE_TYPES:
        return ROUTE_TYPES[t]
    # uitgebreide GTFS-typen (100 trein, 400 metro, 700 bus, 900 tram, 1000/1200 veer)
    return {1: "trein", 4: "metro", 7: "bus", 9: "tram", 10: "veer", 12: "veer"}.get(t // 100, "bus")


def _dist_km(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def download(url, dest, timeout=60, deadline=600):
    import time as _t
    t0 = _t.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=min(timeout, deadline)) as r, open(dest + ".part", "wb") as f:
        import zlib
        dec = zlib.decompressobj(16 + zlib.MAX_WBITS) if r.headers.get("Content-Encoding") == "gzip" else None
        while True:
            chunk = r.read1(1 << 20)          # read1: wacht niet op een volle MB
            if not chunk:
                break
            f.write(dec.decompress(chunk) if dec else chunk)
            if _t.monotonic() - t0 > deadline:
                raise TimeoutError(f"download duurde langer dan {deadline}s: {url.rsplit('/', 1)[-1]}")
        if dec:
            f.write(dec.flush())
    import os
    os.replace(dest + ".part", dest)
    return os.path.getsize(dest)


# ---------------------------------------------------------------- protobuf (minimaal)

def pb_decode(buf, start=0, end=None):
    """Generieke protobuf-decoder: {veldnummer: [waarde, ...]}; berichten/strings als (start, end)."""
    if end is None:
        end = len(buf)
    out = {}
    i = start
    while i < end:
        key, shift = 0, 0
        while True:
            b = buf[i]; i += 1
            key |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        field, wt = key >> 3, key & 7
        if wt == 0:
            v, shift = 0, 0
            while True:
                b = buf[i]; i += 1
                v |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
        elif wt == 1:
            v = struct.unpack_from("<d", buf, i)[0]; i += 8
        elif wt == 5:
            v = struct.unpack_from("<f", buf, i)[0]; i += 4
        elif wt == 2:
            L, shift = 0, 0
            while True:
                b = buf[i]; i += 1
                L |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            v = (i, i + L); i += L
        else:
            raise ValueError(f"onbekend wire type {wt}")
        out.setdefault(field, []).append(v)
    return out


def _s(buf, r):
    return bytes(buf[r[0]:r[1]]).decode("utf-8", "replace")


def _sint32(v):
    """int32 als varint (negatief = 10 bytes two's complement)."""
    v &= 0xFFFFFFFFFFFFFFFF
    return v - (1 << 64) if v >= (1 << 63) else v


def _msg(buf, d, f):
    v = d.get(f)
    return pb_decode(buf, *v[0]) if v else {}


def _str(buf, d, f):
    v = d.get(f)
    return _s(buf, v[0]) if v else None


def _translated(buf, d, f):
    ts = _msg(buf, d, f)
    texts = {}
    for t in ts.get(1, []):
        x = pb_decode(buf, *t)
        texts[_str(buf, x, 2) or ""] = _str(buf, x, 1) or ""
    return texts.get("nl") or texts.get("") or next(iter(texts.values()), None)


def parse_vehicles(data, center, radius_km):
    """-> (feed_tijd, [voertuig]) binnen de straal."""
    fm = pb_decode(data)
    hdr = _msg(data, fm, 1)
    ts = hdr.get(3, [None])[0]
    out = []
    for r in fm.get(2, []):
        try:
            en = pb_decode(data, *r)
            if 4 not in en:
                continue
            vp = pb_decode(data, *en[4][0])
            pos = _msg(data, vp, 2)
            td = _msg(data, vp, 1)
            ext = _msg(data, vp, 1003)
            vd = _msg(data, vp, 8)
        except (ValueError, IndexError, struct.error):
            continue
        if 1 not in pos:
            continue
        lat, lon = pos[1][0], pos[2][0]
        if _dist_km(center, (lat, lon)) > radius_km:
            continue
        out.append({
            "trip": _str(data, td, 1), "route": _str(data, td, 5),
            "dir": td.get(6, [None])[0],
            "lat": round(lat, 5), "lon": round(lon, 5),
            "brg": round(pos[3][0]) if 3 in pos else None,
            "delay": _sint32(ext[1][0]) if 1 in ext else None,
            "label": _str(data, vd, 2) or _str(data, vd, 1),
            "status": vp.get(4, [None])[0], "stop": _str(data, vp, 7),
            "t": vp.get(5, [None])[0],
        })
    return ts, out


def parse_alerts(data, route_ids, stop_ids):
    """Storingsmeldingen die een lijn of halte in het gebied raken."""
    fm = pb_decode(data)
    out = []
    for r in fm.get(2, []):
        try:
            en = pb_decode(data, *r)
            if 5 not in en:
                continue
            al = pb_decode(data, *en[5][0])
            item = _alert(data, en, al, route_ids, stop_ids)
        except (ValueError, IndexError, struct.error):
            continue   # één onleesbare melding overslaan
        if item:
            out.append(item)
    return out


def _alert(data, en, al, route_ids, stop_ids):
    routes, stops = set(), set()
    for ie in al.get(5, []):
        d = pb_decode(data, *ie)
        rid, sid = _str(data, d, 2), _str(data, d, 5)
        if rid:
            routes.add(rid)
        if sid:
            stops.add(sid)
    hit_r, hit_s = routes & route_ids, stops & stop_ids
    # met haltes: alleen als er een halte in het gebied ligt; zonder haltes: op lijn
    if (stops and not hit_s) or (not stops and not hit_r):
        return None
    periods = []
    for p in al.get(1, []):
        d = pb_decode(data, *p)
        periods.append([d.get(1, [None])[0], d.get(2, [None])[0]])
    return {
        "id": _str(data, en, 1), "head": _translated(data, al, 10), "desc": _translated(data, al, 11),
        "cause": CAUSES.get(al.get(6, [None])[0]), "effect": EFFECTS.get(al.get(7, [None])[0]),
        "routes": sorted(hit_r), "stops": sorted(hit_s), "per": periods[:10],
    }


# ---------------------------------------------------------------- GTFS statisch

def _reader(z, name):
    f = z.open(name)
    return csv.reader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


def build_static(zip_path, center, radius_km, shape_margin_km=2.0, simplify=None, log=print):
    """Haltes binnen de straal, lijnen die er stoppen, lijnvormen (geknipt rond het gebied)."""
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())
        # haltes
        rd = _reader(z, "stops.txt"); h = next(rd); ix = {k: i for i, k in enumerate(h)}
        stops = {}
        for row in rd:
            try:
                lat, lon = float(row[ix["stop_lat"]]), float(row[ix["stop_lon"]])
            except (ValueError, IndexError):
                continue
            if _dist_km(center, (lat, lon)) <= radius_km:
                lt = row[ix["location_type"]] if "location_type" in ix else ""
                if lt not in ("", "0"):
                    continue   # stations/ingangen overslaan; perrons/haltes houden
                stops[row[ix["stop_id"]]] = {"id": row[ix["stop_id"]], "n": row[ix["stop_name"]],
                                             "lat": round(lat, 6), "lon": round(lon, 6), "r": set(),
                                             "code": row[ix["stop_code"]] if "stop_code" in ix else None}
        log(f"OV: {len(stops)} haltes in gebied")
        # ritten die deze haltes aandoen (stop_times is groot: snel regel voor regel)
        f = io.TextIOWrapper(z.open("stop_times.txt"), encoding="utf-8-sig", newline="")
        h = f.readline().rstrip("\r\n").split(",")
        i_trip, i_stop = h.index("trip_id"), h.index("stop_id")
        trip_stops = {}
        for line in f:
            p = line.split(",", max(i_trip, i_stop) + 1)
            sid = p[i_stop].strip('"')
            if sid in stops:
                trip_stops.setdefault(p[i_trip].strip('"'), set()).add(sid)
        log(f"OV: {len(trip_stops)} ritten door het gebied")
        # ritten -> lijnen, lijnvormen, eindbestemming
        rd = _reader(z, "trips.txt"); h = next(rd); ix = {k: i for i, k in enumerate(h)}
        trips, shape_ids, route_shapes = {}, set(), {}
        for row in rd:
            tid = row[ix["trip_id"]]
            if tid not in trip_stops:
                continue
            rid = row[ix["route_id"]]
            shp = row[ix["shape_id"]] if "shape_id" in ix else ""
            trips[tid] = {"r": rid, "h": row[ix["trip_headsign"]] if "trip_headsign" in ix else ""}
            for s in trip_stops[tid]:
                stops[s]["r"].add(rid)
            if shp:
                shape_ids.add(shp)
                route_shapes.setdefault(rid, {}).setdefault(shp, 0)
                route_shapes[rid][shp] += 1
        # lijnen
        rd = _reader(z, "routes.txt"); h = next(rd); ix = {k: i for i, k in enumerate(h)}
        used = {t["r"] for t in trips.values()}
        routes = {}
        for row in rd:
            rid = row[ix["route_id"]]
            if rid not in used:
                continue
            g = lambda k: row[ix[k]] if k in ix else ""
            routes[rid] = {"n": g("route_short_name"), "l": g("route_long_name"), "k": route_kind(g("route_type")),
                           "c": ("#" + g("route_color")) if g("route_color") else None,
                           "tc": ("#" + g("route_text_color")) if g("route_text_color") else None,
                           "a": g("agency_id"), "shapes": []}
        agencies = {}
        if "agency.txt" in names:
            rd = _reader(z, "agency.txt"); h = next(rd); ix = {k: i for i, k in enumerate(h)}
            for row in rd:
                agencies[row[ix["agency_id"]]] = row[ix["agency_name"]]
        for r in routes.values():
            r["a"] = agencies.get(r["a"], r["a"])
        # per lijn alleen de meest gebruikte vormen (max 4 per lijn) om dubbelingen te beperken
        keep = set()
        for rid, shps in route_shapes.items():
            for shp, _ in sorted(shps.items(), key=lambda x: -x[1])[:4]:
                keep.add(shp)
        shapes = {}
        if "shapes.txt" in names and keep:
            f = io.TextIOWrapper(z.open("shapes.txt"), encoding="utf-8-sig", newline="")
            h = f.readline().rstrip("\r\n").split(",")
            i_id, i_lat, i_lon, i_seq = (h.index("shape_id"), h.index("shape_pt_lat"),
                                         h.index("shape_pt_lon"), h.index("shape_pt_sequence"))
            for line in f:
                p = line.rstrip("\r\n").split(",")
                sid = p[i_id].strip('"')
                if sid in keep:
                    shapes.setdefault(sid, []).append((int(p[i_seq]), float(p[i_lat]), float(p[i_lon])))
        lim = radius_km + shape_margin_km
        for rid, shps in route_shapes.items():
            if rid not in routes:
                continue
            for shp in shps:
                if shp not in shapes:
                    continue
                pts = [(a, b) for _, a, b in sorted(shapes[shp])]
                cur = []   # knip: alleen stukken binnen het gebied (+marge)
                for p in pts:
                    if _dist_km(center, p) <= lim:
                        cur.append(p)
                    else:
                        if len(cur) >= 2:
                            routes[rid]["shapes"].append(cur)
                        cur = []
                if len(cur) >= 2:
                    routes[rid]["shapes"].append(cur)
            if simplify:
                routes[rid]["shapes"] = [[[round(a, 5), round(b, 5)] for a, b in simplify(s, 8.0)] for s in routes[rid]["shapes"]]
        for s in stops.values():
            s["r"] = sorted(s["r"])
        stops = {k: v for k, v in stops.items() if v["r"]}
        log(f"OV: {len(routes)} lijnen, {len(stops)} haltes met dienst")
        return {"routes": routes, "stops": list(stops.values()),
                "trips": {tid: [t["r"], t["h"]] for tid, t in trips.items()}}
