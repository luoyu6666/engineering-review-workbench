# -*- coding: utf-8 -*-
"""
申报材料 Word 生成器（通用）—— 把 Markdown 材料排成符合中文申报材料常用规范的 .docx

版式规范（本文件统一实施，所有材料一致）：
    · 纸张 A4（210×297mm），页边距 上下 2.54cm、左 3.17cm、右 3.17cm
    · 文档标题        黑体 小二（18pt）居中
    · 一级标题 ##     黑体 四号（14pt），段前 12pt 段后 6pt
    · 二级标题 ###    黑体 小四（12pt）
    · 三级标题 ####   宋体 小四（12pt）加粗
    · 正文            仿宋 小四（12pt），行距 1.5 倍，首行缩进 2 字符
    · 西文与数字      Times New Roman（中文材料惯例：中文用仿宋，西文数字用 Times New Roman）
    · 代码            等宽 Consolas 五号
    · 表格            全线表，表头灰底加粗居中，正文五号（10.5pt）
    · 页脚            第 X 页 共 Y 页（居中）
    · 页眉            文档名（小五灰色，居中）

用法：
    python md2docx.py <输入.md> <输出.docx> [--header 页眉文字] [--cover] [--title 封面大标题]
由 build-materials.py 批量调用；也可单独用来转其它 Markdown。
"""
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Mm, Pt, RGBColor

FONT_CN = "仿宋"
FONT_HEAD = "黑体"
FONT_CN2 = "宋体"
FONT_EN = "Times New Roman"
FONT_CODE = "Consolas"
SZ_BODY = 12          # 小四
SZ_TABLE = 10.5       # 五号
SZ_SMALL = 9          # 小五


# ────────────────────────── 底层工具 ──────────────────────────
def set_run(run, cn=FONT_CN, en=FONT_EN, size=SZ_BODY, bold=False, italic=False, color=None):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    if color:
        run.font.color.rgb = color
    rPr = run._element.get_or_add_rPr()
    rf = rPr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rPr.append(rf)
    rf.set(qn("w:ascii"), en)
    rf.set(qn("w:hAnsi"), en)
    rf.set(qn("w:eastAsia"), cn)


def set_first_line_chars(paragraph, chars=200):
    """首行缩进 2 字符（用字符数而不是磅值，中文排版惯例）。"""
    pPr = paragraph._p.get_or_add_pPr()
    ind = pPr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        pPr.append(ind)
    ind.set(qn("w:firstLineChars"), str(chars))
    ind.set(qn("w:firstLine"), str(int(chars / 100 * 240)))  # 兼容不支持字符数的阅读器


def add_field(paragraph, instr, size=SZ_SMALL, before="", after=""):
    if before:
        set_run(paragraph.add_run(before), size=size)
    r = paragraph.add_run()
    set_run(r, size=size)
    b = OxmlElement("w:fldChar"); b.set(qn("w:fldCharType"), "begin")
    i = OxmlElement("w:instrText"); i.set(qn("xml:space"), "preserve"); i.text = instr
    e = OxmlElement("w:fldChar"); e.set(qn("w:fldCharType"), "end")
    r._element.append(b); r._element.append(i); r._element.append(e)
    if after:
        set_run(paragraph.add_run(after), size=size)


def shade(cell, fill="D9D9D9"):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), fill)
    tcPr.append(shd)


INLINE = re.compile(r"(\*\*.+?\*\*|`[^`]+`|【[^】]+】)")


def add_inline(p, text, size=SZ_BODY, cn=FONT_CN):
    """行内标记：成对双星号包裹的内容、反引号代码、【待填】高亮，均渲染为加粗。"""
    for part in INLINE.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            set_run(p.add_run(part[2:-2]), cn=FONT_HEAD, size=size, bold=True)
        elif part.startswith("`") and part.endswith("`"):
            set_run(p.add_run(part[1:-1]), cn=FONT_CN2, en=FONT_CODE, size=size - 1)
        elif part.startswith("【") and part.endswith("】"):
            set_run(p.add_run(part), cn=cn, size=size, bold=True, color=RGBColor(0xC0, 0x00, 0x00))
        else:
            set_run(p.add_run(part), cn=cn, size=size)


def setup_page(doc, header_text=""):
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.top_margin = sec.bottom_margin = Cm(2.54)
    sec.left_margin = sec.right_margin = Cm(3.17)
    sec.header_distance, sec.footer_distance = Cm(1.5), Cm(1.5)
    # 正文默认样式
    normal = doc.styles["Normal"]
    normal.font.size = Pt(SZ_BODY)
    normal.font.name = FONT_EN
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
    pf = normal.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = 1.5
    pf.space_after = Pt(0)
    # 页眉 / 页脚
    if header_text:
        hp = sec.header.paragraphs[0]
        hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_run(hp.add_run(header_text), cn=FONT_CN2, size=SZ_SMALL, color=RGBColor(0x59, 0x59, 0x59))
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_field(fp, "PAGE", before="第 ", after=" 页 ")
    add_field(fp, "NUMPAGES", before="共 ", after=" 页")
    return sec


def add_heading(doc, level, text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    if level == 1:      # 文档标题
        pf.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pf.space_before, pf.space_after = Pt(6), Pt(18)
        set_run(p.add_run(text), cn=FONT_HEAD, size=18, bold=False)
    elif level == 2:    # 一级标题
        pf.space_before, pf.space_after = Pt(12), Pt(6)
        set_run(p.add_run(text), cn=FONT_HEAD, size=14)
    elif level == 3:    # 二级标题
        pf.space_before, pf.space_after = Pt(10), Pt(4)
        set_run(p.add_run(text), cn=FONT_HEAD, size=12)
    elif level == 4:    # 三级标题
        pf.space_before, pf.space_after = Pt(8), Pt(4)
        set_run(p.add_run(text), cn=FONT_CN2, size=12, bold=True)
    else:               # 四级标题
        pf.space_before, pf.space_after = Pt(6), Pt(3)
        set_run(p.add_run(text), cn=FONT_CN2, size=12, bold=True)
    return p


def add_table(doc, header, rows):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = True
    for k, h in enumerate(header):
        c = t.rows[0].cells[k]
        c.text = ""
        p = c.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.line_spacing = 1.15
        add_inline(p, h, size=SZ_TABLE, cn=FONT_HEAD)
        for r in p.runs:
            r.font.bold = True
        shade(c)
    for row in rows:
        cells = t.add_row().cells
        for k in range(len(header)):
            c = cells[k]
            c.text = ""
            p = c.paragraphs[0]
            p.paragraph_format.line_spacing = 1.15
            add_inline(p, row[k] if k < len(row) else "", size=SZ_TABLE)
    doc.add_paragraph()
    return t


def add_figure(doc, img_path, caption):
    if Path(img_path).exists():
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(6)
        p.add_run().add_picture(str(img_path), width=Mm(150))
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(10)
    set_run(p.add_run(caption), cn=FONT_CN2, size=SZ_SMALL, color=RGBColor(0x40, 0x40, 0x40))


# ────────────────────────── Markdown → docx ──────────────────────────
def convert(md: Path, out: Path, header="", cover=False, cover_title="", assets: Path = None):
    lines = md.read_text(encoding="utf-8").splitlines()
    doc = Document()
    setup_page(doc, header)

    if cover:
        for _ in range(5):
            doc.add_paragraph()
        for text, size, font in ((cover_title, 26, FONT_HEAD), ("（软件著作权登记申报材料）", 14, FONT_CN2)):
            p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            set_run(p.add_run(text), cn=font, size=size)
        doc.add_page_break()

    i = 0
    while i < len(lines):
        raw = lines[i].rstrip()
        s = raw.strip()

        # 插图占位 [[FIG:图|题|说明]]
        m = re.match(r"^\[\[FIG:([^|\]]+)\|([^|\]]+)(?:\|([^\]]*))?\]\]$", s)
        if m:
            img, cap, note = m.group(1).strip(), m.group(2).strip(), (m.group(3) or "").strip()
            add_figure(doc, (assets or Path(".")) / img, cap + ("　" + note if note else ""))
            i += 1
            continue

        # 表格
        if s.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            header_cells = [c.strip() for c in s.strip("|").split("|")]
            rows, j = [], i + 2
            while j < len(lines) and lines[j].strip().startswith("|"):
                rows.append([c.strip() for c in lines[j].strip().strip("|").split("|")])
                j += 1
            add_table(doc, header_cells, rows)
            i = j
            continue

        # 标题
        m = re.match(r"^(#{1,5})\s+(.*)$", s)
        if m:
            add_heading(doc, len(m.group(1)), m.group(2).strip())
            i += 1
            continue

        # 分隔线
        if re.match(r"^-{3,}$|^\*{3,}$", s):
            i += 1
            continue

        # 引用（用于"注意事项/结论"）
        if s.startswith(">"):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.8)
            p.paragraph_format.space_before, p.paragraph_format.space_after = Pt(4), Pt(4)
            add_inline(p, s.lstrip("> ").strip(), size=SZ_BODY)
            i += 1
            continue

        # 列表
        m = re.match(r"^([-*]|\d+[.、])\s+(.*)$", s)
        if m:
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.74)
            p.paragraph_format.first_line_indent = Cm(-0.74)
            p.paragraph_format.space_after = Pt(2)
            add_inline(p, f"{m.group(1)} {m.group(2)}" if m.group(1) not in "-*" else f"· {m.group(2)}")
            i += 1
            continue

        if not s:
            i += 1
            continue

        # 正文段落（首行缩进 2 字符）
        p = doc.add_paragraph()
        set_first_line_chars(p, 200)
        p.paragraph_format.space_after = Pt(2)
        add_inline(p, s)
        i += 1

    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    return out


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) < 2:
        print("用法：python md2docx.py <输入.md> <输出.docx> [--header 文字] [--cover --title 标题]")
        sys.exit(1)
    hdr, cov, ttl = "", False, ""
    if "--header" in a:
        hdr = a[a.index("--header") + 1]
    if "--cover" in a:
        cov = True
    if "--title" in a:
        ttl = a[a.index("--title") + 1]
    out = convert(Path(a[0]), Path(a[1]), header=hdr, cover=cov, cover_title=ttl,
                  assets=Path(a[1]).parent / "assets")
    print(f"  → {out.name}")
