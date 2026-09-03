/*
Copyright 2019-2026 The Tekton Authors
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

/* ===== 전역 텍스트 검색 (LabelFilter -> useCollection) ===== */

// LabelFilter가 쏘는 전역 이벤트 구독
function onTextSearch(callback) {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const handler = e => callback((e?.detail?.q || '').trim());
  window.addEventListener('tkn:textSearch', handler);
  return () => window.removeEventListener('tkn:textSearch', handler);
}

// 이름을 하이픈/언더스코어/점/슬래시로 분해 + 공백제거 버전까지 인덱싱
function tokenizeName(s = '') {
  const lower = String(s).toLowerCase();
  return {
    lower,
    parts: lower.split(/[-._/]+/g).filter(Boolean), // ['sample','dev','deploy','pr']
    joined: lower.replace(/[-._/]+/g, '') // 'sampledevdeploypr'
  };
}

// 이름 + 네임스페이스만 확인, 공백으로 나눈 토큰은 AND 매칭
export function applyClientTextFilter(items, q) {
  const query = (q || '').trim().toLowerCase();
  if (!query || !Array.isArray(items)) {
    return items;
  }

  const tokens = query.split(/\s+/).filter(Boolean);

  return items.filter(item => {
    const { name, namespace } = item?.metadata || {};
    const nameIdx = tokenizeName(name);
    const nsIdx = tokenizeName(namespace);

    return tokens.every(
      token =>
        nameIdx.lower.includes(token) ||
        nameIdx.joined.includes(token) ||
        nameIdx.parts.some(part => part.includes(token)) ||
        nsIdx.lower.includes(token)
    );
  });
}

// 확장메뉴(dashboard.tekton.dev) 데이터는 건드리지 않고 Pipelines / Triggers 계열만 필터
function shouldApplyTextFilter({ group }) {
  return group === tektonAPIGroup || group === triggersAPIGroup;
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

export const NamespaceContext = createContext();
NamespaceContext.displayName = 'Namespace';

function getResourceVersion(resource) {
  return parseInt(resource.metadata.resourceVersion, 10);
}

function handleCreated({ group, kind, payload: _, queryClient, version }) {
  queryClient.invalidateQueries({ queryKey: [group, version, kind] });
}

function handleDeleted({ group, kind, payload, queryClient, version }) {
  const {
    metadata: { name, namespace }
  } = payload;
  // remove any matching details page cache
  queryClient.removeQueries({
    queryKey: [group, version, kind, { name, ...(namespace && { namespace }) }]
  });
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
      return undefined;
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

  const [textQuery, setTextQuery] = useState('');
  useEffect(() => onTextSearch(setTextQuery), []);

  let data = [];
  let resourceVersion;
  if (query.data?.items) {
    resourceVersion = query.data.metadata.resourceVersion;
    data = query.data.items;
  }

  if (textQuery && shouldApplyTextFilter({ group })) {
    data = applyClientTextFilter(data, textQuery);
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
  return { ...query, data, isWebSocketConnected };
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
    } catch (_error) {
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
      debug: false,
      trace: false
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
      delete resource.metadata.annotations[annotation];
    }
  });

  delete resource.metadata.annotations[
    'kubectl.kubernetes.io/last-applied-configuration'
  ];
}

export function removeSystemLabels(resource) {
  Object.keys(resource.metadata.labels).forEach(label => {
    if (label.startsWith('tekton.dev/')) {
      delete resource.metadata.labels[label];
    }
  });
}
