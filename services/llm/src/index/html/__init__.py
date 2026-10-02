"""Shared document model and heading-tree construction (used by the PDF path)."""

from .models import Block, DocMeta, Document
from .structure import Section, build_structure

__all__ = ["Block", "DocMeta", "Document", "Section", "build_structure"]
