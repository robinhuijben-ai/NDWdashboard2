"""Archief van afgeronde dagen in de branch 'data' van deze repository.

De werkdata van het dashboard staat in de GitHub Actions-cache. Die is beperkt
(10 GB) en kan wegvallen. Daarom gaan afgeronde dagen hier naar een aparte
branch 'data', die altijd uit één commit bestaat (oude versies worden niet
bewaard, zodat de repository niet onnodig groeit). Het dashboard leest oude dagen
via raw.githubusercontent.com.

Wordt per run aangeroepen; doet alleen iets als er een dag is afgerond of als
er dagen buiten de bewaartermijn vallen. Alleen standaardbibliotheek.

Omgeving: GITHUB_TOKEN, GITHUB_REPOSITORY (zet GitHub Actions zelf),
ARCHIVE_DAYS (bewaartermijn in dagen, standaard 365; 0 = onbeperkt),
ARCHIVE_OV_DAYS (bewaartermijn OV-voertuigposities, standaard 60; 0 = onbeperkt).
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = os.environ.get("GITHUB_API_URL") or "https://api.github.com"
BRANCH = "data"
KINDS = ("hist", "lhist", "msi", "drip", "sit", "ovh")
CHUNK = 6_000_000          # tekens inhoud per tree-aanvraag
MAX_IMG = 150              # beelden (blobs) per run, i.v.m. limieten van GitHub


def log(*a):
    print("[archief]", *a, flush=True)


def day_of(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")


class GH:
    def __init__(self, repo, token):
        self.repo, self.token = repo, token

    def req(self, method, path, body=None, ok404=False):
        url = f"{API}/repos/{self.repo}/{path}"
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            r = urllib.request.Request(url, data=data, method=method, headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "verkeersdashboard-archief",
                **({"Content-Type": "application/json"} if data else {}),
            })
            try:
                with urllib.request.urlopen(r, timeout=300) as resp:
                    txt = resp.read()
                    return json.loads(txt) if txt else {}
            except urllib.error.HTTPError as e:
                if e.code == 404 and ok404:
                    return None
                msg = e.read().decode(errors="replace")[:300]
                if e.code in (403, 429, 500, 502, 503) and attempt < 3:
                    wait = int(e.headers.get("Retry-After") or 20 * (attempt + 1))
                    log(f"{method} {path}: {e.code}, opnieuw over {wait}s")
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"{method} {path}: HTTP {e.code} {msg}")
            except urllib.error.URLError as e:
                if attempt < 3:
                    time.sleep(10)
                    continue
                raise


def day_files(pub, kind, day):
    """Paden (relatief aan pub) die bij een dag van een soort horen."""
    out = []
    if kind in ("hist", "lhist"):
        d = os.path.join(pub, kind, day)
        if os.path.isdir(d):
            out += [f"{kind}/{day}/{n}" for n in sorted(os.listdir(d)) if n.endswith(".json")]
        tl = "tl" if kind == "hist" else "ltl"
        if os.path.exists(os.path.join(pub, tl, day + ".json")):
            out.append(f"{tl}/{day}.json")
    else:
        if os.path.exists(os.path.join(pub, kind, day + ".json")):
            out.append(f"{kind}/{day}.json")
    return out


def local_days(pub, kind):
    folder = os.path.join(pub, kind)
    if not os.path.isdir(folder):
        return []
    return sorted({n[:10] for n in os.listdir(folder)
                   if len(n) >= 10 and n[4] == "-" and n[7] == "-"})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--state", default="state")
    p.add_argument("--out", default="site")
    a = p.parse_args()
    pub = os.path.join(a.state, "pub")
    repo, token = os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GITHUB_TOKEN")
    def days_env(name, default):
        import re as _re
        m = _re.findall(r"\d+", os.environ.get(name) or "")
        return int(m[-1]) if m else default
    keep = days_env("ARCHIVE_DAYS", 365)
    keep_ov = days_env("ARCHIVE_OV_DAYS", 60)
    if not repo or not token:
        log("geen GITHUB_REPOSITORY/GITHUB_TOKEN; overgeslagen")
        return 0
    gh = GH(repo, token)
    now = time.time()
    done_before = day_of(now - 3600)          # dagen vóór deze zijn afgerond
    oldest_all = day_of(now - keep * 86400) if keep > 0 else "0000-00-00"
    oldest_ov = day_of(now - keep_ov * 86400) if keep_ov > 0 else "0000-00-00"
    oldest_of = lambda kind: max(oldest_all, oldest_ov) if kind == "ovh" else oldest_all

    # huidige stand van het archief
    ref = gh.req("GET", f"git/ref/heads/{BRANCH}", ok404=True)
    base_tree, index = None, {"v": 1, "files": {k: {} for k in KINDS}, "img": []}
    if ref:
        commit = gh.req("GET", f"git/commits/{ref['object']['sha']}")
        base_tree = commit["tree"]["sha"]
        f = gh.req("GET", f"contents/index.json?ref={BRANCH}", ok404=True)
        if f and f.get("content"):
            index = json.loads(base64.b64decode(f["content"]))
        elif f and f.get("download_url"):
            with urllib.request.urlopen(f["download_url"], timeout=120) as r:
                index = json.loads(r.read())
    for k in KINDS:
        index["files"].setdefault(k, {})
    index.setdefault("img", [])

    # nieuwe afgeronde dagen
    new_files, img_new = [], []
    have_img = set(index["img"])
    for kind in KINDS:
        for day in local_days(pub, kind):
            if day >= done_before or day < oldest_of(kind) or day in index["files"][kind]:
                continue
            files = day_files(pub, kind, day)
            if not files:
                continue
            new_files += files
            index["files"][kind][day] = files
            if kind == "drip":       # beelden waarnaar deze dag verwijst
                with open(os.path.join(pub, "drip", day + ".json")) as fh:
                    for _, ch in json.load(fh).get("steps", []):
                        for v in ch.values():
                            for h in (v or {}).get("i", []):
                                if h not in have_img and os.path.exists(os.path.join(pub, "drip", "img", h + ".png")):
                                    have_img.add(h)
                                    img_new.append(h)

    # dagen buiten de bewaartermijn
    removed = []
    for kind in KINDS:
        for day in [d for d in index["files"][kind] if d < oldest_of(kind)]:
            removed += index["files"][kind].pop(day)

    if new_files or removed or img_new:
        img_now, img_later = img_new[:MAX_IMG], img_new[MAX_IMG:]
        for h in img_later:              # volgende run opnieuw proberen
            have_img.discard(h)
        index["img"] = sorted(set(index["img"]) | set(img_now))
        index["updated"] = int(now)
        entries = []
        for path in new_files:
            with open(os.path.join(pub, path), encoding="utf-8") as fh:
                entries.append({"path": path, "mode": "100644", "type": "blob", "content": fh.read()})
        for h in img_now:
            with open(os.path.join(pub, "drip", "img", h + ".png"), "rb") as fh:
                b = gh.req("POST", "git/blobs", {"content": base64.b64encode(fh.read()).decode(), "encoding": "base64"})
            entries.append({"path": f"drip/img/{h}.png", "mode": "100644", "type": "blob", "sha": b["sha"]})
        entries += [{"path": path, "mode": "100644", "type": "blob", "sha": None} for path in removed]
        entries.append({"path": "index.json", "mode": "100644", "type": "blob",
                        "content": json.dumps(index, separators=(",", ":"))})
        entries.append({"path": "README.md", "mode": "100644", "type": "blob",
                        "content": "# Archief verkeersdashboard\n\nAfgeronde dagen, automatisch bijgehouden door "
                                   "`archive.py`. Deze branch bestaat altijd uit één commit.\n"})
        # in porties versturen; elke porties bouwt voort op de vorige tree
        tree, batch, size = base_tree, [], 0
        for e in entries:
            batch.append(e)
            size += len(e.get("content") or "")
            if size >= CHUNK:
                tree = gh.req("POST", "git/trees", {**({"base_tree": tree} if tree else {}), "tree": batch})["sha"]
                batch, size = [], 0
        if batch:
            tree = gh.req("POST", "git/trees", {**({"base_tree": tree} if tree else {}), "tree": batch})["sha"]
        days_txt = ", ".join(sorted({p.split("/")[1][:10] for p in new_files})) or "opruimen"
        c = gh.req("POST", "git/commits", {"message": f"Archief bijgewerkt ({days_txt})", "tree": tree, "parents": []})
        if ref:
            gh.req("PATCH", f"git/refs/heads/{BRANCH}", {"sha": c["sha"], "force": True})
        else:
            gh.req("POST", "git/refs", {"ref": f"refs/heads/{BRANCH}", "sha": c["sha"]})
        log(f"{len(new_files)} bestanden toegevoegd, {len(removed)} verwijderd, {len(img_now)} beelden"
            + (f" ({len(img_later)} beelden volgende run)" if img_later else ""))
    else:
        log("niets nieuws")

    # overzicht voor het dashboard
    owner_repo = repo
    out = {
        "base": f"https://raw.githubusercontent.com/{owner_repo}/{BRANCH}/",
        "keepDays": keep,
        "keepOvDays": keep_ov,
        **{k: sorted(index["files"][k]) for k in KINDS},
    }
    for path in (os.path.join(a.out, "data", "archive.json"), os.path.join(a.state, "archive.json")):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            json.dump(out, fh, separators=(",", ":"))
    log(f"in archief: {len(out['hist'])} dagen reistijden, {len(out['lhist'])} dagen lussen")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:      # het dashboard moet altijd gepubliceerd worden
        log(f"FOUT: {type(e).__name__}: {e}")
        # laatst bekende overzicht blijven publiceren
        args = sys.argv[1:]
        st = args[args.index("--state") + 1] if "--state" in args else "state"
        out = args[args.index("--out") + 1] if "--out" in args else "site"
        src = os.path.join(st, "archive.json")
        if os.path.exists(src):
            os.makedirs(os.path.join(out, "data"), exist_ok=True)
            with open(src) as fi, open(os.path.join(out, "data", "archive.json"), "w") as fo:
                fo.write(fi.read())
        sys.exit(0)
