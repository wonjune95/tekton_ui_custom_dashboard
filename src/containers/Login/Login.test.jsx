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

import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../../config_frontend/msw';
import { renderWithRouter } from '../../utils/test';
import Login from './Login';

const notLoggedIn = () =>
  server.use(
    http.get(/\/auth\/me$/, () =>
      HttpResponse.json({ oidcName: 'Gitea' }, { status: 401 })
    )
  );

function stubLocation(assign) {
  vi.stubGlobal('location', { ...window.location, assign });
}

describe('Login', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('links to the provider login and keeps the return path', async () => {
    notLoggedIn();
    const { findByText } = renderWithRouter(<Login />, {
      path: '/login',
      route: '/login?return=%2F%23%2Fpipelineruns'
    });
    const button = await findByText(/log in via gitea/i);
    expect(button.closest('a').getAttribute('href')).toBe(
      '/auth/login?return=%2F%23%2Fpipelineruns'
    );
  });

  it('still offers the login when the provider name is unavailable', async () => {
    server.use(http.get(/\/auth\/me$/, () => HttpResponse.error()));
    const { findByText } = renderWithRouter(<Login />, {
      path: '/login',
      route: '/login'
    });
    await findByText(/log in via oidc/i);
  });

  it('shows why the last login failed', async () => {
    notLoggedIn();
    const { findByText } = renderWithRouter(<Login />, {
      path: '/login',
      route: '/login?error=invalid_state'
    });
    await findByText(/invalid_state/);
  });

  it('leaves the page when a session already exists', async () => {
    server.use(
      http.get(/\/auth\/me$/, () =>
        HttpResponse.json({ user: 'alice', groups: [] })
      )
    );
    const assign = vi.fn();
    renderWithRouter(<Login />, {
      path: '/login',
      route: '/login?return=%2F%23%2Fpipelineruns'
    });
    // after render: the router and the /auth/me request use the real location
    stubLocation(assign);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/#/pipelineruns'));
  });

  it('leaves the page when login is disabled', async () => {
    server.use(
      http.get(/\/auth\/me$/, () => new HttpResponse(null, { status: 404 }))
    );
    const assign = vi.fn();
    renderWithRouter(<Login />, {
      path: '/login',
      route: '/login?return=%2F%23%2Fpipelineruns'
    });
    // after render: the router and the /auth/me request use the real location
    stubLocation(assign);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/#/pipelineruns'));
  });

  it('never follows a return path to another origin', async () => {
    server.use(
      http.get(/\/auth\/me$/, () =>
        HttpResponse.json({ user: 'alice', groups: [] })
      )
    );
    const assign = vi.fn();
    renderWithRouter(<Login />, {
      path: '/login',
      route: `/login?return=${encodeURIComponent('//evil.example')}`
    });
    // after render: the router and the /auth/me request use the real location
    stubLocation(assign);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });
});
