// LabelFilter가 전역 이벤트/URL ?q=로 뿌린 검색어를 읽는 채널
let currentQ = '';

function readQFromUrl() {
  try {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    return url.searchParams.get('q') || '';
  } catch {
    return '';
  }
}

export function getCurrentTextQuery() {
  if (!currentQ) currentQ = readQFromUrl();
  return currentQ;
}
