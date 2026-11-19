/*
Copyright 2026 The Tekton Authors
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

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIntl } from 'react-intl';
import { Button, ButtonSkeleton, InlineNotification } from '@carbon/react';
import { ArrowRight } from '@carbon/react/icons';

import { getAPIRoot } from '../../api/comms';
import tektonLogo from '../../images/tekton-stacked-color.svg';

// Same rule as the backend: a same-origin path, never `//host`. Browsers drop
// tab/newline and read `\` as `/`, so reject control chars, spaces and `\`.
function safeReturn(path) {
  return path?.startsWith('/') &&
    !path.startsWith('//') &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x20\x7f\\]/.test(path)
    ? path
    : '/';
}

// Decorative pipeline graph for the brand panel
function PipelinePattern() {
  const nodes = [
    [40, 60],
    [140, 60],
    [240, 30],
    [240, 90],
    [340, 60],
    [440, 60],
    [140, 170],
    [240, 170],
    [340, 140],
    [340, 200],
    [440, 170]
  ];
  const edges = [
    [0, 1],
    [1, 2],
    [1, 3],
    [2, 4],
    [3, 4],
    [4, 5],
    [6, 7],
    [7, 8],
    [7, 9],
    [8, 10],
    [9, 10]
  ];
  const highlighted = new Set([0, 1, 2, 4, 6, 7]);
  return (
    <svg
      aria-hidden="true"
      className="tkn--login-pattern"
      focusable="false"
      viewBox="0 0 480 230"
    >
      {edges.map(([from, to]) => (
        <line
          key={`${from}-${to}`}
          x1={nodes[from][0]}
          x2={nodes[to][0]}
          y1={nodes[from][1]}
          y2={nodes[to][1]}
        />
      ))}
      {nodes.map(([cx, cy], index) => (
        <circle
          className={highlighted.has(index) ? 'tkn--login-node-done' : ''}
          cx={cx}
          cy={cy}
          key={`${cx}-${cy}`}
          r="9"
        />
      ))}
    </svg>
  );
}

export default function Login() {
  const intl = useIntl();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturn(searchParams.get('return'));
  const error = searchParams.get('error');
  const [oidcName, setOidcName] = useState(null);

  useEffect(() => {
    // Plain fetch on purpose: checkStatus would send a 401 straight back here
    fetch(`${getAPIRoot({ isDashboardAPI: true })}/auth/me`, {
      credentials: 'same-origin'
    })
      .then(async response => {
        // 200: already logged in, 404: login disabled (no --oidc-issuer)
        if (response.ok || response.status === 404) {
          window.location.assign(returnTo);
          return;
        }
        const body = await response.json().catch(() => ({}));
        setOidcName(body.oidcName || 'OIDC');
      })
      .catch(() => setOidcName('OIDC'));
  }, [returnTo]);

  return (
    <main className="tkn--login">
      <section className="tkn--login-brand">
        <img alt="Tekton" className="tkn--login-logo" src={tektonLogo} />
        <p className="tkn--login-tagline">
          {intl.formatMessage({
            id: 'dashboard.login.tagline',
            defaultMessage: 'Pipelines, runs and logs in one place'
          })}
        </p>
        <PipelinePattern />
      </section>
      <section className="tkn--login-panel">
        <div className="tkn--login-form">
          <h1>Tekton Dashboard</h1>
          <p className="tkn--login-subtitle">
            {intl.formatMessage({
              id: 'dashboard.login.subtitle',
              defaultMessage: 'Sign in to continue'
            })}
          </p>
          {error && (
            <InlineNotification
              hideCloseButton
              kind="error"
              lowContrast
              subtitle={error}
              title={intl.formatMessage({
                id: 'dashboard.login.error',
                defaultMessage: 'Login failed'
              })}
            />
          )}
          {oidcName ? (
            <Button
              className="tkn--login-button"
              href={`/auth/login?return=${encodeURIComponent(returnTo)}`}
              renderIcon={ArrowRight}
              size="lg"
            >
              {intl.formatMessage(
                {
                  id: 'dashboard.login.button',
                  defaultMessage: 'Log in via {provider}'
                },
                { provider: oidcName }
              )}
            </Button>
          ) : (
            <ButtonSkeleton className="tkn--login-button" size="lg" />
          )}
          <p className="tkn--login-helper">
            {intl.formatMessage(
              {
                id: 'dashboard.login.helper',
                defaultMessage:
                  'You will sign in with your organization account on {provider} and come back here.'
              },
              { provider: oidcName || 'SSO' }
            )}
          </p>
        </div>
      </section>
    </main>
  );
}
