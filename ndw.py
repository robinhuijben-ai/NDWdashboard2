"""NDW-open-data: downloaden en parsen (reistijden, meetlocaties, MSI, DRIP's, verkeersborden).

Alleen standaardbibliotheek. Gebruikt door fetch.py (GitHub Actions).
"""

import gzip
import math
import os
import shutil
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

TRAVELTIME_URL = "https://opendata.ndw.nu/traveltime.xml.gz"
MST_URL = "https://opendata.ndw.nu/measurement_current.xml.gz"
MSI_URL = "https://opendata.ndw.nu/Matrixsignaalinformatie.xml.gz"
MSI_SHP_URL = "https://opendata.ndw.nu/ndw_msi_shapefiles_latest.zip"
DRIP_URL = "https://opendata.ndw.nu/dynamische_route_informatie_paneel.xml.gz"

BRIDGE = (51.9010, 4.5390)  # Van Brienenoordbrug (A16 over de Nieuwe Maas)


# ----------------------------------------------------------------------------
# Hulpfuncties
# ----------------------------------------------------------------------------


def log(*args):
    print(datetime.now().strftime("%H:%M:%S"), *args, flush=True)


def local(tag):
    """Tagnaam zonder namespace."""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def attr(el, name):
    """Attribuut zonder namespace (bv. xsi:type)."""
    for k, v in el.attrib.items():
        if local(k) == name:
            return v
    return None


def haversine_m(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def fix_latlon(a, b):
    """NL ligt op ~50-54 N, 3-7.5 O; draai om als de volgorde lon/lat is."""
    if 3 <= a <= 8 and 50 <= b <= 54:
        return (b, a)
    return (a, b)


def download(url, dest, timeout=180):
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "brienenoord-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(tmp, dest)
    return os.path.getsize(dest)


def iter_records(path, wanted_tag):
    """Streamt een (gzip)XML-bestand en levert elk element met lokale naam
    `wanted_tag` op; daarna wordt het uit de boom verwijderd (zuinig geheugen)."""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as f:
        stack = []
        for event, el in ET.iterparse(f, events=("start", "end")):
            if event == "start":
                stack.append(el)
                continue
            stack.pop()
            if local(el.tag) == wanted_tag:
                yield el
                if stack:
                    stack[-1].remove(el)
                else:
                    el.clear()


def first_text(el, name):
    for e in el.iter():
        if local(e.tag) == name and e.text and e.text.strip():
            return e.text.strip()
    return None


# ----------------------------------------------------------------------------
# Parsen van de NDW-feeds (DATEX II v2 én v3, namespace-onafhankelijk)
# ----------------------------------------------------------------------------


def parse_traveltime(path):
    """-> (publicationTime, {site_id: {"t": iso, "d": sec|None, "ref": sec|None}})"""
    pub_time = None
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as f:
        # publicationTime staat vooraan; even snel zoeken
        for _, el in ET.iterparse(f, events=("end",)):
            if local(el.tag) == "publicationTime" and el.text:
                pub_time = el.text.strip()
                break

    out = {}
    for sm in iter_records(path, "siteMeasurements"):
        sid = None
        t = None
        dur = None
        ref = None

        def walk(el, path):
            nonlocal sid, t, dur, ref
            name = local(el.tag)
            if name == "measurementSiteReference" and sid is None:
                sid = el.get("id")
            elif name == "measurementTimeDefault" and t is None and el.text:
                t = el.text.strip()
            elif name == "timeValue" and t is None and "measurementTimeDefault" in path and el.text:
                t = el.text.strip()
            elif name == "duration" and el.text:
                try:
                    v = float(el.text)
                except ValueError:
                    v = None
                low = " ".join(path).lower()
                if any(k in low for k in ("freeflow", "normallyexpected", "reference")):
                    if ref is None and v is not None and v > 0:
                        ref = v
                elif dur is None:
                    dur = v
            elif name in ("referenceValue", "freeFlowTravelTime") and el.text and el.text.strip():
                try:
                    v = float(el.text)
                    if v > 0 and ref is None:
                        ref = v
                except ValueError:
                    pass
            for c in el:
                walk(c, path + [name])

        walk(sm, [])
        if sid:
            if dur is not None and dur < 0:  # NDW gebruikt -1 voor "geen waarde"
                dur = None
            out[sid] = {"t": t, "d": dur, "ref": ref}
    return pub_time, out


def parse_site(rec):
    """measurementSiteRecord -> dict met naam, coördinaten, lengte."""
    name = None
    for e in rec.iter():
        if local(e.tag) == "measurementSiteName":
            name = first_text(e, "value")
            break

    pos_coords, point_coords = [], []
    length = None

    def walk(el, path):
        nonlocal length
        n = local(el.tag)
        if n == "posList" and el.text:
            nums = [float(x) for x in el.text.split()]
            for i in range(0, len(nums) - 1, 2):
                pos_coords.append(fix_latlon(nums[i], nums[i + 1]))
        elif n == "lengthAffected" and el.text and el.text.strip():
            try:
                length = (length or 0) + float(el.text)
            except ValueError:
                pass
        kids = {local(c.tag): c for c in el}
        if "latitude" in kids and "longitude" in kids and "locationForDisplay" not in path + [n]:
            try:
                point_coords.append(fix_latlon(float(kids["latitude"].text), float(kids["longitude"].text)))
            except (TypeError, ValueError):
                pass
        for c in el:
            walk(c, path + [n])

    walk(rec, [])
    coords = pos_coords or point_coords
    dedup = []
    for c in coords:
        c = (round(c[0], 6), round(c[1], 6))
        if not dedup or dedup[-1] != c:
            dedup.append(c)

    poly_len = sum(haversine_m(dedup[i], dedup[i + 1]) for i in range(len(dedup) - 1))
    if length and length > 0:
        length_src = "NDW"
    else:
        length, length_src = (poly_len, "lijn") if poly_len > 0 else (None, None)

    return {
        "name": name or rec.get("id"),
        "coords": dedup,
        "length": round(length) if length else None,
        "lengthSrc": length_src,
    }


def parse_mst(path, wanted_ids, center, radius_km):
    sites = {}
    seen = 0
    no_geo = 0
    for rec in iter_records(path, "measurementSiteRecord"):
        sid = rec.get("id")
        if sid not in wanted_ids:
            continue
        seen += 1
        s = parse_site(rec)
        if not s["coords"]:
            no_geo += 1
            continue
        dist = min(haversine_m(center, c) for c in s["coords"]) / 1000
        if dist <= radius_km:
            s["dist"] = round(dist, 2)
            sites[sid] = s
    return sites, seen, no_geo


# ----------------------------------------------------------------------------
# Matrixborden (MSI)
#   standen:  Matrixsignaalinformatie.xml.gz  (TMIS-MSI, per bord-uuid)
#   ligging:  ndw_msi_shapefiles_latest.zip   (puntshapefile, WGS84)
# ----------------------------------------------------------------------------


def read_msi_shapefile(path):
    """-> {uuid: {lat, lon, road, cw, lane, km, bearing}} uit de zip met shapes.shp/.dbf."""
    import struct
    import zipfile

    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shp = z.read(next(n for n in names if n.lower().endswith(".shp")))
        dbf = z.read(next(n for n in names if n.lower().endswith(".dbf")))

    # .shp: 100 bytes header, dan records (8 bytes BE header + inhoud)
    points = []
    off = 100
    while off + 8 <= len(shp):
        _, clen = struct.unpack(">ii", shp[off:off + 8])
        stype = struct.unpack("<i", shp[off + 8:off + 12])[0]
        if stype == 1:
            x, y = struct.unpack("<dd", shp[off + 12:off + 28])
            points.append((y, x))
        else:
            points.append(None)
        off += 8 + clen * 2

    # .dbf
    nrec, hlen, rlen = struct.unpack("<IHH", dbf[4:12])
    fields = []
    o = 32
    while dbf[o] != 0x0D:
        name = dbf[o:o + 11].split(b"\0")[0].decode("ascii", "replace").lower()
        fields.append((name, dbf[o + 16]))
        o += 32

    def col(row, wanted):
        for k, v in row.items():
            if k.startswith(wanted):
                return v
        return ""

    out = {}
    for i in range(min(nrec, len(points))):
        if not points[i]:
            continue
        rec = dbf[hlen + i * rlen + 1: hlen + (i + 1) * rlen]
        row, p = {}, 0
        for name, ln in fields:
            row[name] = rec[p:p + ln].decode("utf-8", "replace").strip()
            p += ln
        uid = col(row, "uuid")
        if not uid:
            continue
        try:
            km = float(col(row, "km") or "nan")
        except ValueError:
            km = None
        try:
            bearing = float(col(row, "bearing") or "nan")
        except ValueError:
            bearing = None
        out[uid] = {
            "lat": points[i][0], "lon": points[i][1],
            "road": col(row, "road"), "cw": col(row, "carriagew"),
            "lane": col(row, "lane"), "km": km,
            "bearing": None if bearing is None or math.isnan(bearing) else round(bearing),
        }
    return out


def parse_msi(path):
    """-> {uuid: {"loc": {...} | None, "disp": {...} | None, "t": iso}}"""
    signs = {}
    for ev in iter_records(path, "event"):
        uid = None
        loc = disp = None
        t = None
        for c in ev:
            n = local(c.tag)
            if n == "sign_id":
                uid = first_text(c, "uuid")
            elif n == "ts_state":
                t = (c.text or "").strip()
            elif n == "lanelocation":
                loc = {local(x.tag): (x.text or "").strip() for x in c}
            elif n == "display":
                for d in c:
                    kind = local(d.tag)
                    disp = {"k": kind}
                    if attr(d, "flashing") == "true":
                        disp["f"] = 1
                    if kind == "speedlimit":
                        disp["v"] = (d.text or "").strip()
                        if attr(d, "red_ring") == "true":
                            disp["r"] = 1
                    sub = [local(x.tag) for x in d]
                    if sub:
                        disp["s"] = sub[0]  # bv. merge_left / merge_right
                    break
        if not uid:
            continue
        s = signs.setdefault(uid, {"loc": None, "disp": None, "t": None})
        if loc:
            s["loc"] = loc
        if disp:
            s["disp"] = disp
            s["t"] = t
    return signs


def build_portals(signs, locs, center, radius_km):
    """Groepeer borden per portaal (weg + rijbaan + km)."""
    portals = {}
    for uid, s in signs.items():
        g = locs.get(uid)
        if not g:
            continue
        if haversine_m(center, (g["lat"], g["lon"])) / 1000 > radius_km:
            continue
        loc = s["loc"] or {}
        road = loc.get("road") or g["road"]
        cw = loc.get("carriageway") or g["cw"]
        km = loc.get("km") or (f"{g['km']:.3f}" if g["km"] is not None else "?")
        key = f"{road}|{cw}|{km}"
        p = portals.setdefault(key, {"k": key, "road": road, "cw": cw, "km": km,
                                     "lat": 0.0, "lon": 0.0, "bearing": g["bearing"], "lanes": []})
        p["lanes"].append({"n": loc.get("lane") or g["lane"], "d": s["disp"] or {"k": "unknown"}, "t": s["t"]})
        p["lat"] += g["lat"]
        p["lon"] += g["lon"]
    for p in portals.values():
        n = len(p["lanes"])
        p["lat"] = round(p["lat"] / n, 6)
        p["lon"] = round(p["lon"] / n, 6)
        p["lanes"].sort(key=lambda l: int(l["n"]) if str(l["n"]).isdigit() else 99)
    return list(portals.values())


# ----------------------------------------------------------------------------
# DRIP's (dynamische route-informatiepanelen, DATEX II v3 VMS)
# ----------------------------------------------------------------------------


def parse_drips(path, center, radius_km):
    """-> (drips {id: {...}}, images {id: [bytes, ...]})"""
    import base64

    drips = {}
    for ctrl in iter_records(path, "vmsController"):
        cid = ctrl.get("id")
        name = None
        lat = lon = bearing = None
        for e in ctrl.iter():
            n = local(e.tag)
            if n == "description" and name is None:
                name = first_text(e, "value")
            elif n == "latitude" and lat is None:
                lat = float(e.text)
            elif n == "longitude" and lon is None:
                lon = float(e.text)
            elif n == "bearing" and bearing is None and e.text:
                try:
                    bearing = round(float(e.text))
                except ValueError:
                    pass
        if cid and lat is not None and lon is not None:
            d = haversine_m(center, (lat, lon)) / 1000
            if d <= radius_km:
                drips[cid] = {"id": cid, "name": name or cid, "lat": lat, "lon": lon,
                              "bearing": bearing, "dist": round(d, 2),
                              "working": None, "t": None, "text": [], "imgs": 0}

    images = {}
    for st in iter_records(path, "vmsControllerStatus"):
        ref = None
        for c in st:
            if local(c.tag) == "vmsControllerReference":
                ref = c.get("id")
                break
        if ref not in drips:
            continue
        d = drips[ref]
        imgs, lines = [], []
        for e in st.iter():
            n = local(e.tag)
            if n == "workingStatus" and e.text:
                d["working"] = e.text.strip()
            elif n == "timeLastSet" and e.text:
                d["t"] = max(d["t"] or "", e.text.strip())
            elif n == "imageData" and e.text:
                try:
                    imgs.append(base64.b64decode(e.text.strip()))
                except Exception:
                    pass
            elif n == "textLine" and len(e) == 0:
                txt = (e.text or "").strip()
                if txt:
                    lines.append(txt)
        d["text"] = lines
        d["imgs"] = len(imgs)
        images[ref] = imgs
    return drips, images



# ----------------------------------------------------------------------------
# Verkeersborden
# ----------------------------------------------------------------------------

SIGNS_URL = "https://opendata.ndw.nu/verkeersborden_actueel_beeld.csv.gz"
SIGN_FIELDS = ("id", "rvvCode", "blackCode", "textSigns", "bearing", "side", "roadName",
               "townName", "imageUrl", "placedOn", "expectedRemovedOn", "validatedOn", "lastSeenOn")


def parse_signs(path, center, radius_km):
    """Streamt de landelijke CSV en houdt alleen geplaatste borden binnen de straal over."""
    import csv

    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * math.cos(math.radians(center[0])))
    lat0, lon0 = center
    out = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        rd = csv.reader(f)
        hdr = next(rd)
        ix = {k: i for i, k in enumerate(hdr)}
        ilat, ilon, ist, irem = ix["latitude"], ix["longitude"], ix["status"], ix.get("removedOn")
        keep = [(k, ix[k]) for k in SIGN_FIELDS if k in ix]
        for row in rd:
            try:
                lat = float(row[ilat])
                if abs(lat - lat0) > dlat:
                    continue
                lon = float(row[ilon])
            except (ValueError, IndexError):
                continue
            if abs(lon - lon0) > dlon or row[ist] != "PLACED" or (irem is not None and row[irem]):
                continue
            if haversine_m(center, (lat, lon)) / 1000 > radius_km:
                continue
            s = {k: (row[i] or None) for k, i in keep}
            s["lat"] = round(lat, 6)
            s["lon"] = round(lon, 6)
            out.append(s)
    return out
