/*
Copyright 2019-2024 The Tekton Authors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ALL_NAMESPACES } from '@tektoncd/dashboard-utils';

import { createWebSocket, get, getAPIRoot } from './comms';

export const apiRoot = getAPIRoot();
export const tektonAPIGroup = 'tekton.dev';
export const triggersAPIGroup = 'triggers.tekton.dev';
export const dashboardAPIGroup = 'dashboard.tekton.dev';

/* ===== 전역 텍스트 검색 유틸 (추가) ===== */

// URL의 ?q= 값 읽기
function readQFromUrl() {
   return '';
}

// LabelFilter가 쏘는 전역 이벤트 구독
function onTextSearch(callback) {
  if (typeof window === 'undefined') return () => {};
  const handler = e => callback((e?.detail?.q || '').trim());
  window.addEventListener('tkn:textSearch', handler);
  return () => window.removeEventListener('tkn:textSearch', handler);
}

// 최종 필터:
//  - 공백 분리 토큰 = AND
//  - 제외 토큰: `-tok` 는 어디든 포함되면 제외
//  - 이름(name) 풀에서 먼저 AND 검사 → 안 맞으면 보조필드(other)까지 포함해 AND 검사
// 이름을 하이픈/언더스코어/점/슬래시로 분해 + 공백제거 버전까지 인덱싱
function tokenizeName(s = '') {
  const lower = String(s).toLowerCase();
  const parts = lower.split(/[-._/]+/g).filter(Boolean); // ['sample','dev','deploy','pr']
  const joined = lower.replace(/[-._/]+/g, '');          // 'sampledevdeploypr'
  return { lower, parts, joined };
}

// 최소화된 검색: 이름 + 네임스페이스만 확인, 공백 토큰은 AND 매칭
export function applyClientTextFilter(items, q) {
  const qtrim = (q || '').trim().toLowerCase();
  if (!qtrim || !Array.isArray(items)) return items;

  // 공백 기준으로 토큰 나눔 → 모든 토큰이 매칭돼야 통과 (AND)
  const tokens = qtrim.split(/\s+/).filter(Boolean);

  return items.filter(it => {
    const md = it?.metadata || {};
    const nameIdx = tokenizeName(md.name || '');
    const nsIdx   = tokenizeName(md.namespace || '');

    // 각 토큰이 '이름' 또는 '네임스페이스' 중 하나에라도 들어가면 OK
    return tokens.every(tok => {
      const inName =
        nameIdx.lower.includes(tok) ||
        nameIdx.joined.includes(tok) ||
        nameIdx.parts.some(p => p.includes(tok));

      const inNs = nsIdx.lower.includes(tok);

      return inName || inNs;
    });
  });
}
function shouldApplyTextFilter({ group, kind }) {
  const g = String(group || '').toLowerCase();
  const k = String(kind || '').toLowerCase();

  // 확장메뉴 데이터는 건드리지 말자
  if (g === dashboardAPIGroup.toLowerCase()) return false;      // e.g. dashboard.tekton.dev
  // 필요하면 더 엄격히: if (g === dashboardAPIGroup.toLowerCase() && k === 'extensions') return false;

  // Pipelines / Triggers 계열만 필터 대상
  return (
    g === tektonAPIGroup.toLowerCase() ||     // tekton.dev
    g === triggersAPIGroup.toLowerCase()      // triggers.tekton.dev
  );
}
/* ===== 유틸 끝 ===== */

export function getQueryParams({
  filters,
  involvedObjectKind,
  involvedObjectName
}) {
  if (filters?.length) {
    return { labelSelector: filters };
  }
  if (involvedObjectKind && involvedObjectName) {
    return {
      fieldSelector: [
        `involvedObject.kind=${involvedObjectKind}`,
        `involvedObject.name=${involvedObjectName}`
      ]
    };
  }
  return '';
}

export function getKubeAPI({
  group,
  kind,
  params: {
    filters,
    involvedObjectKind,
    involvedObjectName,
    isWebSocket,
    name = '',
    namespace,
    subResource
  } = {},
  queryParams,
  version
}) {
  const queryParamsToUse = {
    ...queryParams,
    ...(isWebSocket
      ? { [subResource === 'log' ? 'follow' : 'watch']: true }
      : null),
    ...(isWebSocket && name
      ? { fieldSelector: `metadata.name=${name}` }
      : null),
    ...getQueryParams({ filters, involvedObjectKind, involvedObjectName })
  };

  return [
    isWebSocket ? apiRoot.replace('http', 'ws') : apiRoot,
    group === 'core' ? `/api/${version}/` : `/apis/${group}/${version}/`,
    namespace && namespace !== ALL_NAMESPACES
      ? `namespaces/${encodeURIComponent(namespace)}/`
      : '',
    kind,
    '/',
    isWebSocket ? '' : encodeURIComponent(name),
    subResource ? `/${subResource}` : '',
    Object.keys(queryParamsToUse).length > 0
      ? `?${new URLSearchParams(queryParamsToUse).toString()}`
      : ''
  ].join('');
}

export async function defaultQueryFn({ queryKey, signal }) {
  const [group, version, kind, params] = queryKey;
  const url = getKubeAPI({ group, kind, params, version });
  const response = await get(url, undefined, { signal });
  if (typeof response === 'undefined') {
    return null;
  }
  return response;
}

export function isPipelinesV1ResourcesEnabled() {
  return localStorage.getItem('tkn-pipelines-v1-resources') !== 'false';
}

export function setPipelinesV1ResourcesEnabled(enabled) {
  localStorage.setItem('tkn-pipelines-v1-resources', enabled);
}

export function getTektonPipelinesAPIVersion() {
  return isPipelinesV1ResourcesEnabled() ? 'v1' : 'v1beta1';
}

export function isPipelineRunTabLayoutEnabled() {
  return localStorage.getItem('tkn-pipelinerun-tab-layout') === 'true';
}

export function setPipelineRunTabLayoutEnabled(enabled) {
  localStorage.setItem('tkn-pipelinerun-tab-layout', enabled);
}

export const NamespaceContext = createContext();
NamespaceContext.displayName = 'Namespace';

function getResourceVersion(resource) {
  return parseInt(resource.metadata.resourceVersion, 10);
}

function handleCreated({ group, kind, payload: _, queryClient, version }) {
  queryClient.invalidateQueries([group, version, kind]);
}

function handleDeleted({ group, kind, payload, queryClient, version }) {
  const {
    metadata: { name, namespace }
  } = payload;
  // remove any matching details page cache
  queryClient.removeQueries([
    group,
    version,
    kind,
    { name, ...(namespace && { namespace }) }
  ]);
  // remove resource from any list page caches
  queryClient.setQueriesData([group, version, kind], data => {
    if (!Array.isArray(data?.items)) {
      // another details page cache, but not the one we're looking for
      // since we've just deleted its query above
      return data;
    }
    return {
      ...data,
      items: data.items.filter(
        resource => resource.metadata.uid !== payload.metadata.uid
      )
    };
  });
}

function updateResource({ existing, incoming }) {
  return incoming.metadata.uid === existing.metadata.uid &&
    // only apply the update if it's newer than the version we already have
    getResourceVersion(incoming) > getResourceVersion(existing)
    ? incoming
    : existing;
}

function handleUpdated({ group, kind, payload, queryClient, version }) {
  const {
    metadata: { uid }
  } = payload;
  queryClient.setQueriesData([group, version, kind], data => {
    if (data?.metadata?.uid === uid) {
      // it's a details page cache (i.e. a single resource)
      return updateResource({ existing: data, incoming: payload });
    }
    if (!Array.isArray(data?.items)) {
      // another single resource but not a match
      return data;
    }
    // otherwise it's a list page cache
    return {
      ...data,
      items: data.items.map(resource =>
        updateResource({ existing: resource, incoming: payload })
      )
    };
  });
}

export function useWebSocket({
  enabled,
  group,
  kind,
  params,
  resourceVersion,
  version
}) {
  const queryClient = useQueryClient();
  const [isWebSocketConnected, setWebSocketConnected] = useState(null);
  const webSocketRef = useRef(null);

  useEffect(() => {
    if (enabled === false) {
      return null;
    }

    function handleClose() {
      setWebSocketConnected(false);
    }
    function handleOpen() {
      setWebSocketConnected(true);
    }
    function handleMessage(event) {
      if (event.type !== 'message') {
        return;
      }
      const { type: operation, object: payload } = JSON.parse(event.data);
      switch (operation) {
        case 'ADDED':
          handleCreated({ group, kind, payload, queryClient, version });
          break;
        case 'DELETED':
          handleDeleted({ group, kind, payload, queryClient, version });
          break;
        case 'MODIFIED':
          handleUpdated({ group, kind, payload, queryClient, version });
          break;
        default:
      }
    }

    const url = getKubeAPI({
      group,
      kind,
      version,
      params: { ...params, isWebSocket: true }
    });
    const webSocketURL = new URL(url);
    const queryParams = new URLSearchParams(webSocketURL.search);
    queryParams.set('resourceVersion', resourceVersion);
    webSocketURL.search = queryParams.toString();
    const webSocket = createWebSocket(webSocketURL.toString());
    webSocketRef.current = webSocket;

    webSocket.addEventListener('close', handleClose);
    webSocket.addEventListener('open', handleOpen);
    webSocket.addEventListener('message', handleMessage);

    return () => {
      if (webSocketRef.current) {
        const socket = webSocketRef.current;
        socket.removeEventListener('close', handleClose);
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('message', handleMessage);
        socket.close();
      }
    };
  }, [enabled, group, kind, JSON.stringify(params), version]);

  return { isWebSocketConnected };
}

export function useSelectedNamespace() {
  return useContext(NamespaceContext);
}

// ... 위쪽은 그대로 (readQFromUrl, onTextSearch, applyClientTextFilter 등)

export function useCollection({ group, kind, params, queryConfig, version }) {
  const { disableWebSocket, ...reactQueryConfig } = queryConfig || {};
  const query = useQuery({
    queryKey: [group, version, kind, params].filter(Boolean),
    ...reactQueryConfig
  });

  // ▼ 텍스트 검색 상태 (그대로)
  const [textQuery, setTextQuery] = useState(readQFromUrl());
  useEffect(() => onTextSearch(setTextQuery), []);

  // ▼ 원본 리스트 객체/배열 추출
  let listObj = query.data;          // 원본 { items, metadata, ... } 일 수도, undefined 일 수도
  let items = [];
  let resourceVersion;

  if (listObj?.items && Array.isArray(listObj.items)) {
    resourceVersion = listObj.metadata?.resourceVersion;
    items = listObj.items;
  }

  // ▼ 필터 적용
  const applyFilter = !!textQuery && shouldApplyTextFilter({ group, kind });
  const filteredData = applyFilter ? applyClientTextFilter(items, textQuery) : items;

  // ▼ WebSocket 유지 (그대로)
  const { isWebSocketConnected } = useWebSocket({
    enabled:
      !disableWebSocket &&
      queryConfig?.enabled !== false &&
      query.isSuccess &&
      !!resourceVersion,
    group,
    kind,
    params,
    resourceVersion,
    version
  });

  // ✅ 호환 레이어: data를 배열처럼 쓰는 코드와 data.items로 쓰는 코드 둘 다 지원
  // - 배열 메서드(map, length 등)는 그대로 동작
  // - data.items 접근 시에도 필터된 배열을 반환
  // - data.metadata 접근 시에는 원본의 metadata를 그대로 노출
  const dataProxy = new Proxy(filteredData, {
    get(target, prop) {
      if (prop === 'items') return filteredData;                 // query.data.items를 쓰는 코드 호환
      if (prop === 'metadata') return listObj?.metadata;         // metadata 접근 호환
      return Reflect.get(target, prop);
    },
    // 선택: 배열 스프레드/열거 호환성 향상
    has(target, prop) {
      return prop === 'items' || prop === 'metadata' || prop in target;
    }
  });

  // 🔁 객체 형태로 data를 기대하는 코드도 있을 수 있으니, 원본 객체가 있었다면 items만 패치한 사본도 함께 노출
  const dataObject =
    listObj && typeof listObj === 'object'
      ? { ...listObj, items: filteredData }
      : { items: filteredData };

  return {
    ...query,
    // 가장 흔한 패턴: data를 '배열'로 사용 (map 등)
    data: dataProxy,
    // 혹시 객체 형태가 필요한 경우 선택적으로 접근 가능 (기존 listObj와 동일 shape, 단 items만 필터됨)
    dataObject,
    isWebSocketConnected
  };
}


export function useResource({
  group,
  kind,
  params,
  queryConfig = {},
  version
}) {
  const { disableWebSocket, ...reactQueryConfig } = queryConfig;
  const query = useQuery({
    queryKey: [group, version, kind, params].filter(Boolean),
    ...reactQueryConfig
  });

  let resourceVersion;
  if (query.data?.metadata) {
    resourceVersion = query.data.metadata.resourceVersion;
  }
  const { isWebSocketConnected } = useWebSocket({
    enabled:
      !disableWebSocket &&
      queryConfig?.enabled !== false &&
      query.isSuccess &&
      !!resourceVersion,
    group,
    kind,
    params,
    resourceVersion,
    version
  });
  return { ...query, isWebSocketConnected };
}

export function isLogTimestampsEnabled() {
  return localStorage.getItem('tkn-logs-timestamps') === 'true';
}

export function setLogTimestampsEnabled(enabled) {
  localStorage.setItem('tkn-logs-timestamps', enabled);
}

export function getLogLevels() {
  let logLevels = localStorage.getItem('tkn-logs-levels');
  if (logLevels) {
    try {
      logLevels = JSON.parse(logLevels);
    } catch (e) {
      // we'll fallback to a default config below
      logLevels = null;
    }
  }

  if (!logLevels) {
    logLevels = {
      error: true,
      warning: true,
      info: true,
      notice: true,
      debug: false
    };
  }

  return logLevels;
}

export function setLogLevels(levels) {
  localStorage.setItem('tkn-logs-levels', JSON.stringify(levels));
}

export function removeSystemAnnotations(resource) {
  Object.keys(resource.metadata.annotations).forEach(annotation => {
    if (annotation.startsWith('tekton.dev/')) {
      delete resource.metadata.annotations[annotation]; // eslint-disable-line no-param-reassign
    }
  });

  delete resource.metadata.annotations[ // eslint-disable-line no-param-reassign
    'kubectl.kubernetes.io/last-applied-configuration'
  ];
}

export function removeSystemLabels(resource) {
  Object.keys(resource.metadata.labels).forEach(label => {
    if (label.startsWith('tekton.dev/')) {
      delete resource.metadata.labels[label]; // eslint-disable-line no-param-reassign
    }
  });
}
