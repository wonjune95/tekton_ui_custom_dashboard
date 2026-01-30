// 이름을 하이픈/언더스코어/점/슬래시로 분해 + 공백제거 버전까지 인덱싱
function buildNameIndex(name = '') {
  const s = String(name).toLowerCase();
  const parts = s.split(/[-._/]+/g).filter(Boolean);   // ['sample','dev','deploy','pr']
  const joined = s.replace(/[-._/]+/g, '');            // 'sampledevdeploypr'
  return { raw: s, parts, joined };
}

// ✅ 공백으로 나눈 토큰은 OR 매칭, `-tok` 는 제외, 라벨은 key/value와 key=value / key:value 모두 인덱싱
export function applyClientTextFilter(items, q) {
  const qtrim = (q || '').trim();
  if (!qtrim || !Array.isArray(items)) return items;

  const tokensAll = qtrim.toLowerCase().split(/\s+/).filter(Boolean);
  const neg = tokensAll.filter(t => t.startsWith('-')).map(t => t.slice(1));
  const pos = tokensAll.filter(t => !t.startsWith('-'));

  return items.filter(it => {
    const md = it?.metadata || {};
    const name = md.name || '';

    // 1) 이름 우선 매칭 (OR)
    const { raw, parts, joined } = buildNameIndex(name);

    // 제외 토큰: 이름/기타 전체에서 걸러냄
    // (기타 필드를 계산하기 전 이름에서 먼저 빠르게 체크)
    if (neg.some(tok => raw.includes(tok) || joined.includes(tok) || parts.some(p => p.includes(tok)))) {
      return false;
    }

    // 이름에서 OR로 매칭되면 바로 통과 (일반 검색 감각)
    const nameHit =
      pos.length === 0 || // 양수 토큰이 없으면(제외만 있으면) 통과
      pos.some(tok => raw.includes(tok) || joined.includes(tok) || parts.some(p => p.includes(tok)));
    if (nameHit) return true;

    // 2) 이름에서 못 찾은 경우, 보조 필드(라벨/어노테이션/spec/status 등)에서 OR 매칭
    const spec = it?.spec || {};
    const status = it?.status || {};

    const bag = [];

    // ⚠ apiVersion(예: tekton.dev/v1)은 dev에 과매칭되므로 제외
    bag.push(
      it?.kind,
      md.generateName,
      md.namespace,
      md.uid
    );

    // labels: key, value, key=value, key:value 모두 인덱싱
    const labels = md.labels || {};
    Object.entries(labels).forEach(([k, vRaw]) => {
      const v = String(vRaw ?? '');
      bag.push(k, v, `${k}=${v}`, `${k}:${v}`);
    });

    // annotations
    const ann = md.annotations || {};
    Object.entries(ann).forEach(([k, v]) => {
      bag.push(k, String(v ?? ''));
    });

    // ownerReferences
    (md.ownerReferences || []).forEach(o => {
      bag.push(o?.kind, o?.name);
    });

    // Tekton 자주 쓰는 spec 필드
    if (spec.serviceAccountName) bag.push(spec.serviceAccountName);
    if (spec.taskRunTemplate?.serviceAccountName) bag.push(spec.taskRunTemplate.serviceAccountName);
    if (spec.pipelineRef?.name) bag.push(spec.pipelineRef.name);
    if (spec.taskRef?.name) bag.push(spec.taskRef.name);

    // params / workspaces / status
    (spec.params || []).forEach(p => {
      bag.push(p?.name);
      bag.push(typeof p?.value === 'object' ? JSON.stringify(p.value) : String(p?.value ?? ''));
    });
    (spec.workspaces || []).forEach(w => bag.push(w?.name));
    (status.conditions || []).forEach(c => bag.push(c?.reason, c?.message));

    const hayOther = bag
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .join(' ')
      .toLowerCase();

    // 제외 토큰
    if (neg.some(tok => hayOther.includes(tok))) return false;

    // 보조 필드에서도 OR로 매칭
    return pos.length === 0 || pos.some(tok => hayOther.includes(tok));
  });
}
