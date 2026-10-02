"""Heading-tree construction for the HTML indexing path.

A heading is a clause-numbered line the parser marked as a heading, an
appendix marker, or a deep outline number ('6.2.3') that reads as a title.
Levels come from clause depth. Appendices get their own namespace (부록1.1),
so appendix clause '1 계산 목적' can never collide with body clause '1 목적'.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from .models import Block

NUM_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+(\S.*)$")
APPENDIX_RE = re.compile(r"^[<＜]?\s*부\s*록\s*(\d+)\s*[>＞]?\s*(.*)$")
_HANGUL_SYL = re.compile(r"^[가-힣]$")   # a single complete hangul syllable
# a title is a noun phrase; sentence-final endings mark prose, not a heading
_SENT_END = ("다.", "다", "음.", "음", "함.", "함", "것.", "것", "요.", "오.")
# unnumbered lines that read like headings but are prose connectors
_CONNECTORS = {"여기서", "여기서,", "다만", "다만,", "또한", "또한,", "참고", "비고", "주"}


def _norm(s: str) -> str:
    """NFC-normalize `s` and collapse runs of spaces/tabs, trimming ends."""
    return re.sub(r"[ \t]+", " ", unicodedata.normalize("NFC", s)).strip()


def collapse_letterspaced(text: str) -> str:
    """Join runs of >=2 single-syllable hangul TOKENS (letter-spacing / 자간).

    Headings are typeset spaced out ('점 검 항 목' for '점검항목', '비 고' for
    '비고'). Operates on whole space-delimited tokens, so a real two-word
    title like '점검 방법' (both multi-syllable) is left untouched.
    """
    tokens = text.split(" ")
    out: list[str] = []
    i, n = 0, len(tokens)
    while i < n:
        j = i
        while j < n and _HANGUL_SYL.match(tokens[j]):
            j += 1
        if j - i >= 2:                      # a run of single syllables -> one word
            out.append("".join(tokens[i:j]))
            i = j
        else:
            out.append(tokens[i])
            i += 1
    return " ".join(out)


@dataclass(slots=True)
class Section:
    clause: str            # '5.5.7.1', '부록1', '부록1.2', or '' for front matter
    level: int             # 0 for front matter, 1.. for headings
    title: str
    heading_path: str
    page_start: int
    page_end: int
    blocks: list[Block] = field(default_factory=list)


def _heading_of(b: Block):
    """Return (clause, level, title) if the block is a heading, else None."""
    # collapse letter-spacing in a heading ('1 목 적' -> '1 목적')
    t = collapse_letterspaced(_norm(b.text))
    marked = b.kind == "heading"

    m = APPENDIX_RE.match(t)
    if m:
        return (f"부록{m.group(1)}", 1, m.group(2).strip() or None)

    m = NUM_RE.match(t)
    if m:
        clause, title = m.group(1), m.group(2).strip()
        title = re.sub(r"[·․.]{2,}.*$", "", title).strip()   # stray leader dots
        # A deep outline number ('6.2.3', '8.1.1' -- 3+ levels) is a sub-section
        # by construction: it never appears as body enumeration the way '1.' or
        # '3.1' can, so trust the numbering itself even on an unmarked line.
        # Guard with a short, title-like line so a wrapped sentence or a
        # measurement isn't promoted.
        deep_outline = (clause.count(".") >= 2 and title and len(title) <= 40
                        and not title.endswith(_SENT_END)
                        and not title.endswith((",", "，")))
        if (marked or deep_outline) and title:
            return (clause, min(1 + clause.count("."), 6), title)
        return None

    # unnumbered heading: marked as a heading, reads like a title, and is not a
    # connector, list marker ('가.', '(1)'), or bulleted line
    if (marked and len(t) <= 40
            and not t.endswith(_SENT_END) and not t.endswith((",", "，"))
            and t not in _CONNECTORS
            and not re.match(r"^[가-힣]\s*[.)]\s", t)          # 가. 나. list marker
            and not re.match(r"^\([가-힣0-9]+\)", t)            # (1) (가) marker
            and not re.match(r"^[\W_]", t)):                     # □ ■ ○ ● bullets
        return (None, 1, t)
    return None


def build_structure(blocks: list[Block]) -> list[Section]:
    """Walk the blocks in reading order and build the heading tree.

    Returns:
        Sections in document order; a leading front-matter section (level 0)
        is included only if any content precedes the first real heading.
    """
    sections: list[Section] = []
    stack: list[Section] = []          # open ancestor headings
    current_appendix: str | None = None
    seen_unnumbered: set[str] = set()   # running titles repeat; real headings don't

    front = Section(clause="", level=0, title="front_matter", heading_path="",
                    page_start=1, page_end=1)

    def path_for() -> str:
        """Breadcrumb heading path ('6 > 6.2 > 6.2.3 제목') for the open stack."""
        return " > ".join(f"{s.clause} {s.title}".strip() for s in stack)

    def keep_as_body(b: Block) -> None:
        target = stack[-1] if stack else front
        target.blocks.append(b)
        target.page_end = max(target.page_end, b.page)

    for b in sorted(blocks, key=lambda x: x.order):
        h = _heading_of(b)
        if h is None:
            keep_as_body(b)
            continue

        clause, level, title = h

        # an unnumbered "heading" that repeats is a running header
        if clause is None:
            if title in seen_unnumbered:
                keep_as_body(b)
                continue
            seen_unnumbered.add(title)

        # appendix namespacing: inside an appendix, numeric clauses live under it
        if clause and clause.startswith("부록"):
            current_appendix = clause
        elif current_appendix and clause and clause[0].isdigit():
            clause = f"{current_appendix}.{clause}"
            level = min(1 + clause.count("."), 6)

        while stack and stack[-1].level >= level:
            stack.pop()
        sec = Section(clause=clause or "", level=level, title=title or "",
                      heading_path="", page_start=b.page, page_end=b.page)
        stack.append(sec)
        sec.heading_path = path_for()
        sections.append(sec)

    return [front] + sections if front.blocks else sections
