"""Small-to-big (parent-document) chunks for RAG.

Two linked granularities:

  * CHILD chunks are fine-grained (~450 chars). You embed and search these;
    small text gives a precise similarity match.
  * PARENT chunks are the enclosing section (up to ~3000 chars). After a child
    matches, you fetch its parent and hand THAT to the LLM, so the answer sees
    full context instead of a sentence fragment.

Children are always splits of the exact same text as their parent, so every
child nests inside its parent by construction -- dereferencing a child's
parent_id can never return mismatched text.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from core.config import Chunk as ChunkCfg
from .html.models import Block, Document
from .html.structure import Section

_SENT_SPLIT = re.compile(r"(?<=[.!?。])\s+")


@dataclass(slots=True)
class Parent:
    doc_id: str
    parent_id: str
    clause: str
    heading_path: str
    level: int
    text: str
    page_start: int
    page_end: int


@dataclass(slots=True)
class Child:
    doc_id: str
    child_id: str
    parent_id: str
    clause: str
    heading_path: str
    level: int
    text: str
    page_start: int
    page_end: int


def _section_text(sec: Section) -> str:
    """The section's body: its non-empty blocks joined in reading order."""
    return "\n\n".join(b.text for b in sec.blocks if b.text.strip()).strip()


def _split_prose(text: str, limit: int) -> list[str]:
    """Break prose into <=limit pieces on paragraph then sentence boundaries."""
    if len(text) <= limit:
        return [text]
    pieces, cur = [], ""
    units: list[str] = []
    for para in text.split("\n\n"):
        if len(para) <= limit:
            units.append(para)
        else:
            acc = ""
            for sent in _SENT_SPLIT.split(para):
                if acc and len(acc) + len(sent) + 1 > limit:
                    units.append(acc); acc = ""
                acc = f"{acc} {sent}".strip()
            if acc:
                units.append(acc)
    for u in units:
        if cur and len(cur) + len(u) + 2 > limit:
            pieces.append(cur); cur = ""
        cur = f"{cur}\n\n{u}".strip()
    if cur:
        pieces.append(cur)
    return pieces


def _pack(text: str, target: int, hard_max: int) -> list[str]:
    """Split `text` at `hard_max`, then greedily regroup pieces up to `target`."""
    groups: list[str] = []
    cur: list[str] = []
    cur_len = 0

    def close():
        """Flush the current in-progress group into `groups` and reset it."""
        nonlocal cur, cur_len
        if cur:
            groups.append("\n\n".join(cur).strip())
            cur, cur_len = [], 0

    for piece in _split_prose(text, hard_max):
        if cur_len + len(piece) > hard_max and cur:
            close()
        cur.append(piece)
        cur_len += len(piece)
        if cur_len >= target:
            close()
    close()
    return groups


def _parent_clause(clause: str) -> str:
    """Immediate parent clause: 6.3.2 -> 6.3, 부록1.2 -> 부록1, 5 -> 5."""
    if "." in clause:
        return clause.rsplit(".", 1)[0]
    return clause


def _leaf_units(sections: list[Section], cfg: ChunkCfg) -> list[Section]:
    """Content-bearing units to turn into parents.

    'section'        one clause each, tiny ones folded into a prior sibling.
    'parent_clause'  each clause rolled up with its descendants, so a parent
                     carries a whole clause family for richer answer context.
    """
    leaves = [s for s in sections if _section_text(s)]

    if cfg.parent_scope != "parent_clause":
        # 'section': one clause per unit, but fold under-sized siblings together
        merged: list[Section] = []
        for sec in leaves:
            if (merged and len(_section_text(sec)) < cfg.min_chars
                    and merged[-1].heading_path == sec.heading_path):
                merged[-1].blocks.extend(sec.blocks)
                merged[-1].page_end = max(merged[-1].page_end, sec.page_end)
            else:
                merged.append(sec)
        return merged

    by_clause = {s.clause: s for s in sections if s.clause}
    groups: dict[str, list[Section]] = {}
    order: list[str] = []
    for s in leaves:
        key = _parent_clause(s.clause) or s.clause or f"_{s.page_start}"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(s)

    units: list[Section] = []
    for key in order:
        members = groups[key]
        head = by_clause.get(key)
        unit_path = head.heading_path if head else members[0].heading_path
        blocks: list[Block] = []
        for m in members:
            # The rolled-up unit's heading_path is only the parent clause (e.g.
            # '6.2'), so a child would otherwise lose the sub-section's own
            # title. Prepend it so the sub-heading stays in the searchable child
            # text -- but skip the member that already supplies the unit path
            # (else it is duplicated).
            sub = f"{m.clause} {m.title}".strip()
            if sub and m.clause and m.heading_path != unit_path:
                # order=0 would collide with source order (which also starts at
                # 0), so tie the synthetic block to the member's first real one.
                sub_order = m.blocks[0].order if m.blocks else 0
                blocks.append(Block(kind="text", page=m.page_start,
                                    order=sub_order, text=sub))
            blocks.extend(m.blocks)
        units.append(Section(
            clause=key,
            level=head.level if head else members[0].level,
            title=head.title if head else members[0].title,
            heading_path=unit_path,
            page_start=min(m.page_start for m in members),
            page_end=max(m.page_end for m in members),
            blocks=blocks,
        ))
    return units


def chunk_document(doc: Document, cfg: ChunkCfg) -> tuple[list[Parent], list[Child]]:
    """Build the full set of small-to-big (parent, child) chunks for one document.

    Groups the document's sections into leaf units (per `cfg.parent_scope`),
    then packs each unit's prose into parent chunks and splits every parent
    into its search children. Both carry the unit's heading path as a leading
    header line, so a retrieved fragment still says where it came from.

    Args:
        doc: The parsed document (sections of blocks) to chunk.
        cfg: Chunking config -- child/parent size targets and `parent_scope`
            ("section" or "parent_clause").

    Returns:
        `(parents, children)` -- children reference their parent by
        `parent_id`, and every child nests inside its parent's text.
    """
    parents: list[Parent] = []
    children: list[Child] = []

    for ui, sec in enumerate(_leaf_units(doc.sections, cfg), 1):
        body = _section_text(sec)
        if not body:
            continue
        path = sec.heading_path or f"{sec.clause} {sec.title}".strip()
        header = f"{path}\n\n" if path else ""
        # the unit index keeps ids unique even when clause is empty (front
        # matter, unnumbered headings) -- otherwise sections collide on '::x'
        unit_key = f"{sec.clause or 'x'}#{ui}"

        for pi, parent_body in enumerate(_pack(body, cfg.parent_max, cfg.parent_max), 1):
            pid = f"{doc.meta.doc_id}::{unit_key}::p{pi}"
            parents.append(Parent(
                doc_id=doc.meta.doc_id, parent_id=pid, clause=sec.clause,
                heading_path=path, level=sec.level,
                text=f"{header}{parent_body}",
                page_start=sec.page_start, page_end=sec.page_end,
            ))
            for ci, child_body in enumerate(
                    _pack(parent_body, cfg.child_target, cfg.child_max), 1):
                children.append(Child(
                    doc_id=doc.meta.doc_id, child_id=f"{pid}::c{ci}",
                    parent_id=pid, clause=sec.clause, heading_path=path,
                    level=sec.level, text=f"{header}{child_body}",
                    page_start=sec.page_start, page_end=sec.page_end,
                ))

    return parents, children


def to_dicts(items) -> list[dict]:
    """Convert `Parent`/`Child` instances to plain dicts (for JSONL serialization)."""
    return [asdict(i) for i in items]
