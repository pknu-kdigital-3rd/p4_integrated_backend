"""Lightweight document contracts shared by the HTML indexing path."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class Block:
    """One visible line of the source HTML, in reading order."""

    kind: str            # heading | text
    page: int
    order: int
    text: str = ""


@dataclass(slots=True)
class DocMeta:
    doc_id: str
    title: str
    pages: int
    source_relpath: str = ""
    category: str = ""
    subcategory: str = ""
    category_path: str = ""


@dataclass(slots=True)
class Document:
    meta: DocMeta
    sections: list[Any] = field(default_factory=list)
