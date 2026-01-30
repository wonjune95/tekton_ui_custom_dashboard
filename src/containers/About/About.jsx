/*
Copyright 2020-2025 The Tekton Authors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/* istanbul ignore file */
import { Fragment, useEffect, useRef, useState, useMemo } from 'react';
import { useIntl } from 'react-intl';
import {
    InlineNotification,
    SkeletonText,
    Tile,
    usePrefix
} from '@carbon/react';
import { getErrorMessage, useTitleSync, getStatus, isRunning, isPending } from '@tektoncd/dashboard-utils';
import { useProperties } from '../../api';
import tektonLogo from '../../images/tekton-dashboard-color.svg';

/* =========================
    공통: 경로 유틸 + 안전 fetch
    ========================= */
const PROXY_BASES = [
    'proxy',
    'v1/proxy',
    '',
];

function join(base, path) {
    const b = base ? `${base.replace(/^\/+|\/+$/g, '')}/` : '';
    const p = path.replace(/^\/+/, '');
    return `${b}${p}`;
}

async function safeGetJSON(url) {
    try {
        const res = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        // eslint-disable-next-line no-console
        console.debug('[About.jsx] GET', url, '→', res.status, data?.items?.length ?? (Array.isArray(data) ? data.length : '-'));
        return { ok: res.ok, status: res.status, data, tried: url };
    } catch (e) {
        // eslint-disable-next-line no-console
        console.debug('[About.jsx] GET FAIL', url, e?.message);
        return { ok: false, status: 0, data: null, tried: url };
    }
}

/* =========================
    데이터 수집 유틸
    ========================= */
async function listNamespaces() {
    for (const base of PROXY_BASES) {
        const url = join(base, 'api/v1/namespaces');
        const r = await safeGetJSON(url);
        const arr = Array.isArray(r?.data?.items) ? r.data.items : (Array.isArray(r?.data) ? r.data : []);
        if (arr.length) {
            return arr
                .map(n => n?.metadata?.name)
                .filter(name => !!name && name.endsWith('-cicd'))
                .sort((a, b) => a.localeCompare(b));
        }
    }
    return [];
}

async function listAllPipelineRuns(nsList) {
    const versions = ['v1beta1', 'v1'];

    // 1) cluster-wide
    for (const base of PROXY_BASES) {
        for (const v of versions) {
            let url = join(base, `apis/tekton.dev/${v}/pipelineruns?limit=500`);
            let items = [];
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const r = await safeGetJSON(url);
                if (!r.ok || !r.data) break;
                const page = Array.isArray(r.data?.items) ? r.data.items : (Array.isArray(r.data) ? r.data : []);
                items = items.concat(page);
                const token = r.data?.metadata?.continue;
                if (token) {
                    url = join(base, `apis/tekton.dev/${v}/pipelineruns?limit=500&continue=${encodeURIComponent(token)}`);
                    continue;
                }
                if (items.length) return items;
                break;
            }
        }
    }

    // 2) fallback: ns별 합산
    let all = [];
    for (const ns of nsList) {
        for (const base of PROXY_BASES) {
            for (const v of versions) {
                const url = join(base, `apis/tekton.dev/${v}/namespaces/${ns}/pipelineruns`);
                const r = await safeGetJSON(url);
                const d = r?.data;
                const page = Array.isArray(d?.items) ? d.items : (Array.isArray(d) ? d : []);
                if (page.length) { all = all.concat(page); break; }
            }
        }
    }
    return all;
}


/* =========================
    커스텀 훅: 파이프라인 통계
    ========================= */
const PALETTE = [
    // 1~10: 기본 강조 색상 (Vivid & Distinct)
    '#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#76B7B2', 
    '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
    
    // 11~20: 깊은 톤 (Deep & Strong)
    '#1F77B4', '#FF7F0E', '#2CA02C', '#D62728', '#9467BD', 
    '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',

    // 21~30: 밝은 파스텔 톤 (Light & Soft)
    '#AEC7E8', '#FFBB78', '#98DF8A', '#FF9896', '#C5B0D5', 
    '#C49C94', '#F7B6D2', '#C7C7C7', '#DBDB8D', '#9EDAE5',

    // 31~40: 추가 변형 색상 (Rich & Darker)
    '#393B79', '#5254A3', '#6B6ECF', '#9C9EDE', '#637939', 
    '#8CA252', '#B5CF6B', '#CEDB9C', '#8C6D31', '#BD9E39',

    // 41~50: 보라/분홍/청록 계열 확장 (Cool & Warm Mix)
    '#E7BA52', '#E7CB94', '#843C39', '#AD494A', '#D6616B', 
    '#E7969C', '#7B4173', '#A55194', '#CE6DBD', '#DE9ED6'
];

// 네임스페이스 이름의 해시 값 기반으로 색상 인덱스 계산 (13개 이상일 때 사용)
function getHashColor(ns) {
    const idx = Math.abs([...ns].reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)) % PALETTE.length;
    return PALETTE[idx];
}

function usePipelineStats() {
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [namespaces, setNamespaces] = useState([]);
    const [countsByNS, setCountsByNS] = useState({});
    
    // 네트워킹 동시 호출 방지용 Ref
    const loadingRef = useRef(false);
    const firstLoadRef = useRef(true);

    const handleRefresh = () => {
        if (loadingRef.current) return;
        setReloadKey(k => k + 1);
    };

    // 자동 새로고침 (기존 로직 유지)
    const [autoRefreshMs, setAutoRefreshMs] = useState(() => {
        if (typeof window === 'undefined') return 10000;
        const v = localStorage.getItem('about:autoRefreshMs');
        return v ? Number(v) : 10000;
    });
    
    useEffect(() => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('about:autoRefreshMs', String(autoRefreshMs));
        }
    }, [autoRefreshMs]);

    // 💡 useMemo를 사용하여 네임스페이스 목록에 기반한 색상 맵 생성 (겹침 방지 로직)
    const NS_COLOR_MAP = useMemo(() => {
        const newMap = {};
        for (let i = 0; i < namespaces.length; i++) {
            const ns = namespaces[i];
            
            if (i < PALETTE.length) {
                // 네임스페이스가 12개 이하일 경우, 순차적으로 팔레트 색상을 할당하여 겹침 방지
                newMap[ns] = PALETTE[i];
            } else {
                // 12개를 초과할 경우, 해시 충돌 가능성이 있지만 분산을 위해 해시 기반 색상 할당
                newMap[ns] = getHashColor(ns);
            }
        }
        return newMap;
    }, [namespaces]); // namespaces 목록이 변경될 때만 재계산

    // 💡 About 컴포넌트가 사용할 네임스페이스 색상 조회 함수
    const colorByNS = (ns) => {
        return NS_COLOR_MAP[ns] || getHashColor(ns); 
    };

    // 데이터 로드 (처음만 loading, 그 이후는 refreshing)
    useEffect(() => {
        let alive = true;
        (async () => {
            const first = firstLoadRef.current;
            if (first) setLoading(true); else setRefreshing(true);
            loadingRef.current = true;

            try {
                const nsList = await listNamespaces();
                if (!alive) return;
                
                // 네임스페이스 목록 업데이트 (colorByNS useMemo 트리거)
                setNamespaces(nsList); 
                
                const prs = await listAllPipelineRuns(nsList);
                if (!alive) return;

                const counts = {};
                for (const ns of nsList) counts[ns] = { pending: 0, running: 0, recent: 0 };
                const threshold = Date.now() - 12 * 60 * 60 * 1000;

                for (const pr of prs) {
                    const prNS = pr?.metadata?.namespace || 'default';
                    // 네임스페이스 목록에 있는 것만 집계 (listNamespaces에서 이미 *-cicd 필터링됨)
                    if (!nsList.includes(prNS)) continue; 
                    
                    if (!counts[prNS]) counts[prNS] = { pending: 0, running: 0, recent: 0 };

                    const { reason = '', status = '' } = getStatus(pr) || {};
                    if (isRunning(reason, status)) {
                        counts[prNS].running += 1;
                    } else if (isPending(reason, status)) {
                        counts[prNS].pending += 1;
                    }

                    const ts = pr?.status?.startTime ? Date.parse(pr.status.startTime) : 0;
                    if (ts >= threshold) counts[prNS].recent += 1;
                }

                setCountsByNS(counts);
                setLastUpdated(new Date());
            } finally {
                loadingRef.current = false;
                if (first) {
                    setLoading(false);
                    firstLoadRef.current = false;
                }
                setRefreshing(false);
            }
        })();
        return () => { alive = false; };
    }, [reloadKey]);

    // 자동 새로고침 타이머 (기존 로직 유지)
    useEffect(() => {
        if (!autoRefreshMs) return;
        const tick = () => {
            if (document.hidden) return;
            if (loadingRef.current) return;
            setReloadKey(k => k + 1);
        };
        const id = setInterval(tick, autoRefreshMs);
        const onVis = () => { if (!document.hidden) tick(); };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [autoRefreshMs]);

    return {
        loading,
        refreshing,
        lastUpdated,
        namespaces,
        countsByNS,
        colorByNS,
        handleRefresh,
        autoRefreshMs,
        setAutoRefreshMs,
        isLoadingOrRefreshing: loadingRef.current
    };
}


/* =========================
          SVG 도넛차트
   ========================= */
function DonutChart({ title, data, onSegmentClick }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [hoveredData, setHoveredData] = useState(null);

    const size = 200;
    const r = 68;
    const stroke = 28;
    
    const C = useMemo(() => 2 * Math.PI * r, []); 
    const total = data.reduce((s, d) => s + d.value, 0);

    const centerValue = hoveredData ? hoveredData.value : total;
    const centerLabel = hoveredData ? hoveredData.label : 'Total';
    const centerColor = hoveredData ? hoveredData.color : '#333';

    const renderSvg = (children, { muted = false } = {}) => (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label={`${title}: ${total}`}
        >
            <g transform={`translate(${size / 2}, ${size / 2})`}>
                <circle
                    r={r}
                    fill="none"
                    stroke={muted ? '#e5e7eb' : '#f3f4f6'}
                    strokeWidth={stroke}
                />
                {children}
                <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={centerColor}
                    style={{ pointerEvents: 'none', transition: 'fill 0.2s' }}
                >
                    <tspan x="0" dy="-6" fontSize="28" fontWeight="700">
                        {centerValue}
                    </tspan>
                    <tspan x="0" dy="24" fontSize="12" fill="#6f6f6f" fontWeight="500">
                        {centerLabel.length > 12 ? centerLabel.slice(0, 10) + '..' : centerLabel}
                    </tspan>
                </text>
            </g>
        </svg>
    );

    if (!total) {
        return (
            <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                width: '100%' 
            }}>
                <h3 style={{ 
                    margin: '0 0 12px 0',
                    fontSize: '0.9rem', 
                    color: '#525252',
                    fontWeight: 600,
                    alignSelf: 'flex-start',
                    width: '100%' 
                }}>
                    {title}
                </h3>
                {renderSvg(null, { muted: true })}
                <span style={{ marginTop: 8, color: '#8d8d8d', fontSize: '0.9rem' }}>데이터 없음</span>
            </div>
        );
    }

    let offset = 0;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
            
            {/* 데이터가 있을 때 제목 */}
            <h3 style={{ 
                margin: '0 0 12px 0', 
                fontSize: '0.9rem', 
                color: '#525252',
                fontWeight: 600, 
                alignSelf: 'flex-start' 
            }}>
                {title}
            </h3>

            <div style={{ marginBottom: 12 }}>
                {renderSvg(
                    data.map(seg => {
                        const pct = seg.value / total;
                        const len = C * pct;
                        const arc = (
                            <circle
                                key={seg.label}
                                r={r}
                                fill="none"
                                stroke={seg.color}
                                strokeWidth={stroke}
                                strokeDasharray={`${len} ${C - len}`}
                                strokeDashoffset={-offset}
                                transform="rotate(-90)"
                                onClick={() => onSegmentClick && onSegmentClick(seg.link)}
                                onMouseEnter={() => setHoveredData(seg)}
                                onMouseLeave={() => setHoveredData(null)}
                                style={{ 
                                    cursor: 'pointer', 
                                    transition: 'stroke-width 0.2s, opacity 0.2s',
                                    opacity: (hoveredData && hoveredData.label !== seg.label) ? 0.3 : 1
                                }}
                            >
                                <title>{`${seg.label}: ${seg.value}`}</title>
                            </circle>
                        );
                        offset += len;
                        return arc;
                    })
                )}
            </div>

            <button
                onClick={() => setIsExpanded(!isExpanded)}
                style={{
                    background: 'none',
                    border: 'none',
                    color: '#0f62fe',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '6px 12px',
                    borderRadius: 4,
                }}
                onMouseEnter={(e) => e.target.style.background = '#edf5ff'}
                onMouseLeave={(e) => e.target.style.background = 'none'}
            >
                {isExpanded ? '접기' : '상세 목록 보기'} 
                <span style={{ 
                    transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', 
                    transition: 'transform 0.2s',
                    fontSize: '0.8rem' 
                }}>▼</span>
            </button>

            {isExpanded && (
                <div style={{ 
                    display: 'grid', 
                    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', 
                    gap: '8px 10px',
                    width: '100%',
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: '1px solid #e0e0e0',
                    animation: 'fadeIn 0.3s ease-in-out'
                }}>
                    {data.map(d => (
                        <div 
                            key={d.label} 
                            style={{ 
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: 6, 
                                cursor: 'pointer',
                                padding: '4px 6px',
                                borderRadius: 4
                            }}
                            onClick={() => onSegmentClick && onSegmentClick(d.link)}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = '#f4f4f4';
                                setHoveredData(d);
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent';
                                setHoveredData(null);
                            }}
                        >
                            <span style={{ 
                                width: 8, height: 8, borderRadius: '50%',
                                background: d.color, display: 'inline-block', flexShrink: 0
                            }} />
                            <span style={{ 
                                fontSize: '0.8rem', color: '#393939',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                            }}>
                                {d.label} <span style={{ color: '#888' }}>({d.value})</span>
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        </div>
    );
}

/* =========================
    About (최종 리팩토링)
    ========================= */
export function About() {
    const intl = useIntl();
    const carbonPrefix = usePrefix();
    useTitleSync({
        page: intl.formatMessage({ id: 'dashboard.about.title', defaultMessage: 'About Tekton' })
    });

    const { data, isPlaceholderData } = useProperties();
    const {
        dashboardNamespace,
        dashboardVersion,
        isReadOnly,
        logoutURL,
        pipelinesNamespace,
        pipelinesVersion,
        triggersNamespace,
        triggersVersion
    } = data || {};

    const {
        loading,
        refreshing,
        namespaces,
        countsByNS,
        colorByNS,
        handleRefresh,
        isLoadingOrRefreshing
    } = usePipelineStats();
    
    const [selectedNS, setSelectedNS] = useState('ALL');


    const getDisplayValue = value =>
        (value === true ? intl.formatMessage({ id: 'dashboard.about.true', defaultMessage: 'True' }) : value);


    const checkMissingProperties = () => {
        if (isPlaceholderData) return null;
        const propertiesToCheck = {
            dashboardNamespace,
            dashboardVersion,
            pipelinesNamespace,
            pipelinesVersion
        };
        const errorsFound = Object.keys(propertiesToCheck)
            .map(key => (propertiesToCheck[key] ? null : key))
            .filter(Boolean);

        return errorsFound.length
            ? intl.formatMessage(
                { id: 'dashboard.about.missingProperties', defaultMessage: 'Could not find: {errorsFound}' },
                { errorsFound: errorsFound.join(', ') }
            )
            : null;
    };

    const getField = (property, value) => {
        const displayValue = getDisplayValue(value);
        return (
            displayValue && (
                <Fragment key={property}>
                    <dt className={`${carbonPrefix}--label`}>{property}</dt>
                    <dd>{displayValue}</dd>
                </Fragment>
            )
        );
    };

    const error = checkMissingProperties();

    const buildData = (key) => {
        const entries = Object.entries(countsByNS);
        const filtered = selectedNS === 'ALL' ? entries : entries.filter(([ns]) => ns === selectedNS);
        return filtered
            .map(([ns, c]) => ({ label: ns, value: c[key] || 0, color: colorByNS(ns) }))
            .filter(d => d.value > 0);
    };

    const refreshButtonText = isLoadingOrRefreshing
        ? intl.formatMessage({ id: 'dashboard.about.refreshing', defaultMessage: '새로고침 중...' })
        : intl.formatMessage({ id: 'dashboard.about.refresh', defaultMessage: '새로고침' });
        
    const spinStyle = {
        width: 14,
        height: 14,
        border: '2px solid #8d8d8d',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: 'tknSpin 1s linear infinite',
        opacity: isLoadingOrRefreshing ? 1 : 0,
        transition: 'opacity .2s',
        pointerEvents: 'none',
        marginRight: isLoadingOrRefreshing ? '0.5rem' : '0'
    };


    return (
        <div className="tkn--about">
            <div className="tkn--css-grid tkn--about-header">
                <header>
                    <h1 id="main-content-header">
                        {intl.formatMessage({ id: 'dashboard.about.title', defaultMessage: 'About Tekton' })}
                    </h1>
                    <p>
                        {intl.formatMessage({
                            id: 'dashboard.about.description',
                            defaultMessage:
                                'Tekton is a powerful and flexible open-source framework for creating CI/CD systems, allowing developers to build, test, and deploy across cloud providers and on-premises systems.'
                        })}
                    </p>
                </header>
                <img
                    alt={intl.formatMessage({ id: 'dashboard.logo.alt', defaultMessage: 'Tekton logo' })}
                    role="presentation"
                    src={tektonLogo}
                    title={intl.formatMessage({ id: 'dashboard.logo.tooltip', defaultMessage: 'Meow' })}
                />
            </div>

            {error && (
                <InlineNotification
                    kind="error"
                    title={intl.formatMessage({ id: 'dashboard.about.error', defaultMessage: 'Error getting data' })}
                    subtitle={getErrorMessage(error)}
                    lowContrast
                />
            )}

            {/* ▼ 파이프라인 현황 */}
            <section className="tkn--css-grid" style={{ opacity: refreshing ? 0.96 : 1, transition: 'opacity .2s' }}>
                <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
                        <h2 className="tkn--section-title" style={{ marginBottom: 0 }}>파이프라인 현황</h2>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: '#6f6f6f', fontSize: '0.9rem' }}>네임스페이스 선택</span>
                            <select
                                value={selectedNS}
                                onChange={e => setSelectedNS(e.target.value)}
                                style={{ padding: '6px 8px', border: '1px solid #e5e5e5', borderRadius: 8 }}
                            >
                                <option value="ALL">모든 네임스페이스</option>
                                {namespaces.map(ns => (
                                    <option key={ns} value={ns}>{ns}</option>
                                ))}
                            </select>
                        </label>

                        <style>{`@keyframes tknSpin { to { transform: rotate(360deg); } }`}</style>

                        <button
                            onClick={handleRefresh}
                            style={{
                                padding: '6px 12px',
                                border: '1px solid #e0e0e0',
                                borderRadius: 8,
                                background: '#fff',
                                cursor: isLoadingOrRefreshing ? 'not-allowed' : 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center'
                            }}
                            aria-label="새로고침"
                            title="새로고침"
                            disabled={isLoadingOrRefreshing}
                        >
                            <span
                                aria-hidden="true"
                                style={spinStyle}
                            />
                            {refreshButtonText}
                        </button>
                    </div>
                </header>

                <Tile style={{ paddingBottom: '1rem' }}>
                    {loading ? <SkeletonText paragraph /> : (
                        <DonutChart title="총 파이프라인" data={buildData('pending')} />
                    )}
                </Tile>

                <Tile style={{ paddingBottom: '1rem' }}>
                    {loading ? <SkeletonText paragraph /> : (
                        <DonutChart title="실행 중 파이프라인" data={buildData('running')} />
                    )}
                </Tile>

                <Tile style={{ paddingBottom: '1rem' }}>
                    {loading ? <SkeletonText paragraph /> : (
                        <DonutChart title="최근 실행된 파이프라인 (12시간)" data={buildData('recent')} />
                    )}
                </Tile>
            </section>

            {/* ▼ 기존 환경 세부정보 */}
            <section className="tkn--css-grid">
                <header>
                    <h2 className="tkn--section-title">
                        {intl.formatMessage({ id: 'dashboard.about.environmentDetails', defaultMessage: 'Environment details' })}
                    </h2>
                </header>
                <Tile id="tkn--about--dashboard-tile">
                    <h3>Dashboard</h3>
                    {isPlaceholderData ? (
                        <SkeletonText paragraph />
                    ) : (
                        <dl>
                            {[
                                getField('ReadOnly', isReadOnly),
                                getField('LogoutURL', logoutURL),
                                getField('Namespace', dashboardNamespace),
                                getField('Version', dashboardVersion)
                            ].filter(Boolean)}
                        </dl>
                    )}
                </Tile>
                <Tile id="tkn--about--pipelines-tile">
                    <h3>Pipelines</h3>
                    {isPlaceholderData ? (
                        <SkeletonText paragraph />
                    ) : (
                        <dl>
                            {[
                                getField('Namespace', pipelinesNamespace),
                                getField('Version', pipelinesVersion)
                            ].filter(Boolean)}
                        </dl>
                    )}
                </Tile>
                {!!(triggersNamespace && triggersVersion) && (
                    <Tile id="tkn--about--triggers-tile">
                        <h3>Triggers</h3>
                        {isPlaceholderData ? (
                            <SkeletonText paragraph />
                        ) : (
                            <dl>
                                {[
                                    getField('Namespace', triggersNamespace),
                                    getField('Version', triggersVersion)
                                ].filter(Boolean)}
                            </dl>
                        )}
                    </Tile>
                )}
            </section>
        </div>
    );
}

export default About;