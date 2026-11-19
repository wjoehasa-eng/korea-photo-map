#!/usr/bin/env python3
"""앱 아이콘 PNG 생성 (Pillow).

안드로이드 크롬 WebAPK 설치에는 SVG가 아닌 실제 PNG 아이콘이 필요하다.
파스텔 여행 지도 + 핀 + 사진 카드 테마를 512px 마스터로 그린 뒤
4배 슈퍼샘플링으로 다듬어 icons/ 아래 세 파일을 만든다.

    python3 tools/make_icons.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

S = 4                       # 슈퍼샘플 배율
SIZE = 512
W = SIZE * S
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

SKY_TOP = (252, 254, 255)
SKY_BOTTOM = (233, 245, 252)
MAP_CREAM = (255, 246, 224)
MAP_MINT = (232, 249, 236)
MAP_PEACH = (255, 236, 225)
EDGE = (205, 179, 150)
WATER = (201, 232, 246)
HILL = (206, 236, 219)
CORAL = (243, 139, 103)
CORAL_DARK = (231, 111, 77)
CORAL_LIGHT = (250, 174, 148)
WHITE_DOT = (255, 255, 255)


def px(v):
    return int(round(v * S))


def pt(p):
    return (px(p[0]), px(p[1]))


def gradient(size, top, bottom):
    img = Image.new("RGB", (1, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size), Image.NEAREST)


def soft_blob(img, center, radius, color, blur=60):
    """가장자리만 부드럽게 퍼지는 색 덩어리 (투명 영역의 검정 번짐 없이)."""
    cx, cy = pt(center)
    r = px(radius)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=color[3])
    mask = mask.filter(ImageFilter.GaussianBlur(px(blur)))
    layer = Image.new("RGBA", img.size, color[:3] + (0,))
    layer.putalpha(mask)
    img.alpha_composite(layer)


def star(draw, center, radius, fill):
    """네 갈래 반짝이."""
    cx, cy = center
    r, inner = radius, radius * 0.30
    pts = []
    for i in range(8):
        ang = math.radians(-90 + i * 45)
        rr = r if i % 2 == 0 else inner
        pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
    draw.polygon(pts, fill=fill)


def map_polygon():
    top = [(80, 202), (196, 170), (312, 202), (432, 170)]
    bottom = [(432, 370), (312, 402), (196, 370), (80, 402)]
    return top + bottom


def dashed(draw, points, width, fill, dash=22, gap=14):
    """점선 폴리라인 (슈퍼샘플 좌표 기준 길이)."""
    on, off = dash * S, gap * S
    phase, drawing = 0.0, True
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        x0, y0, x1, y1 = px(x0), px(y0), px(x1), px(y1)
        seg = math.hypot(x1 - x0, y1 - y0)
        pos = 0.0
        while pos < seg:
            step = (on if drawing else off) - phase
            end = min(seg, pos + step)
            if drawing:
                draw.line(
                    [(x0 + (x1 - x0) * pos / seg, y0 + (y1 - y0) * pos / seg),
                     (x0 + (x1 - x0) * end / seg, y0 + (y1 - y0) * end / seg)],
                    fill=fill, width=width, joint="curve",
                )
            pos = end
            phase += step
            if phase >= (on if drawing else off):
                phase = 0.0
                drawing = not drawing


def draw_art(img, scale=1.0, offset=(0, 0)):
    """지도 + 사진 카드 + 핀을 그린다. scale/offset은 maskable 안전 여백용."""
    def T(p):
        return pt((256 + (p[0] - 256) * scale + offset[0],
                   256 + (p[1] - 256) * scale + offset[1]))

    # ── 지도 그림자 ─────────────────────────────────────────
    smask = Image.new("L", img.size, 0)
    ImageDraw.Draw(smask).polygon([T(p) for p in map_polygon()], fill=62)
    smask = smask.filter(ImageFilter.GaussianBlur(px(13)))
    shadow = Image.new("RGBA", img.size, (63, 96, 118, 0))
    shadow.putalpha(smask)
    img.alpha_composite(shadow, (0, px(12)))

    # ── 지도 본체(3단 접힘) ─────────────────────────────────
    panels = [
        [(80, 202), (196, 170), (196, 370), (80, 402)],
        [(196, 170), (312, 202), (312, 402), (196, 370)],
        [(312, 202), (432, 170), (432, 370), (312, 402)],
    ]
    fills = [MAP_CREAM, MAP_MINT, MAP_PEACH]
    for poly, fill in zip(panels, fills):
        ImageDraw.Draw(img).polygon([T(p) for p in poly], fill=fill)

    # 지도 안쪽 지형 (지도 모양으로 클리핑)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).polygon([T(p) for p in map_polygon()], fill=255)
    terrain = Image.new("RGBA", img.size, (0, 0, 0, 0))
    td = ImageDraw.Draw(terrain)
    # 바다
    td.ellipse([T((66, 318))[0], T((66, 318))[1], T((206, 430))[0], T((206, 430))[1]], fill=WATER)
    # 숲·언덕
    td.ellipse([T((250, 300))[0], T((250, 300))[1], T((360, 400))[0], T((360, 400))[1]], fill=HILL)
    td.ellipse([T((120, 186))[0], T((120, 186))[1], T((210, 262))[0], T((210, 262))[1]], fill=HILL)
    td.ellipse([T((330, 190))[0], T((330, 190))[1], T((392, 238))[0], T((392, 238))[1]], fill=(255, 226, 210))
    # 이동 경로 점선
    dashed(td, [(112, 350), (168, 300), (222, 336), (268, 268), (318, 296)], max(2, px(2.6)), CORAL_LIGHT, dash=16, gap=12)
    img.alpha_composite(Image.composite(terrain, Image.new("RGBA", img.size, (0, 0, 0, 0)), mask))

    # 접힌 선
    d = ImageDraw.Draw(img)
    for x, y0, y1 in ((196, 170, 370), (312, 202, 402)):
        d.line([T((x, y0)), T((x, y1))], fill=EDGE, width=max(2, px(2.2)))
    # 지도 테두리 (흰 키라인 + 크림색 선)
    outline = [T(p) for p in map_polygon()]
    outline.append(outline[0])
    d.line(outline, fill=(255, 255, 255), width=max(3, px(7)), joint="curve")
    d.line(outline, fill=EDGE, width=max(2, px(2.6)), joint="curve")
    for x, y0, y1 in ((196, 170, 370), (312, 202, 402)):
        d.line([T((x, y0)), T((x, y1))], fill=EDGE, width=max(2, px(2.2)))

    # ── 사진 카드 ───────────────────────────────────────────
    cw, ch = int(104 * S * scale), int(78 * S * scale)
    card = Image.new("RGBA", (cw * 3, ch * 3), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    bx0, by0 = cw, ch
    cd.rounded_rectangle([bx0, by0, bx0 + cw, by0 + ch], radius=int(9 * S * scale),
                         fill=(255, 255, 255, 255))
    inset = int(6 * S * scale)
    frame = [bx0 + inset, by0 + inset, bx0 + cw - inset, by0 + ch - inset]
    cd.rounded_rectangle(frame, radius=int(5 * S * scale), fill=(214, 240, 248, 255))
    # 사진 속 풍경: 언덕 + 해
    hill = [(frame[0], frame[3]),
            (frame[0] + (frame[2] - frame[0]) * 0.42, frame[3] - (frame[3] - frame[1]) * 0.55),
            (frame[0] + (frame[2] - frame[0]) * 0.72, frame[3] - (frame[3] - frame[1]) * 0.22),
            (frame[2], frame[3])]
    cd.polygon(hill, fill=(150, 208, 178, 255))
    sun_r = int(7 * S * scale)
    sx = frame[0] + int((frame[2] - frame[0]) * 0.68)
    sy = frame[1] + int((frame[3] - frame[1]) * 0.34)
    cd.ellipse([sx - sun_r, sy - sun_r, sx + sun_r, sy + sun_r], fill=(250, 196, 150, 255))
    card = card.rotate(9, resample=Image.BICUBIC, expand=False)
    card_center = T((150, 322))
    img.alpha_composite(card, (int(card_center[0] - card.width / 2),
                               int(card_center[1] - card.height / 2)))

    # ── 핀 ─────────────────────────────────────────────────
    cx, cy = T((330, 236))
    r = px(54 * scale)
    tip = T((330, 236 + 116 * scale))
    pin = Image.new("RGBA", img.size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(pin)
    pmask = Image.new("L", img.size, 0)
    ImageDraw.Draw(pmask).ellipse([cx - r, cy - r + px(10), cx + r, cy + r + px(10)], fill=45)
    pmask = pmask.filter(ImageFilter.GaussianBlur(px(6)))
    pin = Image.new("RGBA", img.size, (63, 96, 118, 0))
    pin.putalpha(pmask)
    img.alpha_composite(pin)

    body = Image.new("RGBA", img.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    half = r * 0.62
    bd.polygon([(cx - half, cy + r * 0.42), (cx + half, cy + r * 0.42), tip], fill=CORAL)
    bd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CORAL)
    img.alpha_composite(body)
    d = ImageDraw.Draw(img)
    ir = r * 0.40
    d.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=(255, 255, 255, 255))
    dr = ir * 0.30
    d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=WHITE_DOT)

    # ── 반짝이 ─────────────────────────────────────────────
    star(d, T((92, 132)), px(17 * scale), (255, 255, 255, 235))
    star(d, T((424, 118)), px(11 * scale), (255, 255, 255, 215))
    star(d, T((436, 392)), px(8 * scale), CORAL_LIGHT + (200,))


def make_icon(rounded=True, scale=1.0, offset=(0, 0)):
    bg = gradient(W, SKY_TOP, SKY_BOTTOM).convert("RGBA")
    soft_blob(bg, (74, 66), 150, (198, 242, 220, 120), blur=80)
    soft_blob(bg, (462, 486), 170, (255, 226, 208, 120), blur=80)
    soft_blob(bg, (470, 56), 120, (224, 238, 255, 90), blur=80)
    draw_art(bg, scale=scale, offset=offset)
    if rounded:
        mask = Image.new("L", (W, W), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.225), fill=255)
        bg.putalpha(mask)
    return bg.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    icons = {
        "icon-512.png": make_icon(rounded=True),
        "icon-maskable-512.png": make_icon(rounded=False, scale=0.82),
    }
    icons["icon-192.png"] = icons["icon-512.png"].resize((192, 192), Image.LANCZOS)
    for name, im in icons.items():
        path = os.path.join(OUT, name)
        im.save(path, "PNG", optimize=True)
        print(f"{name}  {im.size[0]}x{im.size[1]}  {os.path.getsize(path)}B")


if __name__ == "__main__":
    main()
