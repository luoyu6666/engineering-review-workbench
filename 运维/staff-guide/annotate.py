# -*- coding: utf-8 -*-
"""
《操作说明》素材生成器 ④ 圈注（按元素名，不手写坐标）

数据来源：运维/screenshot.cjs 在截图时同时量出的 `<图名>.rects.json`
（getBoundingClientRect 与只截视口的截图 1:1 对应，因此量出的坐标可直接绘制）。

采用该方式的原因：第一版手写像素坐标，改动一句文案即整张图错位，只能反复试。
现在改为按元素名圈注：界面改版后重新执行 截图 → 圈注 两步即可，配方里只写
"圈哪个元素、标几号、附什么说明"，不含坐标。

用法：python 运维/staff-guide/annotate.py
"""
from __future__ import annotations

import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, "annotated")

RED = (225, 29, 72)
BLUE = (11, 61, 107)
ORANGE = (245, 158, 11)
WHITE = (255, 255, 255)

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"


def font(size: int, bold: bool = True):
    try:
        return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)
    except Exception:
        return ImageFont.load_default()


# ── 画法 ────────────────────────────────────────────────────────────────
def dashed_round_rect(draw, box, radius=12, color=RED, width=5, dash=16, gap=10):
    x0, y0, x1, y1 = [int(v) for v in box]
    if x1 - x0 < 2 * radius or y1 - y0 < 2 * radius:
        radius = max(2, min((x1 - x0) // 3, (y1 - y0) // 3))
    for x in range(x0 + radius, x1 - radius, dash + gap):
        draw.line([(x, y0), (min(x + dash, x1 - radius), y0)], fill=color, width=width)
        draw.line([(x, y1), (min(x + dash, x1 - radius), y1)], fill=color, width=width)
    for y in range(y0 + radius, y1 - radius, dash + gap):
        draw.line([(x0, y), (x0, min(y + dash, y1 - radius))], fill=color, width=width)
        draw.line([(x1, y), (x1, min(y + dash, y1 - radius))], fill=color, width=width)
    draw.arc([x0, y0, x0 + 2 * radius, y0 + 2 * radius], 180, 270, fill=color, width=width)
    draw.arc([x1 - 2 * radius, y0, x1, y0 + 2 * radius], 270, 360, fill=color, width=width)
    draw.arc([x0, y1 - 2 * radius, x0 + 2 * radius, y1], 90, 180, fill=color, width=width)
    draw.arc([x1 - 2 * radius, y1 - 2 * radius, x1, y1], 0, 90, fill=color, width=width)


def arrow(draw, start, end, color=BLUE, width=7, head=20):
    draw.line([start, end], fill=color, width=width)
    ang = math.atan2(end[1] - start[1], end[0] - start[0])
    for d in (2.7, -2.7):
        draw.line([end, (end[0] + head * math.cos(ang + d), end[1] + head * math.sin(ang + d))], fill=color, width=width)


def badge(img, xy, n, r=21, color=ORANGE):
    d = ImageDraw.Draw(img, "RGBA")
    x, y = int(xy[0]), int(xy[1])
    d.ellipse([x - r - 4, y - r - 4, x + r + 4, y + r + 4], fill=(255, 255, 255, 240))
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)
    f = font(int(r * 1.3))
    t = str(n)
    bb = d.textbbox((0, 0), t, font=f)
    d.text((x - (bb[2] - bb[0]) / 2 - bb[0], y - (bb[3] - bb[1]) / 2 - bb[1]), t, font=f, fill=WHITE)


def label(draw, xy, text, size=26, color=RED, pad=11):
    f = font(size)
    bb = draw.textbbox((0, 0), text, font=f)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    x, y = int(xy[0]), int(xy[1])
    draw.rounded_rectangle([x, y, x + w + pad * 2, y + h + pad * 2], radius=9,
                           fill=(255, 255, 255, 242), outline=color, width=3)
    d2 = ImageDraw.Draw(draw._image, "RGBA") if hasattr(draw, "_image") else None
    draw.text((x + pad - bb[0], y + pad - bb[1]), text, font=f, fill=color)
    return (x, y, x + w + pad * 2, y + h + pad * 2)


def note_with_arrow(img, rect, text, side, size=26):
    """把说明标签放在矩形外侧，并用箭头指回矩形（位置与流程两类信息都用它表达）"""
    W, H = img.size
    d = ImageDraw.Draw(img)
    f = font(size)
    tw = d.textbbox((0, 0), text, font=f)[2]
    bw, bh = tw + 22, size + 22
    x0, y0 = rect["x"], rect["y"]
    x1, y1 = x0 + rect["w"], y0 + rect["h"]
    if side == "below":
        lx, ly = x0, y1 + 16
        anchor = (x0 + 24, ly)
        target = (x0 + 24, y1 + 2)
    elif side == "above":
        lx, ly = x0, y0 - bh - 16
        anchor = (x0 + 24, ly + bh)
        target = (x0 + 24, y0 - 2)
    elif side == "left":
        lx, ly = x0 - bw - 16, y0 + rect["h"] / 2 - bh / 2
        anchor = (lx + bw, ly + bh / 2)
        target = (x0 - 4, ly + bh / 2)
    else:  # right
        lx, ly = x1 + 16, y0 + rect["h"] / 2 - bh / 2
        anchor = (lx, ly + bh / 2)
        target = (x1 + 4, ly + bh / 2)
    # 夹到画面内
    lx = max(8, min(lx, W - bw - 8))
    ly = max(8, min(ly, H - bh - 8))
    if side in ("below", "above"):
        anchor = (lx + 24, anchor[1])
        target = (lx + 24, target[1])
    arrow(d, anchor, target, color=RED, width=5, head=15)
    label(d, (lx, ly), text, size=size)


# ── 配方：每张图圈哪些元素、标几号、写什么说明（不含坐标）────────────────
# boxes : 圈出来的元素名（来自同名 .rects.json）
# badges: [(元素名, 编号)] —— 编号与正文步骤号对应
# notes : [(元素名, 说明文字, 方位)] —— 方位 below/above/left/right
RECIPES = {
    "01-login": {
        "boxes": ["用户名", "密码", "登录按钮"],
        "badges": [("用户名", 1), ("密码", 2)],
        "notes": [("登录按钮", "全部填好后点这里", "below")],
    },
    "02-submit": {
        "boxes": ["文件框", "调用时机", "提交按钮"],
        "badges": [("文件框", 1), ("调用时机", 2), ("提交按钮", 3)],
        "notes": [("文件框", "把报告拖进来（或点击选择）", "above"),
                  # 放上方：放下方会盖住「提交审核」的编号牌③（此前按下方放置时出现）
                  ("调用时机", "想省积分就选「闲时调用」，急着要就选「立即调用」", "above")],
    },
    "03-progress": {
        "boxes": ["进度条", "任务卡片"],
        "badges": [("进度条", 1), ("任务卡片", 2)],
        "notes": [("任务卡片", "每步进度都写在这", "below")],
    },
    "04-ledger": {
        "boxes": ["搜索框", "状态下拉", "台账表"],
        "badges": [("搜索框", 1), ("状态下拉", 2)],
        "notes": [("台账表", "点每行的「查看」看成果", "below")],
    },
    "05-detail": {
        # 三个链接挨着且很小（高 22px）→ 合成一个框圈出来，编号牌放到上方
        "spans": [("成果三件套", ["查看成果", "下载成果", "标注版"])],
        "boxes": [],
        "badges": [("查看成果", 1), ("下载成果", 2), ("标注版", 3)],
        "notes": [("成果三件套", "问题画回原文，改起来最省事", "below")],
    },
    "06-report": {
        "boxes": ["分级统计", "首条问题"],
        "badges": [("分级统计", 1), ("首条问题", 2)],
        "notes": [("分级统计", "先看这里：几项 P0 必须改", "above")],
    },
    "07-points": {
        "boxes": ["积分消耗卡", "积分饼图"],
        "badges": [("积分消耗卡", 1), ("积分饼图", 2)],
        "notes": [("积分消耗卡", "本月用了多少积分", "above")],
    },
    "08-help": {
        "boxes": ["帮助弹窗"],
        "badges": [("帮助弹窗", 1)],
        "notes": [("帮助弹窗", "卡住了？右上角「帮助」里有常见问题", "below")],
    },
}


def union_rect(rects, names):
    """把几个元素的矩形合成一个大框（相邻小元素分别画框会互相压住，可读性差）"""
    xs, ys, xe, ye = [], [], [], []
    for n in names:
        r = rects.get(n)
        if not r:
            continue
        xs.append(r["x"]); ys.append(r["y"]); xe.append(r["x"] + r["w"]); ye.append(r["y"] + r["h"])
    if not xs:
        return None
    return {"x": min(xs), "y": min(ys), "w": max(xe) - min(xs), "h": max(ye) - min(ys)}


def main():
    os.makedirs(OUT, exist_ok=True)
    files = [f for f in sorted(os.listdir(RAW)) if f.endswith(".png")]
    done, warn = 0, []
    for fn in files:
        key = fn[:-4]
        img = Image.open(os.path.join(RAW, fn)).convert("RGB")
        recipe = RECIPES.get(key)
        rf = os.path.join(RAW, key + ".rects.json")
        rects = json.load(open(rf, encoding="utf-8")) if os.path.exists(rf) else {}
        if not recipe:
            img.save(os.path.join(OUT, fn))
            continue
        d = ImageDraw.Draw(img)
        # ① 合并框（把相邻小元素当作一个整体圈出来）
        for gname, names in recipe.get("spans", []):
            r = union_rect(rects, names)
            if not r:
                warn.append(f"{key}.span:{gname}")
                continue
            rects[gname] = r          # 供 badges/notes 引用这个名字
            pad = 7
            dashed_round_rect(d, (r["x"] - pad, r["y"] - pad, r["x"] + r["w"] + pad, r["y"] + r["h"] + pad))
        # ② 单个元素的框（细条状元素留白小一点，否则虚线会压到相邻文字上）
        for name in recipe.get("boxes", []):
            r = rects.get(name)
            if not r:
                warn.append(f"{key}.{name}")
                continue
            pad = 5 if r["h"] < 20 else 7
            dashed_round_rect(d, (r["x"] - pad, r["y"] - pad, r["x"] + r["w"] + pad, r["y"] + r["h"] + pad))
        # ③ 编号牌位置：
        #    · 矮且窄的目标（如"查看/下载"这类小链接）放上方（放左右会压住相邻元素）
        #    · 其它目标放框外左侧（左侧空间不足时放右侧）
        #    此前一律放左侧，结果比按钮还大的牌子把按钮文字压住；后改为一律放上方，
        #    又压住了宽搜索框上方的卡片标题（两种情况均经实测确认）。
        for name, n in recipe.get("badges", []):
            r = rects.get(name)
            if not r:
                continue
            if r["h"] < 44 and r["w"] < 220:
                badge(img, (r["x"] + 22, r["y"] - 30), n, r=17)
            else:
                bx = r["x"] - 40
                if bx < 26:
                    bx = r["x"] + r["w"] + 40
                badge(img, (bx, r["y"] + r["h"] / 2), n)
        # ④ 说明标签（带箭头指回目标）
        for name, text, side in recipe.get("notes", []):
            r = rects.get(name)
            if not r:
                continue
            note_with_arrow(img, r, text, side)
        img.save(os.path.join(OUT, fn))
        done += 1
        print(f"  ✓ {fn}（圈 {len(recipe.get('boxes', [])) + len(recipe.get('spans', []))} · 标号 {len(recipe.get('badges', []))} · 说明 {len(recipe.get('notes', []))}）")
    print(f"圈注完成：{done} 张 → {OUT}")
    if warn:
        print("⚠️ 这些元素没量到（界面改版了？重跑截图）：" + "、".join(warn))


if __name__ == "__main__":
    main()
