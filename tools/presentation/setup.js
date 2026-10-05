// A session token accepted only by the isolated presentation host.
sessionStorage.setItem('itsToken','local-presentation-only');
for (const paragraph of document.querySelectorAll('#assistant-drawer p')) {
  if (paragraph.textContent.includes('KOSHA')) {
    paragraph.textContent='발표용 스크립트 응답입니다. 실제 AI 분석이나 문서 검색을 수행하지 않습니다.';
  }
}
