#!/usr/bin/env python3
"""행정구역 경계(TopoJSON) -> 앱용 SVG path JSON 변환 스크립트.

입력: southkorea/southkorea-maps 의 통계청(KOSTAT) 2018 시·군·구 TopoJSON
출력: data/regions.json  (프로젝션된 SVG path + 라벨 좌표)
"""
import json
import math
import sys

SRC = "topo2018.json"
OUT = "data/regions.json"

SIDO = {
    "11": "서울", "21": "부산", "22": "대구", "23": "인천", "24": "광주",
    "25": "대전", "26": "울산", "29": "세종", "31": "경기", "32": "강원",
    "33": "충북", "34": "충남", "35": "전북", "36": "전남", "37": "경북",
    "38": "경남", "39": "제주",
}
SIDO_FULL = {
    "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시", "인천": "인천광역시",
    "광주": "광주광역시", "대전": "대전광역시", "울산": "울산광역시", "세종": "세종특별자치시",
    "경기": "경기도", "강원": "강원특별자치도", "충북": "충청북도", "충남": "충청남도",
    "전북": "전북특별자치도", "전남": "전라남도", "경북": "경상북도", "경남": "경상남도",
    "제주": "제주특별자치도",
}
# 지도에 표시할 시·도 순서
SIDO_ORDER = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
              "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"]
# 세종시는 코드가 29지만 표기는 '세종특별자치시'
NAME_FIX = {"세종시": "세종특별자치시"}


def decode_topo(path):
    d = json.load(open(path, encoding="utf-8"))
    tr = d["transform"]
    sx, sy = tr["scale"]
    tx, ty = tr["translate"]
    arcs = []
    for arc in d["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def arc_pts(i):
        return arcs[i] if i >= 0 else arcs[~i][::-1]

    def ring(idxs):
        pts = []
        for i in idxs:
            seg = arc_pts(i)
            pts.extend(seg if not pts else seg[1:])
        return pts

    obj = d["objects"][list(d["objects"].keys())[0]]
    feats = []
    for g in obj["geometries"]:
        if g["type"] == "Polygon":
            polys = [[ring(r) for r in g["arcs"]]]
        else:
            polys = [[ring(r) for r in poly] for poly in g["arcs"]]
        feats.append({"props": g["properties"], "polys": polys})
    return feats


def project(lon, lat):
    # 한국 중심 단순 원추 근사: 경도에 cos(위도) 보정
    k = math.cos(math.radians(36.0))
    return ((lon - 127.8) * k, -(lat - 36.0))


def rdp(points, eps):
    if len(points) < 3:
        return points
    # 반복문 기반 Douglas-Peucker
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, best_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if norm == 0:
                dist = math.hypot(px - ax, py - ay)
            else:
                dist = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if dist > best:
                best, best_i = dist, i
        if best > eps:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    return [p for p, k in zip(points, keep) if k]


def ring_area(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def main():
    feats = decode_topo(SRC)

    # 1차: 전체 좌표 -> 프로젝션 + 전체 bbox
    allpts = []
    conv = []
    for f in feats:
        polys = []
        for poly in f["polys"]:
            rings = []
            for r in poly:
                pr = [project(lon, lat) for lon, lat in r]
                rings.append(pr)
                allpts.extend(pr)
            polys.append(rings)
        conv.append({"props": f["props"], "polys": polys})

    minx = min(p[0] for p in allpts)
    maxx = max(p[0] for p in allpts)
    miny = min(p[1] for p in allpts)
    maxy = max(p[1] for p in allpts)

    W = 1000.0
    scale = W / (maxx - minx)
    H = (maxy - miny) * scale
    pad = 8.0

    def tr(p):
        return ((p[0] - minx) * scale + pad, (p[1] - miny) * scale + pad)

    regions = []
    for f in conv:
        code = str(f["props"]["code"])
        sido_key = code[:2]
        sido = SIDO.get(sido_key, "")
        name = NAME_FIX.get(f["props"]["name"], f["props"]["name"])
        d_parts = []
        best_area = 0.0
        best_centroid = (0.0, 0.0)
        total_area = 0.0
        for poly in f["polys"]:
            for ri, ring in enumerate(poly):
                pts = [tr(p) for p in ring]
                if len(pts) > 4 and pts[0] != pts[-1]:
                    pts = rdp(pts + [pts[0]], 0.55)[:-1]
                else:
                    pts = rdp(pts, 0.55)
                if len(pts) < 3:
                    continue
                a = abs(ring_area(pts))
                total_area += a
                if ri == 0 and a > best_area:
                    best_area = a
                    # 폴리곤 면적 중심 (구멍/요철 무시한 근사)
                    cx = sum(p[0] for p in pts) / len(pts)
                    cy = sum(p[1] for p in pts) / len(pts)
                    best_centroid = (cx, cy)
                seg = "M" + " ".join(f"{p[0]:.1f} {p[1]:.1f}" for p in pts) + "Z"
                d_parts.append(seg)
        regions.append({
            "code": code,
            "name": name,
            "nameEn": f["props"].get("name_eng", ""),
            "sido": sido,
            "sidoFull": SIDO_FULL.get(sido, sido),
            "path": "".join(d_parts),
            "cx": round(best_centroid[0], 1),
            "cy": round(best_centroid[1], 1),
            "area": round(total_area, 1),
        })

    regions.sort(key=lambda r: (SIDO_ORDER.index(r["sido"]) if r["sido"] in SIDO_ORDER else 99, r["name"]))

    # 시·도별 bbox
    sido_boxes = {}
    for r in regions:
        nums = [float(v) for v in r["path"].replace("M", " ").replace("Z", " ").split()]
        xs, ys = nums[0::2], nums[1::2]
        b = [min(xs), min(ys), max(xs), max(ys)]
        cur = sido_boxes.get(r["sido"])
        if cur is None:
            sido_boxes[r["sido"]] = b
        else:
            cur[0] = min(cur[0], b[0]); cur[1] = min(cur[1], b[1])
            cur[2] = max(cur[2], b[2]); cur[3] = max(cur[3], b[3])

    out = {
        "viewBox": [0, 0, round(W + pad * 2, 1), round(H + pad * 2, 1)],
        "source": "통계청(KOSTAT) 2018 시·군·구 경계 — southkorea/southkorea-maps",
        "sidoOrder": SIDO_ORDER,
        "sidoFull": SIDO_FULL,
        "sidoBoxes": {k: [round(v, 1) for v in b] for k, b in sido_boxes.items()},
        "regions": regions,
    }
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("regions:", len(regions), "viewBox:", out["viewBox"])
    print("counts:", {s: sum(1 for r in regions if r["sido"] == s) for s in SIDO_ORDER})
    print("file size:", round(len(open(OUT, encoding='utf-8').read().encode()) / 1024, 1), "KB")
    # 검증용: 울릉군 폴리곤 좌표 범위
    ul = next(r for r in regions if r["name"] == "울릉군")
    nums = [float(v) for v in ul["path"].replace("M", " ").replace("Z", " ").split()]
    print("울릉군 bbox:", min(nums[0::2]), min(nums[1::2]), max(nums[0::2]), max(nums[1::2]),
          "polys:", ul["path"].count("M"))


if __name__ == "__main__":
    main()
