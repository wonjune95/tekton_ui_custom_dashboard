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
import { Button, InlineNotification, Tile } from '@carbon/react';

import { getAPIRoot } from '../../api/comms';

// Same rule as the backend: only same-origin paths, never `//host` or `/\host`
function safeReturn(path) {
  return path?.startsWith('/') && !/^\/[/\\]/.test(path) ? path : '/';
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
        if (response.ok) {
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
      <Tile className="tkn--login-tile">
        <h1>Tekton Dashboard</h1>
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
        {oidcName && (
          <Button href={`/auth/login?return=${encodeURIComponent(returnTo)}`}>
            {intl.formatMessage(
              {
                id: 'dashboard.login.button',
                defaultMessage: 'Log in via {provider}'
              },
              { provider: oidcName }
            )}
          </Button>
        )}
      </Tile>
    </main>
  );
}
