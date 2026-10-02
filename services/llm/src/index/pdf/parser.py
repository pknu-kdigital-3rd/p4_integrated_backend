"""Parse KOSHA GUIDE PDFs into the indexing document model.

KOSHA guides follow a regular numbered outline ("1. 목적", "2. 적용범위",
"4.1 …"), which the shared ``build_structure`` already understands. This
parser only has to turn page text into clean reading-order ``Block``s:

* Word spaces are rebuilt from character gaps. The PDFs position Korean
  glyphs individually without space characters, so PyMuPDF's plain text
  glues words together ("덤프트럭및화물자동차"), which hurts both BM25 and
  readability.
* Running headers/footers ("KOSHA GUIDE", "C - 114 - 2020", "- 3 -") are
  dropped.
* Letter-spaced headings split over two lines ("1. 목" / "적") are joined.
* Wrapped lines are merged into paragraphs; a new paragraph starts at a
  numbered heading or a list marker such as "(1)", "(가)", "가.".
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from ..html.models import Block, DocMeta, Document
from ..html.structure import Section, build_structure

# A gap wider than this fraction of the font size between two glyphs is a space.
SPACE_GAP_RATIO = 0.18
# A line ending this close to the page's text right edge was wrapped by layout.
WRAP_RIGHT_MARGIN_RATIO = 0.92

_GUIDE_CODE = re.compile(r"^([A-Z](?:-[A-Z])?-\d+-\d{4})\s*(.*)$")
_RUNNING_LINE = (
    re.compile(r"^KOSHA\s*GUIDE$", re.I),
    re.compile(r"^[A-Z](?:\s*-\s*[A-Z])?\s*-\s*\d+\s*-\s*\d{4}$"),  # C - 114 - 2020
    re.compile(r"^-\s*\d+\s*-$"),                                     # - 3 -
)
_NUMBERED = re.compile(r"^\d+(?:\.\d+)*\.?\s+\S")
_LIST_MARKER = re.compile(r"^(?:\(\s*[0-9가-힣a-zA-Z]{1,2}\s*\)|[가-힣]\.\s|[①-⑳]|[○●□■◦·•-]\s)")
_HANGUL = re.compile(r"[가-힣]")
_SENT_END = ("다.", "다", "음.", "함.", "것.", "요.")


@dataclass(slots=True)
class PdfLine:
    page: int
    text: str
    x1: float
    right_edge: float


def _line_text(line: dict) -> str:
    """Rebuild one PDF line, inserting spaces at wide glyph gaps."""
    text = ""
    previous = None
    for span in line.get("spans", []):
        size = float(span.get("size") or 10.0)
        for char in span.get("chars", []):
            glyph = char.get("c", "")
            if previous is not None and glyph and not glyph.isspace() and not text.endswith(" "):
                if char["bbox"][0] - previous["bbox"][2] > SPACE_GAP_RATIO * size:
                    text += " "
            text += glyph
            previous = char
    return unicodedata.normalize("NFC", re.sub(r"\s+", " ", text)).strip()


def _page_lines(page, number: int) -> list[PdfLine]:
    raw = page.get_text("rawdict")
    lines: list[PdfLine] = []
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            text = _line_text(line)
            if text:
                lines.append(PdfLine(page=number, text=text, x1=float(line["bbox"][2]), right_edge=0.0))
    right_edge = max((line.x1 for line in lines), default=0.0)
    for line in lines:
        line.right_edge = right_edge
    return lines


def _is_running_line(text: str) -> bool:
    return any(pattern.match(text) for pattern in _RUNNING_LINE)


def _is_heading(text: str) -> bool:
    """A numbered, title-like line ("1. 목적", "4.1 덤프트럭의 종류")."""
    if not _NUMBERED.match(text):
        return False
    # A clause number is small; "2020. 12." on the cover is a date.
    if int(re.match(r"\d+", text).group()) > 99:
        return False
    title = re.sub(r"^\d+(?:\.\d+)*\.?\s+", "", text)
    if not re.search(r"[가-힣A-Za-z]", title):
        return False
    return 0 < len(title) <= 40 and not title.endswith(_SENT_END) and not title.endswith((",", "，"))


def _starts_paragraph(text: str) -> bool:
    return bool(_NUMBERED.match(text) or _LIST_MARKER.match(text))


def _join(previous: PdfLine, current: str) -> str:
    """Join a wrapped continuation line; Korean words wrap mid-word."""
    wrapped = previous.right_edge and previous.x1 >= previous.right_edge * WRAP_RIGHT_MARGIN_RATIO
    tail, head = previous.text[-1:], current[:1]
    if wrapped and _HANGUL.match(tail or "") and _HANGUL.match(head or ""):
        return previous.text + current
    return f"{previous.text} {current}"


def _merge_lines(lines: list[PdfLine]) -> list[tuple[int, str, bool]]:
    """Merge PDF lines into (page, text, is_heading) paragraphs."""
    out: list[tuple[int, str, bool]] = []
    current: PdfLine | None = None
    current_heading = False

    def flush() -> None:
        nonlocal current
        if current is not None:
            out.append((current.page, current.text, current_heading))
        current = None

    for line in lines:
        text = line.text
        if _is_running_line(text):
            continue
        # Letter-spaced heading split over two lines: "1. 목" + "적".
        if current is not None and current_heading and len(text) <= 3 and _HANGUL.match(text[:1]) \
                and len(current.text.split(" ", 1)[-1]) <= 3:
            current = PdfLine(current.page, current.text + text, line.x1, line.right_edge)
            continue
        if current is None or _starts_paragraph(text) or current_heading:
            flush()
            current = PdfLine(line.page, text, line.x1, line.right_edge)
            current_heading = _is_heading(text)
            continue
        current = PdfLine(current.page, _join(current, text), line.x1, line.right_edge)
    flush()
    return out


def guide_title(path: Path) -> tuple[str, str]:
    """Return (guide code, title) from a KOSHA file name."""
    stem = unicodedata.normalize("NFC", path.stem)
    match = _GUIDE_CODE.match(stem)
    if match:
        return match.group(1), match.group(2).strip() or stem
    return re.sub(r"\s+", "_", stem), stem


def extract_pdf_document(path: str | Path, corpus_root: str | Path) -> Document:
    """Build the ``Document`` contract used by chunking from a KOSHA PDF."""
    import pymupdf

    path = Path(path)
    lines: list[PdfLine] = []
    with pymupdf.open(path) as pdf:
        pages = pdf.page_count
        for number, page in enumerate(pdf, 1):
            lines.extend(_page_lines(page, number))

    paragraphs = _merge_lines(lines)
    blocks = [Block(kind="heading" if heading else "text", page=page, order=order, text=text)
              for order, (page, text, heading) in enumerate(paragraphs)]
    sections = build_structure(blocks)

    code, title = guide_title(path)
    try:
        relpath = path.resolve().relative_to(Path(corpus_root).resolve()).as_posix()
    except ValueError:
        relpath = path.name
    series = code.split("-", 1)[0] if "-" in code else ""
    meta = DocMeta(
        doc_id=code, title=f"{code} {title}".strip(), pages=pages,
        source_relpath=unicodedata.normalize("NFC", relpath),
        category="KOSHA GUIDE", subcategory=series,
        category_path=f"KOSHA GUIDE / {code} {title}".strip(),
    )
    if not any(section.level > 0 for section in sections):
        sections = [Section(clause=code, level=1, title=title, heading_path=meta.title,
                            page_start=1, page_end=pages, blocks=blocks)]
    return Document(meta=meta, sections=sections)
