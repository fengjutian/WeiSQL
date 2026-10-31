"""Build the WeiSQL AI status report as a Word document.

Run with the bundled Python (python-docx is provided there):

    python tools/make-status-docx.py docs/WeiSQL-项目状态报告.docx

Content mirrors docs/PROJECT_STATUS.md. Regenerate both together so the document
and the repository report cannot drift.
"""

import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

EA_FONT = "微软雅黑"
ACCENT = RGBColor(0x1F, 0x38, 0x64)
MUTED = RGBColor(0x59, 0x59, 0x59)
HEADER_FILL = "D9E2F3"
NOTE_FILL = "EEF3FA"


def style_run(run, size=None, bold=None, color=None, italic=None):
    run.font.name = EA_FONT
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    for attribute in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(attribute), EA_FONT)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    if color is not None:
        run.font.color.rgb = color


def configure_styles(document):
    normal = document.styles["Normal"]
    normal.font.name = EA_FONT
    normal.font.size = Pt(10.5)
    normal.element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), EA_FONT)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.35

    for name, size in (("Heading 1", 14), ("Heading 2", 12), ("Title", 22)):
        style = document.styles[name]
        style.font.name = EA_FONT
        style.font.size = Pt(size)
        style.font.color.rgb = ACCENT
        style.font.bold = True
        rpr = style.element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = OxmlElement("w:rFonts")
            rpr.append(rfonts)
        rfonts.set(qn("w:eastAsia"), EA_FONT)
        rfonts.set(qn("w:ascii"), EA_FONT)
        rfonts.set(qn("w:hAnsi"), EA_FONT)
        style.paragraph_format.space_before = Pt(14 if name == "Heading 1" else 10)
        style.paragraph_format.space_after = Pt(6)
        style.paragraph_format.keep_with_next = True


def shade(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def set_table_widths(table, widths):
    """Force a fixed layout; LibreOffice and Word both ignore cell widths otherwise."""
    tbl_pr = table._tbl.tblPr
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tbl_pr.append(layout)
    for index, width in enumerate(widths):
        table.columns[index].width = Cm(width)
        for row in table.rows:
            row.cells[index].width = Cm(width)


def add_table(document, headers, rows, widths=None, size=9):
    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False

    # Repeat the header row when a table splits across pages.
    header_row = table.rows[0]
    row_properties = header_row._tr.get_or_add_trPr()
    row_properties.append(OxmlElement("w:tblHeader"))

    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        cell.text = ""
        paragraph = cell.paragraphs[0]
        run = paragraph.add_run(header)
        style_run(run, size=size, bold=True, color=ACCENT)
        shade(cell, HEADER_FILL)

    for row in rows:
        cells = table.add_row().cells
        for index, value in enumerate(row):
            cells[index].text = ""
            paragraph = cells[index].paragraphs[0]
            run = paragraph.add_run(str(value))
            style_run(run, size=size)

    if widths:
        set_table_widths(table, widths)
    return table


def add_bullets(document, items):
    for item in items:
        paragraph = document.add_paragraph(style="List Bullet")
        run = paragraph.add_run(item)
        style_run(run, size=10.5)


def add_note(document, text):
    table = document.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.rows[0].cells[0]
    cell.text = ""
    paragraph = cell.paragraphs[0]
    run = paragraph.add_run(text)
    style_run(run, size=10, color=MUTED)
    shade(cell, NOTE_FILL)


def add_page_number(paragraph):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = " PAGE "
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instruction)
    run._r.append(end)
    style_run(run, size=9, color=MUTED)


def build(target: Path):
    document = Document()
    section = document.sections[0]
    section.page_height = Cm(29.7)
    section.page_width = Cm(21)
    for side in ("top_margin", "bottom_margin"):
        setattr(section, side, Cm(2.2))
    for side in ("left_margin", "right_margin"):
        setattr(section, side, Cm(2.4))

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    prefix = footer.add_run("WeiSQL AI · 项目状态报告 · 第 ")
    style_run(prefix, size=9, color=MUTED)
    add_page_number(footer)
    suffix = footer.add_run(" 页")
    style_run(suffix, size=9, color=MUTED)

    title = document.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = title.add_run("WeiSQL AI 项目状态报告")
    style_run(run, size=22, bold=True, color=ACCENT)

    subtitle = document.add_paragraph()
    run = subtitle.add_run("2026-10-31 · 仓库 HEAD ada5885 · 230 个自动化测试 · 尚未发布 npm")
    style_run(run, size=10, color=MUTED)

    document.add_heading("1. 一句话状态", level=1)
    paragraph = document.add_paragraph()
    run = paragraph.add_run(
        "工程原型。Manifest V1 与数据包格式稳定，四个包共 230 个自动化测试，CI 覆盖构建、类型、测试与发布元数据；"
        "精确检索、ANN、全文、融合、RAG 与单文件容器均有实现与实测数字。尚未发布 npm 包，也没有任何未经测量的性能承诺。"
    )
    style_run(run, size=10.5)

    add_table(
        document,
        ["维度", "状态"],
        [
            ["测试", "230 个全绿（SDK 176 / DuckDB 19 / USearch 13 / CLI 22）"],
            ["CI", "GitHub Actions：Ubuntu + Windows 行为闸门，另有派生索引与容器作业"],
            ["许可证", "Apache-2.0（根目录与每个包内各一份）"],
            ["发布", "未发布 npm 包（缺组织与访问令牌）"],
            ["实测", "精确向量、ANN（含分布对照）、全文（含体积拆分）、浏览器一致性"],
        ],
        widths=[3.2, 12.6],
    )

    document.add_heading("2. 能力矩阵", level=1)
    add_table(
        document,
        ["能力", "实现", "测试", "文档", "实测"],
        [
            ["Manifest V1 校验（L1/L2）", "✓", "✓", "✓", "—"],
            ["L3 资源完整性（尺寸 + SHA-256）", "✓", "✓", "✓", "✓"],
            ["L4 Parquet 内容校验（CLI --l4）", "✓", "✓", "✓", "✓"],
            ["HTTP / Node 文件 Reader", "✓", "✓", "✓", "✓"],
            ["有界 LRU 缓存 + 请求合并", "✓", "✓", "✓", "—"],
            ["Runtime 生命周期与能力报告", "✓", "✓", "✓", "—"],
            ["精确向量检索", "✓", "✓", "✓", "129–152 ms p50 @100k×128"],
            ["Hybrid 过滤两策略", "✓", "✓", "✓", "—"],
            ["DuckDB 只读 SQL（memory / lazy）", "✓", "✓", "✓", "—"],
            ["USearch ANN（持久化 / 现场构建）", "✓", "✓", "✓", "0.385–0.740 Recall@10"],
            ["ANN 后过滤（显式可选）", "✓", "✓", "✓", "—"],
            ["全文检索 BM25", "✓", "✓", "✓", "p50 ≈10.5 ms @100k 文档"],
            ["RRF 融合", "✓", "✓", "✓", "—"],
            ["RAG 证据组装", "✓", "✓", "✓", "端到端"],
            [".wsql 单文件容器（pack/validate/unpack/流式）", "✓", "✓", "✓", "3.6 KB 包往返"],
            ["浏览器路径（Chromium）", "✓", "探针", "✓", "与 Node 逐字段一致"],
            ["发布前检查 + Apache-2.0", "✓", "—", "✓", "✓"],
        ],
        widths=[6.4, 1.7, 1.7, 1.7, 4.3],
    )

    document.add_heading("3. 包与依赖", level=1)
    add_table(
        document,
        ["包", "版本", "运行时依赖"],
        [
            ["@weisql/sdk", "0.1.0", "无"],
            ["@weisql/duckdb-adapter", "0.1.0", "@duckdb/node-api 2.0.0-r.1"],
            ["@weisql/usearch-adapter", "0.1.0", "usearch 2.26.5"],
            ["@weisql/cli", "0.1.0", "@weisql/sdk"],
        ],
        widths=[5.4, 2.2, 8.2],
    )
    paragraph = document.add_paragraph()
    run = paragraph.add_run("依赖方向单向，下游对 SDK 使用 caret 范围，由 release:check 强制校验。")
    style_run(run, size=10, color=MUTED)

    document.add_heading("4. 测试与 CI", level=1)
    add_table(
        document,
        ["包", "测试数", "覆盖重点"],
        [
            ["@weisql/sdk", "176", "校验、Reader、缓存、Builder、精确/融合/RAG、容器、随机输入错误契约、Adapter 契约"],
            ["@weisql/duckdb-adapter", "19", "只读边界、参数绑定、两种表加载、取消"],
            ["@weisql/usearch-adapter", "13", "度量映射、持久化索引、后过滤、生命周期"],
            ["@weisql/cli", "22", "校验退出码、--json、pack、unpack、容器校验、--l4"],
            ["合计", "230", ""],
        ],
        widths=[4.6, 1.8, 9.4],
    )
    add_bullets(
        document,
        [
            "verify 作业：Ubuntu + Windows 矩阵，npm ci → build → typecheck → test → release:check → 示例包校验。",
            "derived 作业：fixture 可复现性（重生成后 git status 必须为空）→ 构建文本/ANN 索引并校验 → 打包容器 → 解包后再次校验。",
            "probe:* 与 bench 不在 CI 内：需要 Chromium / Python / 稳定机器，因此浏览器与性能结论必须在本地复现并注明环境。",
        ],
    )

    document.add_heading("5. 全部实测数字", level=1)
    add_table(
        document,
        ["指标", "数值", "条件", "边界"],
        [
            ["精确检索 p50", "129–152 ms", "100k × 128，20 查询", "单机、热页缓存"],
            ["精确检索 I/O", "51.2 MB/查询", "同上", "未做列裁剪"],
            ["ANN 加速", "≈9.5×", "100k × 128，expansionSearch=512", "合成数据"],
            ["ANN Recall@10", "0.385–0.740", "均匀 0.735；紧聚类 0.385", "强依赖数据分布"],
            ["ANN 索引构建", "2.7–15.2 s", "同上", "构建时间随分布变化"],
            ["全文索引体积", "74.2 MB", "100k 文档、5000 词项、50 tokens/文档", "其中正文 33.1 MB"],
            ["全文查询 p50", "10.2–10.8 ms", "同上", "固定开销 ≈8 ms + 每命中随机读"],
            ["全文索引构建", "4.5 s", "同上", "含读取 Parquet 文本列"],
            ["浏览器一致性", "8 向量 + 5 文本 + RAG + 容器", "Chromium 1248 vs Node 24", "3 条记录、2 维，不能外推"],
        ],
        widths=[3.6, 3.8, 5.4, 3.0],
    )

    document.add_heading("5.1 ANN 召回与数据分布", level=2)
    add_table(
        document,
        ["分布（100k × 128，Top-10，expansionSearch=512）", "Recall@10 均值", "最低"],
        [
            ["均匀随机", "0.735", "0.400"],
            ["100 簇，spread 1.0", "0.740", "0.100"],
            ["100 簇，spread 0.35", "0.685", "0.000"],
            ["10 簇，spread 0.35", "0.590", "0.000"],
            ["100 簇，spread 0.1", "0.385", "0.000"],
            ["100 簇，spread 0.1，expansionSearch=2048", "0.760", "0.000"],
        ],
        widths=[9.2, 3.6, 3.0],
    )
    add_note(
        document,
        "结论：召回数字必须连同分布与规模一起报告。均匀随机并不是 HNSW 最不利的情形——这一点曾被写入 ADR-030，"
        "已在 ADR-043 中用上表数据推翻。",
    )

    document.add_heading("6. 未实现与未验证", level=1)
    document.add_heading("6.1 外部条件阻塞", level=2)
    add_table(
        document,
        ["项", "阻塞原因"],
        [
            ["npm 发布", "缺少组织与访问令牌；LICENSE 已确定为 Apache-2.0"],
            ["真实数据集 Recall@K", "需要真实 embedding 语料"],
            ["多机 / 冷缓存基准", "需要第二台机器与清缓存手段"],
            ["DuckDB-Wasm", "Parquet 扩展需从外部下载，当前不可达"],
            ["真实 CDN / CORS 验收", "需要实际部署环境"],
        ],
        widths=[5.0, 10.8],
    )

    document.add_heading("6.2 设计未定或明确不做", level=2)
    add_table(
        document,
        ["项", "状态"],
        [
            ["ANN 过滤的完整性保证", "只有显式后过滤，可能少于 topK，已在诊断中标注"],
            ["同主版本内的索引格式变化", "只按主版本判定，无法探测其内部变化"],
            [".wsql 压缩算法协商", "目前只有 gzip；brotli 需要新版本号"],
            ["RRF 的 k 调优", "使用文献默认 60，未做实验"],
            ["Builder CSV/JSON 输入", "需要 Parquet 写入依赖，未引入"],
            ["中文分词", "CJK 逐字，精度换可预测性"],
        ],
        widths=[6.4, 9.4],
    )

    document.add_heading("7. 关键决策", level=1)
    paragraph = document.add_paragraph()
    run = paragraph.add_run("完整 45 条记录见仓库 docs/DECISION_LOG.md；下表列出与外部读者最相关的决策。")
    style_run(run, size=10, color=MUTED)
    add_table(
        document,
        ["ADR", "决策"],
        [
            ["016", "Manifest V1 语义与约束"],
            ["022", "精确优先，ANN 必须自报 exact: false"],
            ["026", "基准装置是测量设备，不是性能承诺"],
            ["028", "USearch 度量映射经实测校准"],
            ["029", "索引参数进 Manifest，缺参数拒绝加载"],
            ["030 / 043", "ANN 召回必须按分布报告（043 推翻 030 的「均匀最差」判断）"],
            ["032 / 033", "全文索引格式、ID Map 与排序规则"],
            ["035", "融合用 RRF，只用排名"],
            ["036", "RAG 只做证据组装，不调用模型"],
            ["037", "ANN 过滤只提供显式后过滤"],
            ["039", ".wsql 不压缩、整文件入内存"],
            ["040 / 044 / 045", "Apache-2.0 每包自带许可证；容器防穿越；不可信输入错误契约"],
        ],
        widths=[3.6, 12.2],
    )

    document.add_heading("8. 发布就绪度", level=1)
    add_table(
        document,
        ["检查项", "状态"],
        [
            ["测试 / 类型 / 构建", "✓ 230 测试，typecheck 通过"],
            ["打包内容", "✓ 仅 dist/ + README + LICENSE，无 src/test 泄漏"],
            ["依赖范围", "✓ caret 且跟踪本地版本"],
            ["许可证", "✓ Apache-2.0（根 + 每包）"],
            ["CI", "✓ 双平台行为闸门"],
            ["npm 组织与令牌", "未完成"],
            ["多机基准", "未完成"],
        ],
        widths=[5.4, 10.4],
    )
    add_note(document, "结论：技术上可发布，行政上未就绪。")

    document.add_heading("9. 建议的下一步", level=1)
    for index, item in enumerate(
        [
            "配置 npm 令牌 → npm publish --dry-run 核对四个包 → 正式发布。",
            "在真实 embedding 数据上测 Recall@K，替换第 5.1 节的合成数字。",
            "第二台机器复现基准，形成区间而非单点。",
            "视需要再做压缩算法协商或 Builder 的 CSV/JSON 输入。",
        ],
        start=1,
    ):
        paragraph = document.add_paragraph()
        run = paragraph.add_run(f"{index}. {item}")
        style_run(run, size=10.5)

    document.save(target)


if __name__ == "__main__":
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/WeiSQL-项目状态报告.docx")
    output.parent.mkdir(parents=True, exist_ok=True)
    build(output)
    print(f"written: {output}")
