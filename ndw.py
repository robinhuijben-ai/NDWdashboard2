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


# ----------------------------------------------------------------------------
# Weggeometrie van reistijdtrajecten (NDW "AVG meetlocaties" shapefile)
#   ndw_avg_meetlocaties_shapefile.zip -> Meetvakken_WGS84.shp/.shx/.dbf
#   veld dgl_loc = id van het traject in traveltime.xml
# ----------------------------------------------------------------------------

MEETVAKKEN_URL = "https://opendata.ndw.nu/ndw_avg_meetlocaties_shapefile.zip"


def simplify(pts, tol_m=6.0):
    """Douglas-Peucker in meters (vlakke benadering, ruim voldoende op deze schaal)."""
    if len(pts) <= 2:
        return pts
    lat0 = math.radians(pts[0][0])
    kx, ky = 111320.0 * math.cos(lat0), 110540.0
    xy = [(p[1] * kx, p[0] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = xy[i]
        bx, by = xy[j]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            px, py = xy[k]
            if L == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, bi = d, k
        if bi >= 0 and best > tol_m * tol_m:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


def read_meetvakken(path, wanted):
    """-> {id: {"coords": [(lat, lon), ...], "length": m}} voor de gevraagde ids."""
    import struct
    import zipfile

    with zipfile.ZipFile(path) as z:
        names = {n.lower().rsplit("/", 1)[-1]: n for n in z.namelist()}
        dbf = z.read(names["meetvakken_wgs84.dbf"])
        shx = z.read(names["meetvakken_wgs84.shx"])
        shp = z.read(names["meetvakken_wgs84.shp"])

    nrec, hlen, rlen = struct.unpack("<IHH", dbf[4:12])
    fields, o, pos = {}, 32, 0
    while dbf[o] != 0x0D:
        name = dbf[o:o + 11].split(b"\0")[0].decode("ascii", "replace").lower()
        ln = dbf[o + 16]
        fields[name] = (pos, ln)
        pos += ln
        o += 32
    p_id, l_id = fields["dgl_loc"]
    p_len, l_len = fields.get("lengte", (None, None))

    out = {}
    for i in range(nrec):
        base = hlen + i * rlen + 1
        sid = dbf[base + p_id: base + p_id + l_id].decode("latin-1").strip()
        if sid not in wanted:
            continue
        off = struct.unpack(">i", shx[100 + i * 8: 104 + i * 8])[0] * 2
        stype = struct.unpack("<i", shp[off + 8: off + 12])[0]
        if stype not in (3, 13, 23):
            continue
        nparts, npts = struct.unpack("<ii", shp[off + 44: off + 52])
        pbase = off + 52 + nparts * 4
        pts = []
        for k in range(npts):
            x, y = struct.unpack("<dd", shp[pbase + k * 16: pbase + k * 16 + 16])
            pts.append((round(y, 6), round(x, 6)))
        length = None
        if p_len is not None:
            try:
                length = float(dbf[base + p_len: base + p_len + l_len].decode("latin-1").strip() or "nan")
                if math.isnan(length):
                    length = None
            except ValueError:
                pass
        out[sid] = {"coords": pts, "length": length}
    return out


# ----------------------------------------------------------------------------
# Toont een DRIP-beeld iets? (eenvoudige PNG-decoder, alleen standaardbibliotheek)
# ----------------------------------------------------------------------------

def _png_pixels(data):
    """-> (breedte, hoogte, lijst van (r,g,b)) of None als het formaat niet ondersteund wordt."""
    import struct
    import zlib

    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, idat, plte, trns = 8, b"", None, None
    w = h = depth = ctype = interlace = None
    while pos + 8 <= len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8: pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"PLTE":
            plte = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    if not w or interlace or depth not in (1, 2, 4, 8):
        return None
    chans = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ctype)
    if chans is None or (depth < 8 and ctype not in (0, 3)):
        return None
    raw = zlib.decompress(idat)
    bpp = max(1, chans * depth // 8)
    stride = (w * chans * depth + 7) // 8
    prev = bytearray(stride)
    out, p = [], 0
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1: p + 1 + stride])
        p += 1 + stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line
        if depth < 8:
            per = 8 // depth
            vals = []
            for byte in line:
                for k in range(per):
                    vals.append((byte >> (8 - depth * (k + 1))) & ((1 << depth) - 1))
            vals = vals[:w]
            for v in vals:
                out.append(plte[v] if (ctype == 3 and plte and v < len(plte)) else (v * 255 // ((1 << depth) - 1),) * 3)
        else:
            for x in range(w):
                px = line[x * chans:(x + 1) * chans]
                if ctype == 3:
                    out.append(plte[px[0]] if plte and px[0] < len(plte) else (0, 0, 0))
                elif ctype in (0, 4):
                    out.append((px[0],) * 3 if (ctype == 0 or px[1] > 0) else (0, 0, 0))
                else:
                    out.append(tuple(px[:3]) if (ctype == 2 or px[3] > 0) else (0, 0, 0))
    return w, h, out


def image_has_content(data, min_share=0.004):
    """True als meer dan ~0,4% van de pixels duidelijk niet zwart is."""
    try:
        res = _png_pixels(data)
    except Exception:
        res = None
    if res is None:
        return len(data) > 400   # grove terugval: lege beelden comprimeren tot heel weinig bytes
    w, h, px = res
    if not px:
        return False
    lit = sum(1 for r, g, b in px if max(r, g, b) > 60)
    return lit / len(px) > min_share


# ----------------------------------------------------------------------------
# Lusdetectie: snelheden en intensiteiten (trafficspeed.xml.gz, DATEX II v2)
#   meetpuntconfiguratie in measurement_current.xml.gz (zelfde bestand als reistijden)
# ----------------------------------------------------------------------------

TRAFFICSPEED_URL = "https://opendata.ndw.nu/trafficspeed.xml.gz"


def _vehicle_class(el):
    """anyVehicle -> 'all'; lengteklassen -> 'L' (<= 5,6 m), 'M' (5,6-12,2 m), 'Z' (> 12,2 m)."""
    vt = first_text(el, "vehicleType")
    lo = hi = None
    for lc in el.iter():
        if local(lc.tag) != "lengthCharacteristic":
            continue
        op = first_text(lc, "comparisonOperator") or ""
        try:
            v = float(first_text(lc, "vehicleLength") or "nan")
        except ValueError:
            continue
        if op.startswith("greater"):
            lo = v
        elif op.startswith("less"):
            hi = v
    if lo is None and hi is None:
        return "all" if (vt in (None, "anyVehicle")) else vt
    if (lo or 0) < 5.6 and (hi is None or hi <= 5.6 + 1e-6):
        return "L"
    if (lo or 0) >= 12.2 - 1e-6:
        return "Z"
    if (lo or 0) >= 5.6 - 1e-6:
        return "M" if (hi is None or hi <= 12.2 + 1e-6) else "Z"
    return "L"


def parse_loop_sites(path, wanted, center, radius_km):
    """Meetpunten (lussen) binnen de straal -> {id: {name, lat, lon, lanes, side, ch: {idx: [lane, 'f'|'s', klasse]}}}"""
    out = {}
    for rec in iter_records(path, "measurementSiteRecord"):
        sid = rec.get("id")
        if sid not in wanted:
            continue
        lat = lon = None
        for e in rec.iter():
            n = local(e.tag)
            if n == "latitude" and lat is None:
                lat = float(e.text)
            elif n == "longitude" and lon is None:
                lon = float(e.text)
        if lat is None or haversine_m(center, (lat, lon)) / 1000 > radius_km:
            continue
        name = None
        for e in rec.iter():
            if local(e.tag) == "measurementSiteName":
                name = first_text(e, "value")
                break
        ch = {}
        for e in rec:
            if local(e.tag) != "measurementSpecificCharacteristics":
                continue
            idx = e.get("index")
            lane = (first_text(e, "specificLane") or "").replace("lane", "") or "?"
            vt = first_text(e, "specificMeasurementValueType") or ""
            typ = "f" if "Flow" in vt else "s" if "Speed" in vt else None
            if typ:
                ch[idx] = [lane, typ, _vehicle_class(e)]
        try:
            nl = int(first_text(rec, "measurementSiteNumberOfLanes") or 0)
        except ValueError:
            nl = 0
        out[sid] = {"name": name or sid, "lat": round(lat, 6), "lon": round(lon, 6), "lanes": nl,
                    "side": first_text(rec, "measurementSide"), "ch": ch,
                    "dist": round(haversine_m(center, (lat, lon)) / 1000, 2)}
    return out


def parse_measured(path, wanted=None):
    """Generiek: {site_id: {index: waarde}} voor flow/snelheid uit een MeasuredDataPublication."""
    out = {}
    for sm in iter_records(path, "siteMeasurements"):
        sid = None
        vals = {}
        for c in sm:
            n = local(c.tag)
            if n == "measurementSiteReference":
                sid = c.get("id")
                if wanted is not None and sid not in wanted:
                    break
            elif n == "measuredValue":
                idx = c.get("index")
                v = None
                for e in c.iter():
                    ln = local(e.tag)
                    if ln in ("vehicleFlowRate", "speed") and e.text:
                        try:
                            v = float(e.text)
                        except ValueError:
                            pass
                        break
                if idx is not None and v is not None:
                    vals[idx] = v
        if sid and vals:
            out[sid] = vals
    return out


def summarize_loop(site, vals):
    """Samenvatting per meetpunt: totale intensiteit (vtg/u), gewogen snelheid, per rijstrook, per klasse."""
    lanes = {}
    cls_flow = {}
    for idx, (lane, typ, cls) in site["ch"].items():
        v = vals.get(idx)
        if v is None:
            continue
        L = lanes.setdefault(lane, {"f": {}, "s": {}})
        L[typ][cls] = v
        if typ == "f" and v >= 0:
            cls_flow[cls] = cls_flow.get(cls, 0) + v
    tot_f, sw, w = 0.0, 0.0, 0.0
    lane_rows = []
    for lane in sorted(lanes, key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 99, x)):
        L = lanes[lane]
        f = L["f"].get("all")
        if f is None and L["f"]:
            f = sum(x for x in L["f"].values() if x >= 0)
        s = L["s"].get("all")
        if s is None and L["s"]:
            pairs = [(L["s"][c], L["f"].get(c, 0)) for c in L["s"] if L["s"][c] > 0]
            fw = sum(p[1] for p in pairs)
            s = sum(p[0] * p[1] for p in pairs) / fw if fw > 0 else (max((p[0] for p in pairs), default=None))
        if s is not None and (s < 0 or s > 250):
            s = None
        if f is not None and f < 0:
            f = None
        lane_rows.append([lane, None if f is None else int(round(f)), None if s is None else int(round(s))])
        if f:
            tot_f += f
            if s:
                sw += s * f
                w += f
    speed = round(sw / w) if w > 0 else None
    if speed is None:
        sp = [r[2] for r in lane_rows if r[2]]
        speed = round(sum(sp) / len(sp)) if sp else None
    has_flow = any(r[1] is not None for r in lane_rows)
    cls = {k: int(round(v)) for k, v in cls_flow.items() if k != "all"}
    return {"s": speed, "f": int(round(tot_f)) if has_flow else None, "l": lane_rows, "c": cls or None}


# ----------------------------------------------------------------------------
# Situaties (DATEX II v3): actueel beeld, planning werkzaamheden/evenementen, brugopeningen
# ----------------------------------------------------------------------------

ACTUEEL_URL = "https://opendata.ndw.nu/actueel_beeld.xml.gz"
PLANNING_URL = "https://opendata.ndw.nu/planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz"
BRUG_URL = "https://opendata.ndw.nu/planningsfeed_brugopeningen.xml.gz"

_SUBTYPE_TAGS = ("roadOrCarriagewayOrLaneManagementType", "speedManagementType", "abnormalTrafficType",
                 "generalNetworkManagementType", "reroutingManagementType", "accidentType",
                 "vehicleObstructionType", "obstructionType", "roadMaintenanceType", "constructionWorkType",
                 "publicEventType", "animalPresenceType", "poorEnvironmentType", "nonWeatherRelatedRoadConditionType",
                 "weatherRelatedRoadConditionType", "equipmentOrSystemFaultType", "subjectTypeOfWorks")


def _texts(el, tag):
    out = []
    for e in el.iter():
        if local(e.tag) == tag:
            v = first_text(e, "value")
            if v:
                out.append(v)
    return out


def parse_situations(path, center, radius_km, simplify_m=5.0):
    """-> lijst compacte situaties met minstens één punt binnen de straal."""
    out = []
    for sit in iter_records(path, "situation"):
        sid = sit.get("id")
        recs = []
        near = False
        for rec in sit:
            if local(rec.tag) != "situationRecord":
                continue
            r = {"t": (attr(rec, "type") or "").split(":")[-1], "id": rec.get("id")}
            for tag in _SUBTYPE_TAGS:
                v = first_text(rec, tag)
                if v:
                    r.setdefault("sub", v)
                    if tag in ("subjectTypeOfWorks", "roadMaintenanceType", "constructionWorkType", "publicEventType"):
                        r.setdefault("works", v)
            r["cause"] = first_text(rec, "causeType")
            st = first_text(rec, "overallStartTime")
            en = first_text(rec, "overallEndTime")
            r["st"], r["en"] = st, en
            periods = []
            for vp in rec.iter():
                if local(vp.tag) == "validPeriod":
                    a, b = first_text(vp, "startOfPeriod"), first_text(vp, "endOfPeriod")
                    if a or b:
                        periods.append([a, b])
            if len(periods) > 1:
                r["per"] = periods[:60]
            r["status"] = first_text(rec, "operatorActionStatus")
            r["prob"] = first_text(rec, "probabilityOfOccurrence")
            for tag, key, fn in (("delayTimeValue", "delay", float), ("queueLength", "queue", float),
                                 ("temporarySpeedLimit", "speed", float), ("numberOfLanesRestricted", "lr", int),
                                 ("numberOfOperationalLanes", "lo", int), ("originalNumberOfLanes", "ln", int)):
                v = first_text(rec, tag)
                if v:
                    try:
                        r[key] = fn(float(v))
                    except ValueError:
                        pass
            r["band"] = first_text(rec, "delayBand")
            cm = []
            for gc in rec.iter():
                if local(gc.tag) == "generalPublicComment":
                    ctype = first_text(gc, "commentType")
                    txt = first_text(gc, "value")
                    if txt and ctype != "internalNote":
                        cm.append(txt)
            if cm:
                r["cmt"] = cm[:4]
            r["desc"] = (_texts(rec, "causeDescription") or [None])[0]
            r["src"] = (_texts(rec, "sourceName") or [None])[0]
            r["url"] = first_text(rec, "urlLink") and (first_text(rec, "urlLinkAddress") or first_text(rec, "urlLink"))
            r["hind"] = first_text(rec, "roadworkHindranceClass")
            r["road"] = first_text(rec, "roadOrJunctionNumber")
            lines, pts = [], []
            for loc in rec.iter():
                n = local(loc.tag)
                if n == "posList" and loc.text:
                    nums = [float(x) for x in loc.text.split()]
                    line = [fix_latlon(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
                    if len(line) >= 2:
                        lines.append([[round(a, 6), round(b, 6)] for a, b in simplify(line, simplify_m)])
                    elif line:
                        pts.append([round(line[0][0], 6), round(line[0][1], 6), None])
                elif n == "pointByCoordinates":
                    la, lo_ = first_text(loc, "latitude"), first_text(loc, "longitude")
                    if la and lo_:
                        b = first_text(loc, "bearing")
                        pts.append([round(float(la), 6), round(float(lo_), 6), int(float(b)) if b else None])
            r["lines"], r["pts"] = lines, pts
            allp = [p for ln in lines for p in ln] + [p[:2] for p in pts]
            if any(haversine_m(center, tuple(p)) / 1000 <= radius_km for p in allp):
                near = True
            recs.append({k: v for k, v in r.items() if v not in (None, [], "")})
        if near and recs:
            out.append({"id": sid, "sev": first_text(sit, "overallSeverity"),
                        "v": first_text(sit, "situationVersionTime"), "r": recs})
    return out
